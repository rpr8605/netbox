// control-plane/src/schema.js
// PostgreSQL schema for the Beacon Relay control plane.
// Single source of truth for table definitions; loaded by src/db.js on startup.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  device_id      TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('quarantine','active','revoked')),
  cert_serial    TEXT,
  cert_not_after TEXT,
  device_key_fp  TEXT,
  enrolled_at    TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_replacements (
  old_device_id TEXT NOT NULL REFERENCES devices(device_id),
  new_device_id TEXT NOT NULL REFERENCES devices(device_id),
  site_id       TEXT NOT NULL,
  reason        TEXT,
  replaced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (old_device_id, new_device_id)
);

CREATE TABLE IF NOT EXISTS sites (
  site_id     TEXT PRIMARY KEY,
  name        TEXT,
  lat         REAL,
  lng         REAL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  token_hash  TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  site_id     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS retrust_challenges (
  challenge_hash TEXT PRIMARY KEY,
  device_id      TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(device_id),
  site_id     TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  kind        TEXT NOT NULL,
  service     TEXT,
  tier        TEXT,
  status      TEXT,
  latency_ms  INTEGER,
  confidence  TEXT,
  freshness_s INTEGER,
  phi_mode    INTEGER NOT NULL DEFAULT 0,
  channel_id  TEXT,
  payload     TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_device_time ON events(device_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS channels (
  channel_id          TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  engine              TEXT NOT NULL,
  site_id             TEXT,
  source_system       TEXT,
  destination_system  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id    TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT
);
CREATE OR REPLACE FUNCTION raise_audit_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION raise_audit_append_only();
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION raise_audit_append_only();

CREATE TABLE IF NOT EXISTS alert_rules (
  rule_id      TEXT PRIMARY KEY,
  severity     TEXT NOT NULL CHECK (severity IN ('P1','P2','P3')),
  service      TEXT NOT NULL,
  impact_stmt  TEXT NOT NULL,
  runbook_url  TEXT,
  ack_window_s INTEGER NOT NULL DEFAULT 300,
  maintenance_start TIMESTAMPTZ,
  maintenance_end   TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS alert_contacts (
  contact_id  TEXT PRIMARY KEY,
  severity    TEXT NOT NULL,
  tier        INTEGER NOT NULL,
  channel     TEXT NOT NULL,
  address     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  alert_id    TEXT PRIMARY KEY,
  rule_id     TEXT NOT NULL REFERENCES alert_rules(rule_id),
  device_id   TEXT NOT NULL,
  site_id     TEXT NOT NULL,
  severity    TEXT NOT NULL,
  impact_stmt TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acked','escalated','resolved','closed')),
  ack_deadline TIMESTAMPTZ NOT NULL,
  acked_by    TEXT,
  acked_at    TIMESTAMPTZ,
  current_tier INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  escalated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS incident_signatures (
  signature_id    TEXT PRIMARY KEY,
  alert_id        TEXT NOT NULL UNIQUE REFERENCES alerts(alert_id),
  site_id         TEXT NOT NULL,
  service         TEXT NOT NULL,
  tier_at_failure TEXT,
  status_transition TEXT,
  vendor          TEXT,
  interface_engine TEXT,
  co_occurring_signals TEXT NOT NULL DEFAULT '[]',
  time_of_day_bucket TEXT NOT NULL,
  opened_at       TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS resolution_records (
  record_id       TEXT PRIMARY KEY,
  alert_id        TEXT NOT NULL UNIQUE REFERENCES alerts(alert_id),
  root_cause_category TEXT NOT NULL,
  root_cause_note TEXT,
  action_taken    TEXT NOT NULL,
  time_to_resolve_min INTEGER,
  closed_by       TEXT NOT NULL,
  closed_at       TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS rollouts (
  rollout_id  TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  stage       TEXT NOT NULL CHECK (stage IN ('dev','test','pilot','broad')),
  percentage  INTEGER NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  active      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS action_registry (
  action_id     TEXT NOT NULL,
  site_id       TEXT NOT NULL,
  requires_role TEXT NOT NULL,
  requires_session INTEGER NOT NULL DEFAULT 1,
  max_scope     TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (action_id, site_id)
);

CREATE TABLE IF NOT EXISTS support_sessions (
  session_id  TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  action_id   TEXT,
  opened_at   TIMESTAMPTZ,
  closed_at   TIMESTAMPTZ,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','open','closed','expired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS revoked_serials (
  serial      TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(device_id),
  source      TEXT NOT NULL,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
