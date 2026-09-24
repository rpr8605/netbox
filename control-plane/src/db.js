// control-plane/src/db.js
// Responsibility: persistence for the device registry, enrollment tokens,
// and ingested events. PostgreSQL-only (docs/specs/BEACON_RELAY_BUILD_SPEC.md §5).
// The public API is async so callers do not need to know the driver.
// Called by: src/index.js at startup; src/routes/*.js for all reads/writes.
import crypto from 'node:crypto';
import pg from 'pg';
import { canonicalSerial } from './ca.js';
import { SCHEMA } from './schema.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

let pgPool = null;

// Backward-compat: tests that need direct driver access can destructure `db`.
// It is a live binding that becomes the Pool once the first query triggers
// initialization, so module imports that never call a DB function do not need
// a live Postgres connection.
export let db = null;

async function ensurePool() {
  if (pgPool) return pgPool;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required (SQLite support removed in SQLITE-1/M6)');
  }
  pgPool = new Pool({ connectionString: DATABASE_URL });
  // Ensure all timestamp parsing/emitting is deterministic in UTC, matching the
  // ISO-8601 strings the JS layer already produces.
  pgPool.on('connect', (client) => {
    client.query('SET TIME ZONE \'UTC\'');
  });
  db = pgPool;

  // Serialize schema creation so parallel test processes (node --test) do not
  // race on CREATE TABLE IF NOT EXISTS, which can raise 23505 even with IF NOT
  // EXISTS. The advisory lock is released automatically when the transaction
  // commits (pg_advisory_xact_lock).
  const SCHEMA_LOCK_ID = 123456789;
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
    await client.query(SCHEMA);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* rollback may fail if no tx */ }
    throw err;
  } finally {
    client.release();
  }
  return pgPool;
}

async function query(sql, params = []) {
  const pool = await ensurePool();
  const res = await pool.query(sql, params);
  return res;
}

async function run(sql, params = []) {
  const res = await query(sql, params);
  return { changes: res.rowCount };
}

async function get(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0];
}

async function all(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

// ---------------------------------------------------------------------------
// Device registry
// ---------------------------------------------------------------------------

export async function createEnrollmentToken({ tokenHash, deviceId, siteId, expiresAt }) {
  await run(
    `INSERT INTO enrollment_tokens (token_hash, device_id, site_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [tokenHash, deviceId, siteId, expiresAt]
  );
}

export async function consumeEnrollmentToken(tokenHash) {
  // Atomic consumption: one UPDATE ... RETURNING statement. No SELECT-then-UPDATE
  // race window (M3).
  const res = await query(
    `UPDATE enrollment_tokens
     SET used_at = NOW()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING *`,
    [tokenHash]
  );
  return res.rows[0] ?? null;
}

export async function upsertDevice({ deviceId, siteId, state, certSerial, certNotAfter }) {
  await query(
    `INSERT INTO devices (device_id, site_id, state, cert_serial, cert_not_after, enrolled_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT(device_id) DO UPDATE SET
       state = EXCLUDED.state,
       cert_serial = EXCLUDED.cert_serial,
       cert_not_after = EXCLUDED.cert_not_after,
       enrolled_at = COALESCE(devices.enrolled_at, EXCLUDED.enrolled_at)`,
    [deviceId, siteId, state, certSerial ?? null, certNotAfter ?? null]
  );
}

export async function getDevice(deviceId) {
  return get(`SELECT * FROM devices WHERE device_id = $1`, [deviceId]);
}

export async function listDevices() {
  return all(`SELECT * FROM devices ORDER BY created_at DESC`);
}

export async function touchDevice(deviceId) {
  await run(`UPDATE devices SET last_seen_at = NOW() WHERE device_id = $1`, [deviceId]);
}

export async function recordCertPresentation(deviceId, serial, notAfter) {
  await run(
    `UPDATE devices SET cert_serial = $1, cert_not_after = $2 WHERE device_id = $3`,
    [canonicalSerial(serial), notAfter, deviceId]
  );
}

export async function recordRevokedSerial(serial, deviceId, source = 'replace') {
  await run(
    `INSERT INTO revoked_serials (serial, device_id, source, revoked_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
    [canonicalSerial(serial), deviceId, source]
  );
}

export async function isSerialRevoked(serial) {
  const row = await get(`SELECT 1 FROM revoked_serials WHERE serial = $1`, [canonicalSerial(serial)]);
  return !!row;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function insertEvent(ev) {
  await run(
    `INSERT INTO events (event_id, device_id, site_id, occurred_at, kind, service, tier,
                         status, latency_ms, confidence, freshness_s, phi_mode, channel_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      ev.event_id, ev.device_id, ev.site_id, ev.occurred_at, ev.kind, ev.service,
      ev.tier_observed ?? null, ev.status, ev.latency_ms ?? null, ev.confidence ?? null,
      ev.freshness_s ?? null, ev.phi_mode ? 1 : 0, ev.channel_id ?? null, JSON.stringify(ev),
    ]
  );
}

export async function listEvents(deviceId, limit = 50) {
  return all(
    `SELECT * FROM events WHERE device_id = $1 ORDER BY occurred_at DESC LIMIT $2`,
    [deviceId, limit]
  );
}

export async function listEventsBySite(siteId, limit = 200) {
  return all(
    `SELECT * FROM events WHERE site_id = $1 ORDER BY occurred_at DESC LIMIT $2`,
    [siteId, limit]
  );
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export async function upsertSite({ siteId, name = null, lat = null, lng = null }) {
  await query(
    `INSERT INTO sites (site_id, name, lat, lng) VALUES ($1, $2, $3, $4)
     ON CONFLICT(site_id) DO UPDATE SET
       name = EXCLUDED.name,
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng`,
    [siteId, name, lat, lng]
  );
}

export async function getSite(siteId) {
  return get(`SELECT * FROM sites WHERE site_id = $1`, [siteId]);
}

export async function listSites() {
  return all(`SELECT * FROM sites ORDER BY created_at DESC`);
}

export async function setDeviceKeyFp(deviceId, fp) {
  await run(
    `UPDATE devices SET device_key_fp = $1 WHERE device_id = $2 AND device_key_fp IS NULL`,
    [fp, deviceId]
  );
}

// ---------------------------------------------------------------------------
// Retrust challenges
// ---------------------------------------------------------------------------

export async function createRetrustChallenge({ challengeHash, deviceId }) {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await run(
    `INSERT INTO retrust_challenges (challenge_hash, device_id, expires_at) VALUES ($1, $2, $3)`,
    [challengeHash, deviceId, expiresAt]
  );
}

export async function consumeRetrustChallenge(challengeHash, deviceId) {
  // Atomic consumption: one UPDATE ... RETURNING statement (M3).
  const res = await query(
    `UPDATE retrust_challenges
     SET used_at = NOW()
     WHERE challenge_hash = $1 AND device_id = $2 AND used_at IS NULL AND expires_at > NOW()
     RETURNING *`,
    [challengeHash, deviceId]
  );
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export async function upsertChannel({ channelId, displayName, engine, siteId = null, sourceSystem = null, destinationSystem = null }) {
  await query(
    `INSERT INTO channels (channel_id, display_name, engine, site_id, source_system, destination_system)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(channel_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       engine = EXCLUDED.engine,
       site_id = EXCLUDED.site_id,
       source_system = EXCLUDED.source_system,
       destination_system = EXCLUDED.destination_system`,
    [channelId, displayName, engine, siteId, sourceSystem, destinationSystem]
  );
}

export async function getChannel(channelId) {
  return get(`SELECT * FROM channels WHERE channel_id = $1`, [channelId]);
}

export async function listChannels() {
  return all(`SELECT * FROM channels ORDER BY created_at DESC`);
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function appendAudit({ auditId, actor, action, target = null, detail = null }) {
  await run(
    `INSERT INTO audit_log (audit_id, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5)`,
    [auditId, actor, action, target, detail]
  );
}

export async function listAudit(limit = 100) {
  return all(
    `SELECT * FROM audit_log ORDER BY occurred_at DESC LIMIT $1`,
    [limit]
  );
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export async function createAlertRule(r) {
  await run(
    `INSERT INTO alert_rules (rule_id, severity, service, impact_stmt, runbook_url, ack_window_s, maintenance_start, maintenance_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      r.rule_id, r.severity, r.service, r.impact_stmt,
      r.runbook_url ?? null, r.ack_window_s ?? 300,
      r.maintenance_start ?? null, r.maintenance_end ?? null,
    ]
  );
}

export async function listAlertRules() {
  return all(`SELECT * FROM alert_rules`);
}

export async function getAlertRule(ruleId) {
  return get(`SELECT * FROM alert_rules WHERE rule_id = $1`, [ruleId]);
}

export async function createAlertContact(c) {
  await run(
    `INSERT INTO alert_contacts (contact_id, severity, tier, channel, address) VALUES ($1, $2, $3, $4, $5)`,
    [c.contact_id, c.severity, c.tier, c.channel, c.address]
  );
}

export async function contactsFor(severity, tier) {
  return all(
    `SELECT * FROM alert_contacts WHERE severity = $1 AND tier = $2 ORDER BY contact_id`,
    [severity, tier]
  );
}

export async function maxTier(severity) {
  const r = await get(
    `SELECT MAX(tier) AS t FROM alert_contacts WHERE severity = $1`,
    [severity]
  );
  return r?.t ?? 0;
}

export async function createAlert(a) {
  await run(
    `INSERT INTO alerts (alert_id, rule_id, device_id, site_id, severity, impact_stmt, status, ack_deadline, current_tier)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, 1)`,
    [a.alert_id, a.rule_id, a.device_id, a.site_id, a.severity, a.impact_stmt, a.ack_deadline]
  );
}

export async function getAlert(alertId) {
  return get(`SELECT * FROM alerts WHERE alert_id = $1`, [alertId]);
}

export async function listAlerts(limit = 100) {
  return all(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT $1`, [limit]);
}

export async function ackAlert(alertId, actor) {
  await run(
    `UPDATE alerts SET status='acked', acked_by=$1, acked_at=NOW() WHERE alert_id=$2 AND status='open'`,
    [actor, alertId]
  );
}

export async function escalateAlert(alertId, newTier) {
  await run(
    `UPDATE alerts SET status='escalated', current_tier=$1, escalated_at=NOW() WHERE alert_id=$2`,
    [newTier, alertId]
  );
}

export async function openUnackedPastDeadline(nowIso) {
  return all(
    `SELECT * FROM alerts WHERE status='open' AND ack_deadline < $1`,
    [nowIso]
  );
}

export async function closeAlert(alertId) {
  await run(`UPDATE alerts SET status='closed' WHERE alert_id=$1`, [alertId]);
}

// ---------------------------------------------------------------------------
// Incident signatures / resolution records
// ---------------------------------------------------------------------------

export async function createIncidentSignature(sig) {
  await run(
    `INSERT INTO incident_signatures (signature_id, alert_id, site_id, service, tier_at_failure,
      status_transition, vendor, interface_engine, co_occurring_signals, time_of_day_bucket, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      sig.signature_id ?? crypto.randomUUID(), sig.alert_id, sig.site_id, sig.service,
      sig.tier_at_failure ?? null, sig.status_transition, sig.vendor ?? null,
      sig.interface_engine ?? null, sig.co_occurring_signals ?? '[]',
      sig.time_of_day_bucket, sig.opened_at,
    ]
  );
}

export async function getIncidentSignature(alertId) {
  return get(`SELECT * FROM incident_signatures WHERE alert_id = $1`, [alertId]);
}

export async function createResolutionRecord(rec) {
  await run(
    `INSERT INTO resolution_records (record_id, alert_id, root_cause_category, root_cause_note,
                                     action_taken, time_to_resolve_min, closed_by, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      rec.record_id ?? crypto.randomUUID(), rec.alert_id, rec.root_cause_category,
      rec.root_cause_note ?? null, rec.action_taken, rec.time_to_resolve_min ?? null,
      rec.closed_by, rec.closed_at,
    ]
  );
}

export async function getResolutionRecord(alertId) {
  return get(`SELECT * FROM resolution_records WHERE alert_id = $1`, [alertId]);
}

export async function allClosedIncidents() {
  return all(
    `SELECT a.alert_id, a.site_id, a.device_id, a.severity, a.created_at,
            s.*, r.root_cause_category, r.root_cause_note, r.action_taken,
            r.time_to_resolve_min, r.closed_by, r.closed_at
     FROM alerts a
     LEFT JOIN incident_signatures s ON s.alert_id = a.alert_id
     LEFT JOIN resolution_records r ON r.alert_id = a.alert_id
     WHERE a.status = 'closed'
     ORDER BY a.created_at DESC`
  );
}

export async function captureIncidentSignature({ alertId, siteId, service, vendor = 'unknown', openedAt }) {
  const events = (await listEventsBySite(siteId, 500)).filter(e => e.kind === 'check_result');
  const byService = new Map();
  for (const ev of events) {
    if (!byService.has(ev.service)) byService.set(ev.service, ev);
  }
  const svcEvents = events.filter(e => e.service === service).sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
  const current = svcEvents[0];
  const previous = svcEvents[1];
  const currentStatus = current ? (JSON.parse(current.payload ?? '{}').status ?? 'unknown') : 'unknown';
  const previousStatus = previous ? (JSON.parse(previous.payload ?? '{}').status ?? 'unknown') : 'unknown';
  const statusTransition = `${previousStatus}->${currentStatus}`;
  const tierAtFailure = current ? (JSON.parse(current.payload ?? '{}').tier_observed ?? null) : null;

  const cooc = [];
  for (const [svc, ev] of byService.entries()) {
    if (svc === service) continue;
    const p = JSON.parse(ev.payload ?? '{}');
    const st = p.status ?? 'unknown';
    if (st === 'degraded' || st === 'down') cooc.push(`${svc}:${st}`);
  }

  const engineRow = await get(
    `SELECT engine FROM channels WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [siteId]
  );
  const interfaceEngine = engineRow?.engine ?? 'none';

  const hour = new Date(openedAt).getHours();
  const bucket = hour >= 6 && hour < 18 ? 'business-hours' : hour >= 18 && hour < 22 ? 'after-hours' : 'overnight';

  await createIncidentSignature({
    signature_id: crypto.randomUUID(),
    alert_id: alertId,
    site_id: siteId,
    service,
    tier_at_failure: tierAtFailure,
    status_transition: statusTransition,
    vendor,
    interface_engine: interfaceEngine,
    co_occurring_signals: JSON.stringify(cooc),
    time_of_day_bucket: bucket,
    opened_at: openedAt,
  });
}

// ---------------------------------------------------------------------------
// OTA staged rollout
// ---------------------------------------------------------------------------

export async function createRollout(r) {
  const id = r.rollout_id ?? crypto.randomUUID();
  await run(
    `INSERT INTO rollouts (rollout_id, version, stage, percentage, active) VALUES ($1, $2, $3, $4, 0)`,
    [id, r.version, r.stage, r.percentage ?? 100]
  );
  return id;
}

export async function listRollouts(limit = 100) {
  return all(`SELECT * FROM rollouts ORDER BY created_at DESC LIMIT $1`, [limit]);
}

export async function getActiveRollout() {
  return get(`SELECT * FROM rollouts WHERE active = 1 ORDER BY updated_at DESC LIMIT 1`);
}

export async function activateRollout(rolloutId) {
  await run(`UPDATE rollouts SET active = 0 WHERE rollout_id != $1`, [rolloutId]);
  const res = await run(
    `UPDATE rollouts SET active = 1, updated_at = NOW() WHERE rollout_id = $1`,
    [rolloutId]
  );
  return res.changes;
}

export async function deleteRollout(rolloutId) {
  const res = await run(
    `DELETE FROM rollouts WHERE rollout_id = $1 AND active = 0`,
    [rolloutId]
  );
  return res.changes;
}

export function deviceInRollout(deviceId, version, percentage) {
  const hash = crypto.createHash('sha256').update(`${deviceId}:${version}`).digest('hex');
  const bucket = parseInt(hash.slice(0, 8), 16) % 100;
  return bucket < percentage;
}

export async function offeredVersion(deviceId, latestVersion) {
  if (!latestVersion) return null;
  const rollout = await getActiveRollout();
  if (!rollout) return latestVersion;
  if (deviceInRollout(deviceId, rollout.version, rollout.percentage)) return rollout.version;
  return null;
}

// ---------------------------------------------------------------------------
// Action registry
// ---------------------------------------------------------------------------

export async function createActionRegistryEntry(e) {
  await run(
    `INSERT INTO action_registry (action_id, site_id, requires_role, requires_session, max_scope, enabled)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [e.action_id, e.site_id, e.requires_role, e.requires_session ?? 1, e.max_scope ?? null]
  );
}

export async function listActionRegistryEntries(siteId) {
  return all(`SELECT * FROM action_registry WHERE site_id = $1 ORDER BY action_id`, [siteId]);
}

export async function getActionRegistryEntry(actionId, siteId) {
  return get(`SELECT * FROM action_registry WHERE action_id = $1 AND site_id = $2`, [actionId, siteId]);
}

export async function setActionRegistryEnabled(actionId, siteId, enabled) {
  const res = await run(
    `UPDATE action_registry SET enabled = $1 WHERE action_id = $2 AND site_id = $3`,
    [enabled ? 1 : 0, actionId, siteId]
  );
  return res.changes;
}

// ---------------------------------------------------------------------------
// Remote support sessions
// ---------------------------------------------------------------------------

export async function createSupportSession(s) {
  await run(
    `INSERT INTO support_sessions (session_id, device_id, requested_by, token_hash, expires_at, action_id, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
    [s.session_id, s.device_id, s.requested_by, s.token_hash, s.expires_at, s.action_id ?? null]
  );
}

export async function getSupportSession(sessionId) {
  return get(`SELECT * FROM support_sessions WHERE session_id = $1`, [sessionId]);
}

export async function openSupportSession(sessionId) {
  await run(
    `UPDATE support_sessions SET state='open', opened_at=NOW() WHERE session_id=$1 AND state='pending'`,
    [sessionId]
  );
}

export async function closeSupportSession(sessionId, state = 'closed') {
  await run(
    `UPDATE support_sessions SET state=$1, closed_at=NOW() WHERE session_id=$2`,
    [state, sessionId]
  );
}

export async function expiredSupportSessions(nowIso) {
  return all(
    `SELECT * FROM support_sessions WHERE state IN ('pending','open') AND expires_at < $1`,
    [nowIso]
  );
}

export async function listPendingSupportSessions(deviceId) {
  return all(
    `SELECT * FROM support_sessions WHERE device_id = $1 AND state = 'pending' AND expires_at > NOW()`,
    [deviceId]
  );
}

// ---------------------------------------------------------------------------
// Device replacement
// ---------------------------------------------------------------------------

export async function replaceDevice({ oldDeviceId, newDeviceId, reason, actor }) {
  const oldDevice = await getDevice(oldDeviceId);
  if (!oldDevice) throw new Error('old device not found');
  let newDevice = await getDevice(newDeviceId);
  if (!newDevice) {
    await upsertDevice({ deviceId: newDeviceId, siteId: oldDevice.site_id, state: 'quarantine' });
    newDevice = await getDevice(newDeviceId);
  }
  if (newDevice.site_id !== oldDevice.site_id) {
    throw new Error('replacement device belongs to a different site');
  }
  await run(`UPDATE devices SET state = 'revoked' WHERE device_id = $1`, [oldDeviceId]);
  await run(
    `INSERT INTO device_replacements (old_device_id, new_device_id, site_id, reason, replaced_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (old_device_id, new_device_id) DO UPDATE SET
       site_id = EXCLUDED.site_id,
       reason = EXCLUDED.reason,
       replaced_at = EXCLUDED.replaced_at`,
    [oldDeviceId, newDeviceId, oldDevice.site_id, reason ?? null]
  );
  await appendAudit({
    auditId: crypto.randomUUID(),
    actor: actor ?? 'system',
    action: 'device.replaced',
    target: oldDeviceId,
    detail: JSON.stringify({ old_device_id: oldDeviceId, new_device_id: newDeviceId, site_id: oldDevice.site_id, reason: reason ?? '' }),
  });
  return {
    old_device_id: oldDeviceId,
    new_device_id: newDeviceId,
    site_id: oldDevice.site_id,
    old_state: 'revoked',
    new_state: newDevice.state,
  };
}
