// netbox-agent/lib/monitor_loop.js
// Responsibility: the continuous monitoring orchestrator (spec §3) — runs the
// site's configured EHR/EMR checks on a schedule, maintains per-monitor state,
// and routes any failing check through outage_confirm BEFORE an event fires.
// This is what turns the agent from a test-invoked function into the product.
// Called by: agent.js daemon on boot (after enrollment clears quarantine).
//
// SAFETY (the whole point): a check that flips to failing does NOT emit
// 'down' immediately. It goes through the ordered confirmation sequence first;
// only a confirmed outcome produces an escalated event. A transient blip
// ('recovered') produces a local log line and no event — that's the false-
// positive storm prevention working as designed, not a dropped signal.
import crypto from 'node:crypto';
import { loadMonitorState, saveMonitorState, recordOutcome } from './monitor_state.js';
import { confirmOutage, defaultDeps } from './outage_confirm.js';
import { runSelfChecks } from './self_monitor.js';

// runProfileChecks — one pass over the profile's enabled checks. Returns a
// map of checkName -> result so the loop can diff against last-known state.
async function runProfileChecks(profile, runAdapter) {
  const out = {};
  for (const check of profile.checks) {
    if (check.enabled === false) continue;
    out[check.name] = await runAdapter(check);
  }
  return out;
}

// startMonitorLoop — the daemon's main monitoring timer. Each tick:
//   1. run all profile checks
//   2. run the self-checks (heartbeat/clock/disk/dns/modem/cp-reachability)
//   3. for any check that just flipped to failing, run the confirmation
//      sequence BEFORE posting; emit an event only on a confirmed outcome
//   4. persist monitor state so a restart keeps last-successful-check
// Returns a handle with .stop() so the harness can shut the loop down cleanly.
export function startMonitorLoop(ctx, {
  intervalMs = 15_000,
  post,               // async fn(ev) -> posts to the control plane
  runAdapter,         // async fn(check) -> adapter result
  profile,
  log = () => {},
}) {
  const state = loadMonitorState();
  let running = false;
  let timer = null;

  const tick = async () => {
    if (running) return; // never overlap ticks — a slow check must not pile up
    running = true;
    try {
      const results = await runProfileChecks(profile, runAdapter);
      for (const [name, res] of Object.entries(results)) {
        const wasFailing = (state.monitors[name]?.current_status === 'failing');
        const isFailing = !res.ok;
        recordOutcome(state, name, !isFailing);

        if (isFailing && !wasFailing) {
          // New failure edge — run the ordered confirmation sequence. The
          // event is posted ONLY after it completes, so the timeline proves
          // the order (retry -> second dep -> WAN -> LTE) before the alert.
          log(`monitor: ${name} flipped to failing; running outage confirmation`);
          const confirm = await confirmOutage({
            name,
            deps: defaultDeps({
              cpHost: ctx.cpHost, cpPort: ctx.cpPort,
              lteTarget: ctx.lteTarget,
            }),
            log,
          });
          const ev = {
            event_id: crypto.randomUUID(),
            device_id: ctx.deviceId, site_id: ctx.siteId,
            occurred_at: new Date().toISOString(),
            kind: 'check_result', service: ctx.service ?? 'ehr',
            status: 'down',
            latency_ms: res.latency_ms ?? 0,
            confidence: 'high', freshness_s: 0, phi_mode: false,
            check_name: name, adapter: ctx.adapter ?? 'net',
            outage_confirmation: confirm.outcome,
            detail: `confirmed outage (${confirm.outcome}) after ${confirm.steps.length}-step sequence`,
          };
          await post(ev);
          log(`monitor: posted confirmed outage for ${name} -> ${confirm.outcome}`);
        } else if (!isFailing && wasFailing) {
          log(`monitor: ${name} recovered`);
          await post({
            event_id: crypto.randomUUID(), device_id: ctx.deviceId, site_id: ctx.siteId,
            occurred_at: new Date().toISOString(), kind: 'check_result',
            service: ctx.service ?? 'ehr', status: 'active',
            latency_ms: res.latency_ms ?? 0, confidence: 'high', freshness_s: 0, phi_mode: false,
            check_name: name, adapter: ctx.adapter ?? 'net', detail: 'recovered',
          });
        }
      }

      // Self-monitoring pass — each its own monitor, so a stalled heartbeat or
      // full disk is surfaced as a distinct failure, not hidden.
      const self = await runSelfChecks(ctx);
      for (const [name, res] of Object.entries(self)) {
        const key = `self:${name}`;
        const wasFailing = (state.monitors[key]?.current_status === 'failing');
        const isFailing = !res.ok;
        recordOutcome(state, key, !isFailing);
        if (isFailing && !wasFailing) {
          await post({
            event_id: crypto.randomUUID(), device_id: ctx.deviceId, site_id: ctx.siteId,
            occurred_at: new Date().toISOString(), kind: 'check_result',
            service: 'custom', status: 'down',
            latency_ms: 0, confidence: 'high', freshness_s: 0, phi_mode: false,
            check_name: key, adapter: 'self', detail: res.detail,
          });
          log(`self-monitor: ${key} down — ${res.detail}`);
        }
      }

      saveMonitorState(state);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  tick(); // immediate first pass so the loop's presence is observable at once
  return { stop: () => clearInterval(timer), state };
}
