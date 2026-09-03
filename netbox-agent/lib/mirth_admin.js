// netbox-agent/lib/mirth_admin.js
// Responsibility: Mirth Connect / NextGen Connect admin-API reader — adapter
// #4 of the EHR/EMR layer (EHR spec §2.4, §4; picked first among interface
// engines deliberately because Mirth is the only engine a critical-access
// hospital's budget can absorb). It logs in, reads per-channel connector
// status, and logs out.
//
// SAFETY: only status metadata is ever read — /api/channels, /api/channels/{id}
// /status, session endpoints. The /messages* endpoints are NEVER called:
// channel/connector STATE is legitimate signal; message CONTENT is out of
// scope let alone PHI-adjacent, per spec §4 metadata-only-by-default and §8
// read-only guardrails. Do not add message routes to "improve" this adapter.
//
// Failure semantics: a session/auth failure reports 'unknown' (config deficit,
// like the FHIR adapter), transport down reports 'down', and MIXED channel
// states (some up, some stopped/errored) report 'degraded' — that distinction
// is the entire operational value of this adapter over a raw ping.
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

// Fetch every channel's summary + connector states. Channel list/status on
// purpose: STOPPED/STARTED plus per-connector CONNECTED/IDLE/ERROR is real,
// safely-shareable operational signal (no payload). Normalizes heterogeneous
// Mirth versions under one shape the orchestrator can reason about.
export async function mirthChannelStates(base, cookie) {
  const list = await httpJson('GET', `${base}/channels`, { headers: { cookie } });
  if (list.status !== 200 || !Array.isArray(list.json)) {
    return { error: `channel list failed (HTTP ${list.status || 'no-answer'})` };
  }
  const channels = [];
  for (const ch of list.json) {
    const st = await httpJson('GET', `${base}/channels/${ch.id}/status`, { headers: { cookie } });
    const s = st.json ?? {};
    channels.push({
      id: ch.id,
      name: ch.name ?? null,
      state: s.state ?? 'UNKNOWN',
      connectors: (s.connectorStatuses ?? []).map(c => ({ name: c.name ?? null, state: c.state ?? 'UNKNOWN' })),
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
             channels: states.channels.map(c => ({ name: c.name, state: c.state, connectors: c.connectors })),
             channel_name: states.channels[0]?.name ?? null,
           } };
}
