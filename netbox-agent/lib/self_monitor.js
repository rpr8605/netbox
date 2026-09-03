// netbox-agent/lib/self_monitor.js
// Responsibility: the agent monitors ITSELF, not just the network (spec §3 —
// "a monitor that's silently stopped working is worse than no monitor"). Each
// self-check is its own monitor with its own last-success tracking, so a
// single silent failure (e.g. heartbeat stalled) is surfaced as a distinct
// down state, not hidden inside a generic "agent alive" bit.
// Monitors: heartbeat, clock sync, disk space, DNS resolution, cellular modem,
// control-plane reachability.
// Called by: monitor_loop.js on the self-check cadence.
import fs from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import { execSync } from 'node:child_process';

// Each monitor returns { ok, detail } — never throws, so one broken probe
// can't take down the whole self-check pass (that IS the failure mode the
// spec is warning about).
function safe(name, fn) {
  try { return fn(); } catch (e) { return { ok: false, detail: `${name} threw: ${e.message}` }; }
}

// Heartbeat is "did the last heartbeat POST land" — checked via the timestamp
// the daemon records after each successful POST. A stale timestamp here means
// the heartbeat emitter itself has silently stopped.
export function checkHeartbeat({ lastHeartbeatOkAt, maxAgeMs = 30_000 }) {
  return safe('heartbeat', () => {
    if (!lastHeartbeatOkAt) return { ok: false, detail: 'no successful heartbeat yet' };
    const age = Date.now() - lastHeartbeatOkAt;
    return age <= maxAgeMs
      ? { ok: true, detail: `last heartbeat ${Math.round(age / 1000)}s ago` }
      : { ok: false, detail: `heartbeat silent for ${Math.round(age / 1000)}s (> ${Math.round(maxAgeMs / 1000)}s)` };
  });
}

// Clock sync: compare local time to an NTP reference where available, else
// flag the drift risk. Rural sites can't be assumed to have reliable NTP, so
// a large skew is a real outage precursor (TLS cert windows break first).
export function checkClock({ maxSkewMs = 120_000, referenceMs } = {}) {
  return safe('clock', () => {
    // Reference may be injected (tests); on device it comes from the last CP
    // heartbeat response's server_time, which is the drift source that matters.
    if (referenceMs == null) return { ok: true, detail: 'no reference; skew unmeasured' };
    const skew = Math.abs(Date.now() - referenceMs);
    return skew <= maxSkewMs
      ? { ok: true, detail: `clock skew ${Math.round(skew / 1000)}s` }
      : { ok: false, detail: `clock skew ${Math.round(skew / 1000)}s exceeds ${Math.round(maxSkewMs / 1000)}s` };
  });
}

// Disk space on /data (the writable partition that holds the downtime cache
// and the TLS material — filling it kills the agent's ability to persist).
export function checkDisk({ path = '/data', minFreeBytes = 50 * 1024 * 1024 } = {}) {
  return safe('disk', () => {
    const st = fs.statfsSync(path);
    const free = st.bavail * st.bsize;
    return free >= minFreeBytes
      ? { ok: true, detail: `${Math.round(free / 1024 / 1024)}MB free on ${path}` }
      : { ok: false, detail: `only ${Math.round(free / 1024 / 1024)}MB free on ${path}` };
  });
}

// DNS resolution of the control-plane hostname — a resolver that stops
// resolving is an early-warning signal distinct from the CP itself being down.
export function checkDns({ hostname }) {
  return new Promise(resolve => {
    dns.lookup(hostname, (err, addr) => {
      if (err) resolve({ ok: false, detail: `DNS lookup failed for ${hostname}: ${err.code ?? err.message}` });
      else resolve({ ok: true, detail: `${hostname} -> ${addr}` });
    });
  });
}

// Cellular modem presence/health. No modem is a VALID answer on a wired-only
// site — reported as ok:true with detail, so "no LTE hardware" never pages.
export function checkModem({ requireModem = false } = {}) {
  return safe('modem', () => {
    // Harness/sim: no modem device. Real hardware: mmcli would answer here.
    const present = fs.existsSync('/dev/cdc-wdm0') || fs.existsSync('/dev/ttyUSB2');
    if (!present) {
      return requireModem
        ? { ok: false, detail: 'modem expected but not present' }
        : { ok: true, detail: 'no cellular modem (wired-only site)' };
    }
    return { ok: true, detail: 'modem device present' };
  });
}

// Control-plane reachability over the WAN path — the plain TCP connect that
// the outage-confirmation sequence reuses as its step-3 probe.
export function checkControlPlane({ host, port }) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(2500);
    s.once('connect', () => { s.destroy(); resolve({ ok: true, detail: `cp reachable at ${host}:${port}` }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, detail: 'cp connect timeout' }); });
    s.once('error', e => resolve({ ok: false, detail: `cp unreachable: ${e.code ?? e.message}` }));
    s.connect(port, host);
  });
}

// Run all self-checks and return a name->result map. Async where a check is
// I/O-bound; the set is small so this stays a Promise.all over the monitors.
export async function runSelfChecks(ctx) {
  const [dnsR, cpR] = await Promise.all([
    checkDns({ hostname: ctx.cpHost }),
    checkControlPlane({ host: ctx.cpHost, port: ctx.cpPort }),
  ]);
  return {
    heartbeat: checkHeartbeat(ctx),
    clock: checkClock(ctx),
    disk: checkDisk(ctx),
    dns: dnsR,
    modem: checkModem(ctx),
    control_plane: cpR,
  };
}
