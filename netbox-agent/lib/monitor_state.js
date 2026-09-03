// netbox-agent/lib/monitor_state.js
// Responsibility: per-monitor state — last successful check, current status,
// consecutive failure count — persisted to /data so a daemon restart doesn't
// lose "how long has this been down" (the Fleet Console freshness story
// depends on it). Called by: monitor_loop.js (every check cycle).
// /data is the writable LUKS partition; root is read-only (spec §2), so state
// must NOT live anywhere else on the image.
import fs from 'node:fs';
import path from 'node:path';

// State lives on the writable LUKS partition by default. The path is
// env-overridable so the host-side test harness never writes to a drive root.
// Read fresh per call (not captured at import) so tests can repoint it.
function statePath() { return process.env.NETBOX_STATE_PATH || '/data/monitor_state.json'; }

// Load persisted monitor state. Corrupt/missing state is a first-boot
// condition, not a crash — return an empty map and let the loop rebuild it.
export function loadMonitorState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); }
  catch { return { monitors: {} }; }
}

// Persist the whole state map. Write-then-rename so a power cut mid-write
// can't leave a torn JSON file the next boot trips over.
export function saveMonitorState(state) {
  const p = statePath();
  const tmp = p + '.tmp';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, p);
}

// Record one check outcome. Returns the updated entry so the caller can
// read consecutive_failures / last_success_at without re-touching the map.
export function recordOutcome(state, name, ok) {
  const m = state.monitors[name] ?? { consecutive_failures: 0, last_success_at: null, current_status: 'unknown' };
  if (ok) {
    m.consecutive_failures = 0;
    m.last_success_at = new Date().toISOString();
    m.current_status = 'ok';
  } else {
    m.consecutive_failures += 1;
    m.current_status = 'failing';
  }
  state.monitors[name] = m;
  return m;
}
