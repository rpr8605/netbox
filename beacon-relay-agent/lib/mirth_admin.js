// beacon-relay-agent/lib/mirth_admin.js
// Responsibility: Mirth Connect / NextGen Connect admin-API reader — adapter
// #4 of the EHR/EMR layer (docs/specs/BEACON_RELAY_EHR_INTEGRATIONS.md §2.4, §4; picked first among interface
// engines deliberately because Mirth is the only engine a critical-access
// hospital's budget can absorb). It logs in, reads per-channel connector
// status, and logs out.
//
// SAFETY: only status metadata is ever read — /api/channels, /api/channels/{id}
// /status, session endpoints, and /channels/{id}/messages with
// `includeContent=false`. The messages call requests only timestamps and status
// values; it never fetches message bodies, identifiers, or PHI-adjacent content.
// This single metadata-only exception exists because the Fleet Console detail
// panel needs last-message time and recent error count (docs/specs/BEACON_RELAY_EHR_INTEGRATIONS.md §11), and
// those values are not present in the status or statistics endpoints.
//
// Failure semantics: a session/auth failure reports 'unknown' (config deficit,
// transport down reports 'down', and MIXED channel states (some up, some stopped/errored)
// report 'degraded' — that distinction is the entire operational value of this adapter over a raw ping.
// Called by: ehr_check.js check dispatch.
import { httpJson } from './http_json.js';
import { tcpCheck, tlsCheck, hostPortFromUrl } from './net_checks.js';

// Mirth session login (Basic -> JSESSIONID cookie). Returns the cookie or
// { error } so the caller can map bad credentials to 'unknown'. Mirth emits
// JSON when Accept: application/json, which this module always sends via
// http_json.
export async function mirthLogin(base, { username, password }) {
  const res = await httpJson('POST', `${base}/sessions`, {
    headers: { authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') },
  });
  if (res.status === 0) return { error: 'admin endpoint unreachable' };
  if (res.status === 401 || res.status === 403) return { error: 'credentials rejected' };
  const cookie = res.headers?.['set-cookie']?.[0] ?? null;
  if (!cookie) return { error: `no session cookie (HTTP ${res.status})` };
  return { cookie: cookie.split(';')[0] };
}

// Logout — deliberately always attempted after the reads: a polling reader
// must not accumulate admin sessions on a hospital's interface engine.
export async function mirthLogout(base, cookie) {
  await httpJson('DELETE', `${base}/sessions/current`, { headers: { cookie } });
}

// Metadata-only message summary: timestamps and statuses only, no bodies.
// `includeContent=false` is mandatory here. `windowMinutes` defines "recent" for
// the error count (default 15 min), matching the topology detail panel's need.
//
// ALLOWLIST, not blocklist: even if a misbehaving Mirth instance returns message
// content despite `includeContent=false`, we only read the two fields below and
// deliberately drop everything else. The returned object contains no raw message
// fields, identifiers, or PHI-adjacent data.
function pickMessageMeta(msg) {
  const ts = msg?.receivedDate ?? msg?.dateCreated ?? msg?.createdDate ?? msg?.originalDate ?? null;
  const n = ts ? Date.parse(String(ts)) : NaN;
  return {
    timestamp: Number.isFinite(n) ? n : null,
    status: msg?.status ?? null,
  };
}

// mirthChannelMessagesSummary — metadata-only read of recent message timestamps
// and statuses for one Mirth channel. Uses `includeContent=false` and an explicit
// allowlist so no message bodies, identifiers, or other PHI-adjacent fields can
// leak through even if the server ignores the flag. Returns
// { last_message_time, recent_error_count }.
export async function mirthChannelMessagesSummary(base, cookie, channelId, windowMinutes = 15) {
  const url = `${base}/channels/${channelId}/messages?limit=100&includeContent=false`;
  const res = await httpJson('GET', url, { headers: { cookie } });
  if (res.status !== 200 || !Array.isArray(res.json)) {
    return { last_message_time: null, recent_error_count: null };
  }
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  let lastMessageTime = null;
  let recentErrors = 0;
  for (const raw of res.json) {
    const msg = pickMessageMeta(raw);
    if (msg.timestamp != null) {
      if (lastMessageTime == null || msg.timestamp > lastMessageTime) lastMessageTime = msg.timestamp;
      if (msg.timestamp >= cutoff && String(msg.status).toUpperCase() === 'ERROR') recentErrors += 1;
    }
  }
  return {
    last_message_time: lastMessageTime ? new Date(lastMessageTime).toISOString() : null,
    recent_error_count: recentErrors,
  };
}

// Fetch every channel's summary + connector states. Channel list/status on
// purpose: STOPPED/STARTED plus per-connector CONNECTED/IDLE/ERROR is real,
// safely-shareable operational signal (no payload). Normalizes heterogeneous
// Mirth versions under one shape the orchestrator can reason about.
//
// source_system/destination_system come from channel metadata when the admin
// API exposes them (some NextGen builds include them; otherwise a caller can
// derive them from connector names). These two fields are what turns a flat
// channel list into a graph edge list for the Fleet Console topology view.
export async function mirthChannelStates(base, cookie) {
  const list = await httpJson('GET', `${base}/channels`, { headers: { cookie } });
  if (list.status !== 200 || !Array.isArray(list.json)) {
    return { error: `channel list failed (HTTP ${list.status || 'no-answer'})` };
  }
  const channels = [];
  for (const ch of list.json) {
    const st = await httpJson('GET', `${base}/channels/${ch.id}/status`, { headers: { cookie } });
    const s = st.json ?? {};
    const msgSummary = await mirthChannelMessagesSummary(base, cookie, ch.id);
    channels.push({
      id: ch.id,
      name: ch.name ?? null,
      source_system: ch.source_system ?? null,
      destination_system: ch.destination_system ?? null,
      state: s.state ?? 'UNKNOWN',
      connectors: (s.connectorStatuses ?? []).map(c => ({ name: c.name ?? null, state: c.state ?? 'UNKNOWN' })),
      last_message_time: msgSummary.last_message_time,
      recent_error_count: msgSummary.recent_error_count,
    });
  }
  return { channels };
}

// runMirthCheck — net preamble (L1/L2) then admin/JSON session + channel
// states. Mapping (mirrored in ehr_check.js comments):
//   admin unreachable                 -> 'down'
//   session/credentials rejected      -> 'unknown' (config deficit)
//   all channels STARTED + connectors CONNECTED -> 'active'
//   any channel STOPPED or connector !CONNECTED -> 'degraded'
//   zero channels configured          -> 'degraded' (engine up but nothing routed —
//                                        genuinely degraded for an interface engine)
export async function runMirthCheck(spec) {
  const started = Date.now();
  const base = spec.base_url.replace(/\/+$/, '');
  const { host, port, isHttps } = hostPortFromUrl(base);

  const l1 = await tcpCheck(host, port);
  if (!l1.ok) {
    return { ok: false, tier: null, status: 'down', latency_ms: Date.now() - started,
             detail: `Mirth admin ${host}:${port} unreachable`, observed: { l1: 'fail' } };
  }
  let tier = 'L1';
  if (isHttps) {
    const l2 = await tlsCheck(host, port);
    if (!l2.ok) {
      return { ok: false, tier: 'L1', status: 'degraded', latency_ms: Date.now() - started,
               detail: `TLS unhealthy at ${host}:${port} (${l2.detail ?? 'handshake failed'})`,
               observed: { l1: 'ok', l2: 'fail' } };
    }
    tier = 'L2';
  }

  const login = await mirthLogin(base, { username: spec.username ?? '', password: spec.password ?? '' });
  if (login.error) {
    return { ok: false, tier, status: 'unknown', latency_ms: Date.now() - started,
             detail: `Mirth session/login failure — config deficit (${login.error})`,
             observed: { l1: 'ok', l2: isHttps ? 'ok' : 'n/a' } };
  }
  const states = await mirthChannelStates(base, login.cookie);
  await mirthLogout(base, login.cookie);
  if (states.error) {
    return { ok: false, tier, status: 'unknown', latency_ms: Date.now() - started,
             detail: `Mirth channel read failure (${states.error})`, observed: { l1: 'ok', l2: 'ok' } };
  }
  const bad = [];
  for (const ch of states.channels) {
    if (ch.state !== 'STARTED') { bad.push(`${ch.name}:${ch.state}`); continue; }
    for (const c of ch.connectors) {
      if (c.state !== 'CONNECTED' && c.state !== 'IDLE') bad.push(`${ch.name}/${c.name}:${c.state}`);
    }
  }
  const degraded = states.channels.length === 0 || bad.length > 0;
  const status = degraded ? 'degraded' : 'active';
  const detail = degraded
    ? (states.channels.length === 0
        ? 'Mirth reachable; no channels deployed — nothing being routed'
        : `Mirth degraded: ${bad.join(', ')}`)
    : `Mirth ok: ${states.channels.length} channel(s), all STARTED + connectors live`;
  return { ok: !degraded, tier: 'L3', status, latency_ms: Date.now() - started,
           detail, observed: {
             channels: states.channels.map(c => ({
               name: c.name,
               state: c.state,
               connectors: c.connectors,
               last_message_time: c.last_message_time,
               recent_error_count: c.recent_error_count,
             })),
             channel_name: states.channels[0]?.name ?? null,
           } };
}
