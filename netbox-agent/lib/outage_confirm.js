// netbox-agent/lib/outage_confirm.js
// Responsibility: the multi-step outage-confirmation sequence (spec §3 —
// "retry locally, check a second independent dependency, validate the primary
// WAN path, then fail over to LTE specifically to confirm whether it's a
// local outage or the control plane itself that's unreachable"). This is the
// difference between one accurate alert and twenty false ones.
// Called by: monitor_loop.js when a check flips to a failing state.
//
// SAFETY (do not collapse): the sequence must run its steps IN ORDER and to
// completion BEFORE any escalated event fires. An event posted after step 1
// alone is exactly the false-positive storm this exists to prevent.
import { execSync } from 'node:child_process';
import net from 'node:net';

// One bounded TCP connect — used for the WAN/LTE path probes. Returns a plain
// result, never throws: a dead path is an answer, not an exception.
function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.once('connect', () => { s.destroy(); resolve({ ok: true }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, detail: 'timeout' }); });
    s.once('error', e => resolve({ ok: false, detail: String(e.code ?? e.message ?? e) }));
    s.connect(port, host);
  });
}

// confirmOutage — run the ordered confirmation sequence for a failing check.
//   steps (logged to `log` with elapsed time so the order is observable):
//     1. local retry of the failing check (up to `retries` times)
//     2. a second INDEPENDENT dependency (another monitor's recent result or a
//        quick probe) — distinguishes "this service" from "this whole box"
//     3. primary WAN path validation (TCP to the control-plane host)
//     4. LTE failover probe — the WAN-vs-LTE split is what classifies a local
//        outage from a control-plane/WAN outage
// Returns { outcome, steps[], confirmed } — outcome is one of:
//   'recovered'           (a retry succeeded; transient blip)
//   'confirmed-local'     (dependency dead, WAN+LTE alive => site-side outage)
//   'confirmed-wan-down'  (WAN dead, LTE alive => primary ISP, not the site)
//   'confirmed-cp-down'   (WAN+LTE dead => control plane itself unreachable)
// `deps` is injected for testability: { retryCheck, secondDependency, wanPath, ltePath }.
export async function confirmOutage({ name, retries = 2, retryDelayMs = 1000, deps, log = () => {} }) {
  const started = Date.now();
  const steps = [];
  const stamp = (step, ok, detail = '') => {
    const el = Date.now() - started;
    steps.push({ step, ok, elapsed_ms: el, detail });
    log(`outage-confirm[${name}] step=${step} ok=${ok} +${el}ms${detail ? ' ' + detail : ''}`);
  };

  // Step 1 — local retry. A single retry is a blip filter, not confirmation.
  for (let i = 1; i <= retries; i++) {
    const r = await deps.retryCheck();
    stamp(`retry-local-${i}`, !!r?.ok, r?.detail ?? '');
    if (r?.ok) return { outcome: 'recovered', confirmed: false, steps };
    if (i < retries) await new Promise(r => setTimeout(r, retryDelayMs));
  }

  // Step 2 — second independent dependency. If THIS also fails, suspicion
  // shifts from the service to the box/path.
  const dep2 = await deps.secondDependency();
  stamp('second-dependency', !!dep2?.ok, dep2?.detail ?? '');

  // Step 3 — primary WAN path to the control plane.
  const wan = await deps.wanPath();
  stamp('primary-wan-path', !!wan?.ok, wan?.detail ?? '');

  // Step 4 — LTE failover. The classifier: WAN-down + LTE-up means the primary
  // ISP is the fault, not the site; both down means the control plane itself.
  const lte = await deps.ltePath();
  stamp('lte-failover', !!lte?.ok, lte?.detail ?? '');

  const wanAlive = !!wan?.ok, lteAlive = !!lte?.ok, dep2Alive = !!dep2?.ok;
  let outcome;
  if (!dep2Alive && !wanAlive && !lteAlive) outcome = 'confirmed-cp-down';
  else if (!wanAlive && lteAlive) outcome = 'confirmed-wan-down';
  else outcome = 'confirmed-local';
  stamp('classified', true, outcome);
  return { outcome, confirmed: true, steps };
}

// Default probes for the real device. LTE is a distinct interface probe —
// on hardware it binds the modem interface; in the harness it's a second
// loopback target. Kept injectable so the E2E can show the full sequence.
export function defaultDeps({ cpHost, cpPort, lteTarget }) {
  return {
    retryCheck: async () => ({ ok: false, detail: 'no retryCheck wired' }),
    secondDependency: async () => ({ ok: false, detail: 'no secondDependency wired' }),
    wanPath: () => tcpProbe(cpHost, cpPort),
    ltePath: () => lteTarget ? tcpProbe(lteTarget.host, lteTarget.port) : Promise.resolve({ ok: false, detail: 'no LTE interface configured' }),
  };
}
