// beacon-relay-agent/lib/site_controls.js
// Responsibility: read-only site-level network/endpoint-health checks that are
// too vendor-specific to live in the generic net_checks module but are still
// intentionally shallow — we report what the hospital's own controller/software
// already exposes, we do not install or manage it.
//
// Covered services (all metadata-only, phi_mode:false):
//   - wireless_ap_health: poll an enterprise Wi-Fi controller's status API.
//   - vpn_tunnel_health: read a local tunnel status file + reachability probe
//     to a known endpoint on the far side of the tunnel.
//   - backup_dr_status: read a backup/DR completion status source (log file or
//     vendor status endpoint) and report last success / last failure.
//   - av_edr_checkin: read an AV/EDR agent status source and report last
//     check-in plus definition/datetime freshness.
//
// DESIGN: each exported function is shaped like the other EHR/EMR adapters so
// ehr_check.js can dispatch to them without knowing service semantics. All four
// share one small `readStatusSource` helper; service-specific interpretation lives
// in a per-service `interpret*` function. Mocks are accepted via `opts.mockData`
// so unit tests never need real controllers or agents.
import fs from 'node:fs';
import { httpJson } from './http_json.js';
import { tcpCheck } from './net_checks.js';

const DEFAULT_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Shared status-source reader. A source is either an http(s) URL or a local
// file path. Returns a normalized { ok, data, latency_ms, error } shape.
// ---------------------------------------------------------------------------
async function readStatusSource(params = {}) {
  if (params.mockData != null) return { ok: true, data: params.mockData, latency_ms: 0, error: null };

  const source = params.source;
  const timeoutMs = params.timeout_ms || DEFAULT_TIMEOUT_MS;

  if (!source) {
    return { ok: false, data: null, latency_ms: 0, error: 'status source not configured' };
  }

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const headers = {};
    if (params.auth_token) headers.authorization = `Bearer ${params.auth_token}`;
    const res = await httpJson('GET', source, { headers, timeoutMs });
    if (res.status === 0 || res.status >= 400) {
      return { ok: false, data: null, latency_ms: res.latency_ms, error: `HTTP ${res.status}: ${res.text ?? 'no response'}` };
    }
    return { ok: true, data: res.json ?? res.text, latency_ms: res.latency_ms, error: null };
  }

  // Treat anything else as a local file path.
  const started = Date.now();
  try {
    const raw = fs.readFileSync(source, 'utf8');
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    return { ok: true, data, latency_ms: Date.now() - started, error: null };
  } catch (e) {
    return { ok: false, data: null, latency_ms: Date.now() - started, error: `file read failed: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Wireless AP health
// ---------------------------------------------------------------------------
function findApList(data) {
  if (!data) return null;
  const candidates = ['aps', 'accessPoints', 'access_points', 'devices'];
  for (const key of candidates) {
    if (Array.isArray(data[key])) return data[key];
    if (data.data && Array.isArray(data.data[key])) return data.data[key];
  }
  if (Array.isArray(data)) return data;
  return null;
}

function apStatus(item) {
  const val = item.status ?? item.state ?? item.operState ?? item.oper_status;
  return String(val ?? 'unknown').toLowerCase();
}

function apClientCount(item) {
  const c = item.clientCount ?? item.clients ?? item.num_sta ?? item.client_count ?? item.client_count_2_4 ?? item.station_count;
  const n = Number(c);
  return Number.isFinite(n) ? n : 0;
}

function interpretWireless(data, latencyMs, source) {
  const aps = findApList(data);
  if (!Array.isArray(aps) || aps.length === 0) {
    return { status: 'down', detail: 'AP controller returned no access points', observed: { controller_reachable: true, source }, latency_ms: latencyMs };
  }
  const healthyStates = new Set(['up', 'connected', 'ok', 'active', 'online', 'provisioned']);
  let downCount = 0;
  let totalClients = 0;
  const names = [];
  for (const ap of aps) {
    const st = apStatus(ap);
    const name = ap.name ?? ap.ap_name ?? ap.mac ?? ap.serial ?? 'unknown';
    if (names.length < 5) names.push(name);
    if (!healthyStates.has(st)) downCount += 1;
    totalClients += apClientCount(ap);
  }
  const observed = {
    ap_count: aps.length,
    down_ap_count: downCount,
    total_clients: totalClients,
    names_sample: names,
    controller_reachable: true,
    source,
  };
  if (downCount === aps.length) {
    return { status: 'down', detail: `all ${aps.length} AP(s) reported down`, observed, latency_ms: latencyMs };
  }
  if (downCount > 0) {
    return { status: 'degraded', detail: `${downCount} of ${aps.length} AP(s) down`, observed, latency_ms: latencyMs };
  }
  return { status: 'verified_ready', detail: `all ${aps.length} AP(s) up, ${totalClients} client(s)`, observed, latency_ms: latencyMs };
}

// runWirelessApCheck — read-only wireless AP health.
// Params: controller_url or source (http(s) URL or file path), optional auth_token,
//         optional mockData for tests.
// Returns: { status, detail, observed, latency_ms }.
export async function runWirelessApCheck(params = {}) {
  const controllerUrl = params.controller_url;
  if (!params.mockData && !controllerUrl && !params.source) {
    return { status: 'unknown', detail: 'Wireless AP controller URL not configured', observed: {}, latency_ms: 0 };
  }

  // Allow the generic `source` field to stand in for controller_url.
  const effectiveParams = { ...params, source: params.source ?? controllerUrl };
  const read = await readStatusSource(effectiveParams);
  if (!read.ok) {
    const reason = read.error === 'status source not configured' ? 'unknown' : 'down';
    return { status: reason, detail: `AP controller unreachable — ${read.error}`, observed: { controller_reachable: false }, latency_ms: read.latency_ms };
  }
  return interpretWireless(read.data, read.latency_ms, controllerUrl ?? effectiveParams.source);
}

// ---------------------------------------------------------------------------
// Site-to-site VPN tunnel health
// ---------------------------------------------------------------------------
function interpretVpn(data, latencyMs) {
  const interfaceUp = data?.interface_up === true || /true|up|ok/i.test(String(data?.interface_up ?? ''));
  const remoteReachable = data?.remote_reachable === true || /true|up|ok/i.test(String(data?.remote_reachable ?? ''));
  const remoteEndpoint = data?.remote_endpoint ?? data?.peer ?? null;
  const observed = { interface_up: interfaceUp, remote_reachable: remoteReachable, remote_endpoint: remoteEndpoint };

  if (!interfaceUp) {
    return { status: 'down', detail: 'VPN tunnel interface is down', observed, latency_ms: latencyMs };
  }
  if (!remoteReachable) {
    return { status: 'degraded', detail: 'VPN tunnel interface up but far-side endpoint unreachable', observed, latency_ms: latencyMs };
  }
  return { status: 'verified_ready', detail: 'VPN tunnel interface up and far-side endpoint reachable', observed, latency_ms: latencyMs };
}

// runVpnTunnelCheck — read-only site-to-site VPN tunnel health.
// Params: status_file_path and/or remote_host + remote_port; optional mockData.
// Returns: { status, detail, observed, latency_ms }.
export async function runVpnTunnelCheck(params = {}) {
  const statusFile = params.status_file_path;
  const remoteHost = params.remote_host;
  const remotePort = Number(params.remote_port) || 0;

  if (!params.mockData && !statusFile && !(remoteHost && remotePort)) {
    return { status: 'unknown', detail: 'VPN tunnel status source or remote endpoint not configured', observed: {}, latency_ms: 0 };
  }

  if (params.mockData) return interpretVpn(params.mockData, 0);

  // Prefer a status file if configured; it carries the interface-up signal.
  if (statusFile) {
    const read = await readStatusSource({ source: statusFile });
    if (!read.ok) {
      return { status: 'unknown', detail: `VPN status source unreadable — ${read.error}`, observed: {}, latency_ms: read.latency_ms };
    }
    const base = interpretVpn(read.data, read.latency_ms);
    // If a remote endpoint is also configured, probe it and merge the result.
    if (remoteHost && remotePort) {
      const probe = await tcpCheck(remoteHost, remotePort, DEFAULT_TIMEOUT_MS);
      const reachable = probe.ok;
      const observed = { ...base.observed, remote_reachable: reachable, remote_endpoint: `${remoteHost}:${remotePort}` };
      if (!reachable && base.status === 'verified_ready') {
        return { status: 'degraded', detail: 'VPN tunnel reports up but far-side endpoint unreachable', observed, latency_ms: probe.latency_ms };
      }
      if (reachable && base.status === 'down') {
        return { status: 'degraded', detail: 'VPN far-side endpoint reachable but tunnel interface reports down', observed, latency_ms: probe.latency_ms };
      }
      return { ...base, observed, latency_ms: probe.latency_ms };
    }
    return base;
  }

  // No status file: rely purely on reachability to the far-side endpoint.
  const probe = await tcpCheck(remoteHost, remotePort, DEFAULT_TIMEOUT_MS);
  const observed = { interface_up: null, remote_reachable: probe.ok, remote_endpoint: `${remoteHost}:${remotePort}` };
  if (!probe.ok) {
    return { status: 'down', detail: `VPN far-side endpoint unreachable — ${probe.error ?? 'TCP failed'}`, observed, latency_ms: probe.latency_ms };
  }
  return { status: 'verified_ready', detail: 'VPN far-side endpoint reachable', observed, latency_ms: probe.latency_ms };
}

// ---------------------------------------------------------------------------
// Backup / DR job status
// ---------------------------------------------------------------------------
function parseIsoOrTimestamp(v) {
  if (v == null) return null;
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

function interpretBackupDr(data, latencyMs) {
  const rawStatus = data?.status ?? data?.last_status ?? data?.result ?? 'unknown';
  const status = String(rawStatus).toLowerCase();
  const lastSuccess = parseIsoOrTimestamp(data?.last_success ?? data?.last_success_time ?? data?.last_completed);
  const lastRun = parseIsoOrTimestamp(data?.last_run ?? data?.last_run_time ?? lastSuccess);
  const maxAgeHours = data?.max_age_hours ?? 48;
  const now = Date.now();
  const observed = {
    last_status: status,
    last_success: lastSuccess ? new Date(lastSuccess).toISOString() : null,
    last_run: lastRun ? new Date(lastRun).toISOString() : null,
    max_age_hours: maxAgeHours,
  };

  if (['failed', 'error', 'failure'].includes(status)) {
    return { status: 'down', detail: `Backup/DR job reported ${status}`, observed, latency_ms: latencyMs };
  }
  if (['success', 'completed', 'ok'].includes(status)) {
    if (lastSuccess && (now - lastSuccess) > maxAgeHours * 3600e3) {
      const hours = Math.floor((now - lastSuccess) / 3600e3);
      return { status: 'degraded', detail: `Last backup/DR success was ${hours}h ago (> ${maxAgeHours}h)`, observed, latency_ms: latencyMs };
    }
    return { status: 'verified_ready', detail: 'Backup/DR job completed successfully within window', observed, latency_ms: latencyMs };
  }
  if (lastRun && (now - lastRun) > maxAgeHours * 3600e3) {
    return { status: 'degraded', detail: 'No recent Backup/DR job run detected', observed, latency_ms: latencyMs };
  }
  return { status: 'unknown', detail: 'Backup/DR status unclear', observed, latency_ms: latencyMs };
}

// runBackupDrStatusCheck — read-only backup/DR job status.
// Params: source (http(s) URL or file path), optional mockData.
// Returns: { status, detail, observed, latency_ms }.
export async function runBackupDrStatusCheck(params = {}) {
  if (!params.mockData && !params.source) {
    return { status: 'unknown', detail: 'Backup/DR status source not configured', observed: {}, latency_ms: 0 };
  }
  const read = await readStatusSource(params);
  if (!read.ok) {
    return { status: 'down', detail: `Backup/DR status source unreachable — ${read.error}`, observed: {}, latency_ms: read.latency_ms };
  }
  return interpretBackupDr(read.data, read.latency_ms);
}

// ---------------------------------------------------------------------------
// AV / EDR agent check-in
// ---------------------------------------------------------------------------
function interpretAvEdr(data, latencyMs) {
  const lastCheckin = parseIsoOrTimestamp(data?.last_checkin ?? data?.last_check_in ?? data?.last_seen);
  const defsAgeHours = data?.definitions_age_hours ?? data?.signature_age_hours ?? null;
  const rawStatus = data?.status ?? data?.protection_status ?? 'unknown';
  const status = String(rawStatus).toLowerCase();
  const maxCheckinHours = data?.max_checkin_hours ?? 24;
  const maxDefsHours = data?.max_definitions_age_hours ?? 48;
  const now = Date.now();
  const observed = {
    last_checkin: lastCheckin ? new Date(lastCheckin).toISOString() : null,
    definitions_age_hours: defsAgeHours,
    protection_status: status,
    max_checkin_hours: maxCheckinHours,
    max_definitions_age_hours: maxDefsHours,
  };

  if (['disabled', 'off', 'not_active'].includes(status)) {
    return { status: 'down', detail: 'AV/EDR protection is disabled', observed, latency_ms: latencyMs };
  }
  if (lastCheckin && (now - lastCheckin) > maxCheckinHours * 3600e3) {
    const hours = Math.floor((now - lastCheckin) / 3600e3);
    return { status: 'down', detail: `AV/EDR agent check-in stale (${hours}h ago)`, observed, latency_ms: latencyMs };
  }
  if (defsAgeHours != null && defsAgeHours > maxDefsHours) {
    return { status: 'degraded', detail: `AV/EDR definitions are ${defsAgeHours}h old (> ${maxDefsHours}h)`, observed, latency_ms: latencyMs };
  }
  if (['healthy', 'active', 'enabled', 'protected', 'ok'].includes(status) && lastCheckin) {
    return { status: 'verified_ready', detail: 'AV/EDR agent checked in recently and protection is active', observed, latency_ms: latencyMs };
  }
  return { status: 'unknown', detail: 'AV/EDR status unclear', observed, latency_ms: latencyMs };
}

// runAvEdrCheckinCheck — read-only AV/EDR agent check-in status.
// Params: source (http(s) URL or file path), optional mockData.
// Returns: { status, detail, observed, latency_ms }.
export async function runAvEdrCheckinCheck(params = {}) {
  if (!params.mockData && !params.source) {
    return { status: 'unknown', detail: 'AV/EDR status source not configured', observed: {}, latency_ms: 0 };
  }
  const read = await readStatusSource(params);
  if (!read.ok) {
    return { status: 'down', detail: `AV/EDR status source unreachable — ${read.error}`, observed: {}, latency_ms: read.latency_ms };
  }
  return interpretAvEdr(read.data, read.latency_ms);
}
