// netbox-agent/lib/http_json.js
// Responsibility: one tiny JSON-over-HTTP(S) helper shared by the EHR/EMR
// protocol adapters (fhir_r4.js, mirth_admin.js) — POST form token requests,
// GET JSON resources, session login/logout — with a uniform return shape.
// Called by: the EHR adapters only; orchestration lives in ehr_check.js.
//
// IMAGE CONSTRAINT (hard, per agent.js header): the device image ships no npm
// tree for the agent — node:* builtins ONLY. global fetch is deliberately not
// used here: Node's global fetch cannot be given a TLS dispatcher without an
// undici import, and site-local endpoints are routinely self-signed.
//
// TLS POSTURE (deliberate — same stance as post_event.js): rejectUnauthorized
// is disabled at this layer because hospital-local endpoints (Mirth admin on
// :8443, FHIR gateways on private CAs) are overwhelmingly self-signed or
// issued from the site CA the box doesn't carry. What this layer substitutes
// for chain trust: net_checks.tlsCheck records the peer certificate's identity
// + validity window, and the control plane only ever receives the resulting
// status — never any endpoint credential. Hardening to pinned roots (like the
// agent's step-ca bootstrap pin) is a deliberate follow-up, NOT a local toggle.
import http from 'node:http';
import https from 'node:https';

// One HTTP(S) request returning { status, headers, json|text, latency_ms }.
// Never throws on transport failure: a dropped hospital endpoint must surface
// as a status result the orchestrator can map to 'down', not as an exception
// that kills the whole check run — callers still see status:0 with the error.
export async function httpJson(method, urlStr, { headers = {}, body = null, timeoutMs = 5000 } = {}) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const started = Date.now();
  const opts = {
    method,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
      accept: 'application/json',
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...headers,
    },
    rejectUnauthorized: false, // see header comment — deliberate, documented
    timeout: timeoutMs,
  };
  const transport = isHttps ? https : http;
  return new Promise(resolve => {
    const req = transport.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON body */ }
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers ?? {},
          json: parsed,
          text: parsed == null ? data : undefined,
          latency_ms: Date.now() - started,
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, json: null, text: 'timeout', latency_ms: timeoutMs }); });
    req.on('error', e => resolve({ status: 0, headers: {}, json: null, text: String(e.message ?? e), latency_ms: Date.now() - started }));
    if (payload) req.write(payload);
    req.end();
  });
}

// POST an application/x-www-form-urlencoded body (SMART/OAuth token requests)
// and parse the JSON response. Kept separate so token endpoints that demand
// form semantics never get JSON content-type by accident.
export async function postForm(urlStr, params, { headers = {}, timeoutMs = 5000 } = {}) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const form = new URLSearchParams(params).toString();
  const started = Date.now();
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(form),
      accept: 'application/json',
      ...headers,
    },
    rejectUnauthorized: false, // see header comment — deliberate, documented
    timeout: timeoutMs,
  };
  const transport = isHttps ? https : http;
  return new Promise(resolve => {
    const req = transport.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers ?? {}, json: parsed, text: parsed == null ? data : undefined, latency_ms: Date.now() - started });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, json: null, text: 'timeout', latency_ms: timeoutMs }); });
    req.on('error', e => resolve({ status: 0, headers: {}, json: null, text: String(e.message ?? e), latency_ms: Date.now() - started }));
    req.write(form);
    req.end();
  });
}
