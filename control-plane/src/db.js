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

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
  payload     TEXT NOT NULL,             -- full canonical JSON, metadata-only
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_device_time ON events(device_id, occurred_at DESC);
`);

export function createEnrollmentToken({ tokenHash, deviceId, siteId, expiresAt }) {
  db.prepare(
    `INSERT INTO enrollment_tokens (token_hash, device_id, site_id, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(tokenHash, deviceId, siteId, expiresAt);
}

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

export function getDevice(deviceId) {
  return db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get(deviceId);
}

export function listDevices() {
  return db.prepare(`SELECT * FROM devices ORDER BY created_at DESC`).all();
}

export function touchDevice(deviceId) {
  db.prepare(`UPDATE devices SET last_seen_at = datetime('now') WHERE device_id = ?`).run(deviceId);
}

export function recordCertPresentation(deviceId, serial, notAfter) {
  db.prepare(`UPDATE devices SET cert_serial = ?, cert_not_after = ? WHERE device_id = ?`)
    .run(serial, notAfter, deviceId);
}

export function insertEvent(ev) {
  db.prepare(
    `INSERT INTO events (event_id, device_id, site_id, occurred_at, kind, service, tier,
                         status, latency_ms, confidence, freshness_s, phi_mode, payload)
     VALUES (@event_id, @device_id, @site_id, @occurred_at, @kind, @service, @tier_observed,
             @status, @latency_ms, @confidence, @freshness_s, @phi_mode, @payload)`
  ).run({
    ...ev,
    tier_observed: ev.tier_observed ?? null,
    phi_mode: ev.phi_mode ? 1 : 0,
    payload: JSON.stringify(ev),
  });
}

export function listEvents(deviceId, limit = 50) {
  return db.prepare(
    `SELECT * FROM events WHERE device_id = ? ORDER BY occurred_at DESC LIMIT ?`
  ).all(deviceId, limit);
}

export function setDeviceKeyFp(deviceId, fp) {
  // Only pins when unset — the enrollment-time key must never be re-keyed here.
  db.prepare(`UPDATE devices SET device_key_fp = ? WHERE device_id = ? AND device_key_fp IS NULL`)
    .run(fp, deviceId);
}

export function createRetrustChallenge({ challengeHash, deviceId }) {
  const expiresAt = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `INSERT INTO retrust_challenges (challenge_hash, device_id, expires_at) VALUES (?, ?, ?)`
  ).run(challengeHash, deviceId, expiresAt);
}

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
