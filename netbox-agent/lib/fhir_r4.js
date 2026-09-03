// netbox-agent/lib/fhir_r4.js
// Responsibility: FHIR R4 read-only polling client — adapter #2 of the EHR/EMR
// layer (EHR spec §2.2, §7). It does exactly two reads: a capability-statement
// fetch (GET {base}/metadata) and, when the profile scopes one, a single
// synthetic-resource read (e.g. Patient/{synthetic-id}). Enough to prove the
// connection is live and measure latency — never a clinical data pull.
// Called by: ehr_check.js check dispatch.
//
// SAFETY (spec §8 guardrail): the response BODY of the scoped read is never
// stored, logged, or emitted. The event's observed carries resourceType +
// status code only. metadata-only-by-default applies to FHIR exactly as it
// does to HL7v2; do not expand observed to include payload fields.
//
// Auth is SMART on FHIR backend-services in three deployment shapes:
//   none               — open public sandboxes / lab stub endpoints
//   client_credentials — plain OAuth2 client-credentialed token endpoint
//   backend_services   — true SMART backend-services: signed JWT client
//                        assertion (RS384 via node:crypto — the image ships no
//                        npm tree, and jose would be unavailable)
// A token failure maps to status 'unknown', NOT 'down': a missing/expired
// credential grant (e.g. Epic Community Connect without parent-org API access,
// EHR spec §5) is a config-coverage problem, and the console must not page an
// on-call human for it.
import crypto from 'node:crypto';
import { httpJson } from './http_json.js';
import { tcpCheck, tlsCheck, hostPortFromUrl } from './net_checks.js';

// base64urlEncode helper — SMART backend-services JWT assembly without any
// npm dependency (image constraint; see header).
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Build a SMART backend-services client assertion: header {alg:RS384,typ:JWT},
// payload {iss,sub=client_id,aud=token_url,jti,exp}. RS384 (RSA-SHA384) is the
// minimum algorithm SMART/HL7 guidance permits; RS512 would also be fine, but
// RS384 hits the interoperability floor — do not "simplify" to HS algorithms,
// servers reject shared-secret assertions by design.
function buildClientAssertion({ client_id, token_url, private_key }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS384', typ: 'JWT' };
  const payload = {
    iss: client_id,
    sub: client_id,
    aud: token_url,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 300,
  };
  const segments = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // Accepts PEM string OR JWK object — site profiles may carry either.
  const keyObj = typeof private_key === 'string' ? private_key : { format: 'jwk', key: private_key };
  const sig = crypto.sign('RSA-SHA384', segments, keyObj);
  return `${segments}.${b64url(sig)}`;
}

// Obtain an access token per the auth config. Returns { token } or { error } —
// the caller maps error to 'unknown', so a bad credential is never reported
// as a fake outage (see header).
export async function getAccessToken(auth) {
  if (!auth || !auth.method || auth.method === 'none') return { token: null };
  if (auth.method === 'client_credentials') {
    const res = await httpJson('POST', auth.token_url, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: auth.client_id ?? '',
        client_secret: auth.client_secret ?? '',
        scope: auth.scope ?? 'system/*.read',
      }).toString(),
    });
    return res.json?.access_token
      ? { token: res.json.access_token }
      : { error: `token endpoint ${res.status === 0 ? 'unreachable' : 'HTTP ' + res.status}` };
  }
  if (auth.method === 'backend_services') {
    if (!auth.private_key || !auth.client_id || !auth.token_url) {
      return { error: 'backend_services requires client_id, token_url, private_key' };
    }
    const assertion = buildClientAssertion(auth);
    const res = await httpJson('POST', auth.token_url, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        scope: auth.scope ?? 'system/*.read',
      }).toString(),
    });
    return res.json?.access_token
      ? { token: res.json.access_token }
      : { error: `token endpoint ${res.status === 0 ? 'unreachable' : 'HTTP ' + res.status}` };
  }
  return { error: `unsupported auth.method '${auth.method}'` };
}

// runFhirCheck — L1/L2 preamble then L3 = metadata fetch (+ optional scoped
// read). Escalation-to-down only happens when the transport itself fails;
// everything that answers gets a graduated status (see net_checks.runNetCheck
// mapping for the generic twin of this logic).
export async function runFhirCheck(spec) {
  const started = Date.now();
  const base = spec.base_url.replace(/\/+$/, '');
  const { host, port, isHttps } = hostPortFromUrl(base);

  const l1 = await tcpCheck(host, port);
  if (!l1.ok) {
    return { ok: false, tier: null, status: 'down', latency_ms: Date.now() - started,
             detail: `FHIR endpoint ${host}:${port} unreachable`, observed: { l1: 'fail' } };
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

  const tok = await getAccessToken(spec.auth);
  let authHeader = {};
  let tokenError = null;
  if (spec.auth?.method && spec.auth.method !== 'none') {
    if (tok.error) {
      tokenError = tok.error;
    } else {
      authHeader = { authorization: `Bearer ${tok.token}` };
    }
  }

  // L3 gate: capability statement. A 401/missing token is a CONFIG deficit —
  // reported as 'unknown' (never 'down'), per the header's auth rationale.
  const meta = await httpJson('GET', `${base}/metadata`, { headers: authHeader });
  if (spec.auth?.method && spec.auth.method !== 'none' && (tokenError != null || meta.status === 401 || meta.status === 403)) {
    return { ok: false, tier, status: 'unknown', latency_ms: Date.now() - started,
             detail: `auth/token failure — config deficit, not an outage (${tokenError ?? 'HTTP ' + meta.status})`,
             observed: { l1: 'ok', l2: isHttps ? 'ok' : 'n/a', auth_method: spec.auth.method, http_status: meta.status } };
  }
  if (meta.status === 0 || !meta.json || meta.json.resourceType !== 'CapabilityStatement') {
    return { ok: false, tier, status: 'degraded', latency_ms: Date.now() - started,
             detail: `capability statement unreadable (HTTP ${meta.status || 'no-answer'})`,
             observed: { l1: 'ok', l2: isHttps ? 'ok' : 'n/a', http_status: meta.status } };
  }
  tier = 'L3';
  const observed = {
    l1: 'ok', l2: isHttps ? 'ok' : 'n/a',
    fhir_version: meta.json.fhirVersion ?? null,
    resource_read: null,
  };
  let status = 'verified_ready';
  let detail = `FHIR capability statement ok (fhirVersion=${observed.fhir_version ?? '?'})`;

  // Optional single scoped synthetic read — the L3-deepening step the EHR
  // spec's tier table expects for FHIR-capable systems. Body NEVER retained
  // (see SAFETY in header): only status code + resourceType are observed.
  const rr = spec.resource_read;
  if (rr && rr.resource_type && rr.id) {
    const read = await httpJson('GET', `${base}/${rr.resource_type}/${rr.id}`, { headers: authHeader });
    observed.resource_read = { resource_type: rr.resource_type, status_code: read.status };
    if (read.status === 200 && read.json?.resourceType === rr.resource_type) {
      status = 'active';
      detail = `FHIR ok: metadata + ${rr.resource_type}/${rr.id} read (HTTP 200)`;
    } else if (read.status === 404) {
      detail = `FHIR endpoint live; scoped resource ${rr.resource_type}/${rr.id} absent (HTTP 404)`;
    } else {
      status = 'degraded';
      detail = `scoped read ${rr.resource_type}/${rr.id} failed (HTTP ${read.status || 'no-answer'})`;
    }
  }
  return { ok: status !== 'degraded', tier, status, latency_ms: Date.now() - started, detail, observed };
}
