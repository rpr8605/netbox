// control-plane/src/db.js
// Responsibility: SQLite persistence for the device registry, enrollment tokens,
// and ingested events. Phase 1/2 uses SQLite for zero-ops local dev; the schema
// is written so a later migration to PostgreSQL (spec §5) is a driver swap, not
// a data-model change.
// Called by: src/index.js at startup; src/routes/*.js for all reads/writes.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? './data/netbox.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// The single process-wide SQLite handle (WAL + foreign keys on). Every route
// shares this one connection; nothing opens its own.
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Guarded idempotent migration: channel_id rides in a real column since the
// topology work; existing dev volumes that predate the column get an ALTER
// TABLE ADD COLUMN once at startup. Wrapped because an already-migrated DB
// would throw 'duplicate column name'.
try { db.exec(`ALTER TABLE events ADD COLUMN channel_id TEXT;`); } catch { /* already present */ }

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  device_id      TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('quarantine','active','revoked')),
  cert_serial    TEXT,
  cert_not_after TEXT,
  device_key_fp  TEXT,                    -- sha256 of RSA public-key DER, pinned at enrollment
  enrolled_at    TEXT,
  last_seen_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  token_hash  TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  site_id     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS retrust_challenges (
  challenge_hash TEXT PRIMARY KEY,
  device_id      TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(device_id),
  site_id     TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  kind        TEXT NOT NULL,
  service     TEXT,
  tier        TEXT,
  status      TEXT,
  latency_ms  INTEGER,
  confidence  TEXT,
  freshness_s INTEGER,
  phi_mode    INTEGER NOT NULL DEFAULT 0,
  channel_id  TEXT,                      -- optional interface-engine channel tag (topology)
  payload     TEXT NOT NULL,             -- full canonical JSON, metadata-only
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_device_time ON events(device_id, occurred_at DESC);

-- Interface channel registry: the stable, operator-controlled mapping from a
-- channel_id (what the agent tags on check_results) to a display name/engine.
-- Read-only lookups here; writes go through routes/channels.js.
CREATE TABLE IF NOT EXISTS channels (
  channel_id  TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  engine      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only audit log (spec §5): every login, config change, software
-- update, access grant, and remote-support session. The immutability is
-- enforced by the DATABASE, not by policy — there are no UPDATE/DELETE
-- helpers for this table, and a trigger below makes any attempt raise.
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id    TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Alerting / escalation engine state.
CREATE TABLE IF NOT EXISTS alert_rules (
  rule_id      TEXT PRIMARY KEY,
  severity     TEXT NOT NULL CHECK (severity IN ('P1','P2','P3')),
  service      TEXT NOT NULL,
  impact_stmt  TEXT NOT NULL,        -- plain language, never a port/protocol string
  runbook_url  TEXT,
  ack_window_s INTEGER NOT NULL DEFAULT 300,
  maintenance_start TEXT,            -- ISO; when set, alerts in the window are suppressed
  maintenance_end   TEXT
);
CREATE TABLE IF NOT EXISTS alert_contacts (
  contact_id  TEXT PRIMARY KEY,
  severity    TEXT NOT NULL,
  tier        INTEGER NOT NULL,      -- 1 = first paged, 2 = escalated-to, ...
  channel     TEXT NOT NULL,         -- sms | voice | email | slack | teams
  address     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  alert_id    TEXT PRIMARY KEY,
  rule_id     TEXT NOT NULL REFERENCES alert_rules(rule_id),
  device_id   TEXT NOT NULL,
  site_id     TEXT NOT NULL,
  severity    TEXT NOT NULL,
  impact_stmt TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acked','escalated','resolved')),
  ack_deadline TEXT NOT NULL,
  acked_by    TEXT,
  acked_at    TEXT,
  current_tier INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  escalated_at TEXT
);

-- Remote-support session broker (spec §7): outbound-only, JIT token, every
-- session audit-logged. No standing SSH port, no shared credential.
CREATE TABLE IF NOT EXISTS support_sessions (
  session_id  TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  opened_at   TEXT,
  closed_at   TEXT,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','open','closed','expired')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Store a one-time enrollment token by HASH — the plaintext token is handed to
// the operator/device and never persisted, so reading the DB can't mint enrollments.
export function createEnrollmentToken({ tokenHash, deviceId, siteId, expiresAt }) {
  db.prepare(
    `INSERT INTO enrollment_tokens (token_hash, device_id, site_id, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(tokenHash, deviceId, siteId, expiresAt);
}

// Redeem a one-time token: returns the row and burns it iff present, unexpired,
// and unused, else null. Single-use is the enrollment anti-replay guarantee.
export function consumeEnrollmentToken(tokenHash) {
  // Atomic: mark used only if present, unexpired, and unused. Returns the row or null.
  const row = db.prepare(
    `SELECT * FROM enrollment_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`
  ).get(tokenHash);
  if (!row) return null;
  db.prepare(`UPDATE enrollment_tokens SET used_at = datetime('now') WHERE token_hash = ?`)
    .run(tokenHash);
  return row;
}

// Insert or refresh a device's registry row; enrolled_at survives re-upserts
// so re-provisioning can't erase enrollment history.
export function upsertDevice({ deviceId, siteId, state, certSerial, certNotAfter }) {
  db.prepare(
    `INSERT INTO devices (device_id, site_id, state, cert_serial, cert_not_after, enrolled_at)
     VALUES (@deviceId, @siteId, @state, @certSerial, @certNotAfter, datetime('now'))
     ON CONFLICT(device_id) DO UPDATE SET
       state = excluded.state,
       cert_serial = excluded.cert_serial,
       cert_not_after = excluded.cert_not_after,
       enrolled_at = COALESCE(devices.enrolled_at, excluded.enrolled_at)`
  ).run({ deviceId, siteId, state, certSerial, certNotAfter });
}

// Fetch one device row by id; undefined when the device is unknown.
export function getDevice(deviceId) {
  return db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get(deviceId);
}

// Every registered device, newest first — the fleet-console list source.
export function listDevices() {
  return db.prepare(`SELECT * FROM devices ORDER BY created_at DESC`).all();
}

// Stamp last_seen_at on any authenticated contact from the device.
export function touchDevice(deviceId) {
  db.prepare(`UPDATE devices SET last_seen_at = datetime('now') WHERE device_id = ?`).run(deviceId);
}

// Record the serial/expiry of the cert a device just presented — observed
// truth from the TLS handshake, kept distinct from what we issued.
export function recordCertPresentation(deviceId, serial, notAfter) {
  db.prepare(`UPDATE devices SET cert_serial = ?, cert_not_after = ? WHERE device_id = ?`)
    .run(serial, notAfter, deviceId);
}

// Persist one canonical event; the full JSON is kept in payload (metadata-only)
// so audit/replay never depends on column drift. channel_id rides in a real
// column too, for the topology query.
// Persist one canonical event; the full JSON is kept in payload (metadata-only)
// so audit/replay never depends on column drift. channel_id rides in a real
// column too, for the topology query.
export function insertEvent(ev) {
  db.prepare(
    `INSERT INTO events (event_id, device_id, site_id, occurred_at, kind, service, tier,
                         status, latency_ms, confidence, freshness_s, phi_mode, channel_id, payload)
     VALUES (@event_id, @device_id, @site_id, @occurred_at, @kind, @service, @tier_observed,
             @status, @latency_ms, @confidence, @freshness_s, @phi_mode, @channel_id, @payload)`
  ).run({
    ...ev,
    tier_observed: ev.tier_observed ?? null,
    phi_mode: ev.phi_mode ? 1 : 0,
    channel_id: ev.channel_id ?? null,
    payload: JSON.stringify(ev),
  });
}

// Recent events for one device, newest first.
export function listEvents(deviceId, limit = 50) {
  return db.prepare(
    `SELECT * FROM events WHERE device_id = ? ORDER BY occurred_at DESC LIMIT ?`
  ).all(deviceId, limit);
}

// Pin a device's public-key fingerprint at enrollment redeem. The IS-NULL
// guard is deliberate: re-keying must go through re-enrollment, never an UPDATE.
export function setDeviceKeyFp(deviceId, fp) {
  // Only pins when unset — the enrollment-time key must never be re-keyed here.
  db.prepare(`UPDATE devices SET device_key_fp = ? WHERE device_id = ? AND device_key_fp IS NULL`)
    .run(fp, deviceId);
}

// Issue a single-use re-trust challenge with a 60-second TTL.
export function createRetrustChallenge({ challengeHash, deviceId }) {
  const expiresAt = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `INSERT INTO retrust_challenges (challenge_hash, device_id, expires_at) VALUES (?, ?, ?)`
  ).run(challengeHash, deviceId, expiresAt);
}

// Burn a re-trust challenge: returns the row iff it matches this device, is
// unexpired and unused, else null — single-use is the anti-replay guarantee.
export function consumeRetrustChallenge(challengeHash, deviceId) {
  const row = db.prepare(
    `SELECT * FROM retrust_challenges
     WHERE challenge_hash = ? AND device_id = ? AND used_at IS NULL AND expires_at > datetime('now')`
  ).get(challengeHash, deviceId);
  if (!row) return null;
  db.prepare(`UPDATE retrust_challenges SET used_at = datetime('now') WHERE challenge_hash = ?`)
    .run(challengeHash);
  return row;
}

// Events for one site (all devices at the site), newest first — the topology
// view groups by channel_id over this set.
export function listEventsBySite(siteId, limit = 200) {
  return db.prepare(
    `SELECT * FROM events WHERE site_id = ? ORDER BY occurred_at DESC LIMIT ?`
  ).all(siteId, limit);
}

// --- channel registry (topology) -------------------------------------------
// upsertChannel: register (or rename) a channel_id -> readable name/engine.
// Idempotent — re-registering the same id just updates the display fields.
export function upsertChannel({ channelId, displayName, engine }) {
  db.prepare(
    `INSERT INTO channels (channel_id, display_name, engine)
     VALUES (?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       display_name = excluded.display_name,
       engine = excluded.engine`
  ).run(channelId, displayName, engine);
}

// getChannel: look up a channel_id; undefined when unregistered. Unregistered
// ids still work end-to-end — the console shows the raw id with an
// "unregistered" hint rather than failing.
export function getChannel(channelId) {
  return db.prepare(`SELECT * FROM channels WHERE channel_id = ?`).get(channelId);
}

// listChannels: enumerate the registry (console).
export function listChannels() {
  return db.prepare(`SELECT * FROM channels ORDER BY created_at DESC`).all();
}

// --- audit log (append-only) ------------------------------------------------
// appendAudit: the ONLY write path for audit_log. There is intentionally no
// updateAudit/deleteAudit — the triggers in the schema enforce immutability
// at the database level so a caller can't "fix" history even if it wants to.
export function appendAudit({ auditId, actor, action, target = null, detail = null }) {
  db.prepare(
    `INSERT INTO audit_log (audit_id, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`
  ).run(auditId, actor, action, target, detail);
}

// listAudit: read the audit trail, newest first. Read-only by design.
export function listAudit(limit = 100) {
  return db.prepare(`SELECT * FROM audit_log ORDER BY occurred_at DESC LIMIT ?`).all(limit);
}

// --- alert rules / contacts / alerts ----------------------------------------
// createAlertRule: register an alert rule. impact_stmt is validated upstream
// (alerting.js rejects transport jargon); this layer only persists.
export function createAlertRule(r) {
  db.prepare(
    `INSERT INTO alert_rules (rule_id, severity, service, impact_stmt, runbook_url, ack_window_s, maintenance_start, maintenance_end)
     VALUES (@rule_id, @severity, @service, @impact_stmt, @runbook_url, @ack_window_s, @maintenance_start, @maintenance_end)`
  ).run({ runbook_url: null, ack_window_s: 300, maintenance_start: null, maintenance_end: null, ...r });
}
// listAlertRules: all registered alert rules (console + engine).
export function listAlertRules() { return db.prepare(`SELECT * FROM alert_rules`).all(); }
// getAlertRule: one rule by id, undefined when unknown.
export function getAlertRule(ruleId) { return db.prepare(`SELECT * FROM alert_rules WHERE rule_id = ?`).get(ruleId); }

// createAlertContact: add an escalation contact at a severity+tier.
export function createAlertContact(c) {
  db.prepare(`INSERT INTO alert_contacts (contact_id, severity, tier, channel, address) VALUES (?, ?, ?, ?, ?)`)
    .run(c.contact_id, c.severity, c.tier, c.channel, c.address);
}
// contactsFor: the contacts to page for a severity at a given escalation tier.
export function contactsFor(severity, tier) {
  return db.prepare(`SELECT * FROM alert_contacts WHERE severity = ? AND tier = ? ORDER BY contact_id`).all(severity, tier);
}
// maxTier: highest configured tier for a severity (0 = no contacts).
export function maxTier(severity) {
  const r = db.prepare(`SELECT MAX(tier) AS t FROM alert_contacts WHERE severity = ?`).get(severity);
  return r?.t ?? 0;
}

// createAlert: open a new alert with its ack deadline; starts at tier 1.
export function createAlert(a) {
  db.prepare(
    `INSERT INTO alerts (alert_id, rule_id, device_id, site_id, severity, impact_stmt, status, ack_deadline, current_tier)
     VALUES (@alert_id, @rule_id, @device_id, @site_id, @severity, @impact_stmt, 'open', @ack_deadline, 1)`
  ).run(a);
}
// getAlert: one alert by id.
export function getAlert(alertId) { return db.prepare(`SELECT * FROM alerts WHERE alert_id = ?`).get(alertId); }
// listAlerts: recent alerts, newest first.
export function listAlerts(limit = 100) { return db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?`).all(limit); }
// ackAlert: mark an open alert acked by an actor (stops escalation).
export function ackAlert(alertId, actor) {
  db.prepare(`UPDATE alerts SET status='acked', acked_by=?, acked_at=datetime('now') WHERE alert_id=? AND status='open'`)
    .run(actor, alertId);
}
// escalateAlert: move an alert to the next tier and stamp the escalation.
export function escalateAlert(alertId, newTier) {
  db.prepare(`UPDATE alerts SET status='escalated', current_tier=?, escalated_at=datetime('now') WHERE alert_id=?`)
    .run(newTier, alertId);
}
// openUnackedPastDeadline: the escalation sweep's input — open alerts whose
// ack window has lapsed.
export function openUnackedPastDeadline(nowIso) {
  return db.prepare(`SELECT * FROM alerts WHERE status='open' AND ack_deadline < ?`).all(nowIso);
}

// --- remote support sessions ------------------------------------------------
// createSupportSession: register a pending session with its JIT token hash.
export function createSupportSession(s) {
  db.prepare(
    `INSERT INTO support_sessions (session_id, device_id, requested_by, token_hash, expires_at, state)
     VALUES (@session_id, @device_id, @requested_by, @token_hash, @expires_at, 'pending')`
  ).run(s);
}
// getSupportSession: one session by id.
export function getSupportSession(sessionId) {
  return db.prepare(`SELECT * FROM support_sessions WHERE session_id = ?`).get(sessionId);
}
// openSupportSession: flip pending -> open (device picked up its token).
export function openSupportSession(sessionId) {
  db.prepare(`UPDATE support_sessions SET state='open', opened_at=datetime('now') WHERE session_id=? AND state='pending'`).run(sessionId);
}
// closeSupportSession: flip to closed/expired with a timestamp.
export function closeSupportSession(sessionId, state = 'closed') {
  db.prepare(`UPDATE support_sessions SET state=?, closed_at=datetime('now') WHERE session_id=?`).run(state, sessionId);
}
// expiredSupportSessions: the session sweep's input — pending/open past TTL.
export function expiredSupportSessions(nowIso) {
  return db.prepare(`SELECT * FROM support_sessions WHERE state IN ('pending','open') AND expires_at < ?`).all(nowIso);
}
