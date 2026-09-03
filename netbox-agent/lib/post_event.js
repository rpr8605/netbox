// netbox-agent/lib/post_event.js — the one, tiny HTTP bridge the agent uses to
// POST /api/events (canonical schema validated server-side; agent assumes the
// event was already shaped by lib/signal_emit.js or the caller). mTLS comes
// from the same cert the renewal loop maintains; nothing is deliberately
// woven into payload beyond shipping it.
import fs from 'node:fs';
import https from 'node:https';

let _mockPostEvent = null;           // test hook (scripts/test_step1_signals.js)
// Test-only transport override (scripts/test_step1_signals.js). Deliberately
// an explicit function call rather than an env flag, so no production config
// can accidentally route events into the void.
export function setMockPostEvent(fn) { _mockPostEvent = fn; }

// Assemble the mTLS client identity (cert + key) the enrollment/renewal loop
// maintains under /data. Prefers tls_key.pem when present, but NEVER in tests —
// the NODE_ENV guard forces the sim/harness onto device_key.pem so test key
// material is never confused with a device's renewal-managed key. ca stays
// null: Phase 1 authenticates the DEVICE by this client cert; server
// verification is not CA-based yet (see postEvent).
export function mtls() {
  const certPem = fs.readFileSync('/data/device.crt', 'utf8');
  const keyPem = fs.existsSync('/data/tls_key.pem') && process.env.NODE_ENV !== 'test'
    ? fs.readFileSync('/data/tls_key.pem', 'utf8')
    : fs.readFileSync('/data/device_key.pem', 'utf8');
  return { cert: certPem, key: keyPem, ca: null, timeout: 10_000, servername: '' };
}

// POST one already-shaped canonical event to the control plane; the mock
// override (if set) short-circuits all real IO. Throws on non-200/202 ON
// PURPOSE — callers must decide retry-vs-drop explicitly, because a silently
// dropped security signal is indistinguishable from "everything is fine" on
// the dashboard. rejectUnauthorized:false is a deliberate Phase 1 stance: the
// control plane serves a private-CA cert the agent doesn't carry the root for,
// so channel trust rides on the mTLS client cert + a deployment-fixed address.
// Tightening that is a coordinated PKI change, not a local toggle.
export async function postEvent(ev) {
  if (_mockPostEvent) return _mockPostEvent(ev); // mock route overrides real IO
  const u = new URL(process.env.CONTROL_PLANE_URL ?? 'https://10.0.2.2:9100/api/events');
  if (!u.pathname.endsWith('/api/events')) {
    u.pathname = '/api/events';
  }
  const tls = mtls();
  const body = JSON.stringify(ev);
  const res = await new Promise(resolve => {
    const req = https.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      rejectUnauthorized: false,
      ...tls,
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, body: { error: String(e.message ?? e) } }));
    if (body) req.write(body);
    req.end();
  });
  if (![200, 202].includes(res.status)) {
    throw new Error(`events post failed ${res.status}: ${res.body}`);
  }
  return res;
}
