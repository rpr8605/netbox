// device-sim/src/index.js
// Responsibility: simulate one Netbox device through the full Phase 1 flow and
// assert the trust boundaries hold. This file IS the Phase 1 end-to-end test —
// it exits 0 only if every step, including the negative cases, behaves as speced.
//
// Sequence (spec §2 + §8 step 1):
//   happy path:  token -> redeem -> fingerprint pin -> CSR -> step-ca sign ->
//                mTLS heartbeat -> quarantine gate blocks check_result ->
//                operator confirm -> check_result accepted
//   negative 1:  forged enrollment token -> 403, no registry row
//   negative 2:  self-signed client cert -> refused at the mTLS gate
//
// NOTE (flagged, not hidden): key storage here is a plain file under /data —
// the software-key path. TPM sealing (spec §2) cannot be exercised in a
// container and is marked untested-until-hardware in the Phase 1 report.
import forge from 'node-forge';
import { request, Agent } from 'undici';
import crypto from 'node:crypto';
import fs from 'node:fs';

function pubkeyPem(keys) {
  return forge.pki.publicKeyToPem(keys.publicKey);
}
function signPayload(privKeyPem, payload) {
  const key = forge.pki.privateKeyFromPem(privKeyPem);
  const md = forge.md.sha256.create();
  md.update(payload, 'utf8');
  return Buffer.from(key.sign(md), 'binary').toString('base64');
}

const CP = process.env.CONTROL_PLANE_URL ?? 'https://control-plane:9100';
const CA = process.env.CA_URL ?? 'https://step-ca:9000';
// `||` not `??`: compose injects empty strings for unset vars.
const DEVICE_ID = process.env.DEVICE_ID || crypto.randomUUID();
const SITE_ID = process.env.SITE_ID || crypto.randomUUID();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Compose-internal TLS: the control plane's server cert is step-ca-issued and
// not in the container's trust store, so we skip server verification here and
// rely on the CA-fingerprint pin below for the trust decision that matters.
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

async function api(method, path, body, agent = insecure) {
  const res = await request(`${CP}${path}`, {
    method, dispatcher: agent,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.statusCode, body: parsed ?? text };
}

async function waitForControlPlane(attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await api('GET', '/api/health');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('control plane unreachable after retries');
}

function makeCsr(commonName, keys) {
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

function canonicalEvent(kind, overrides = {}) {
  return {
    event_id: crypto.randomUUID(),
    device_id: DEVICE_ID,
    site_id: SITE_ID,
    occurred_at: new Date().toISOString(),
    kind,
    service: 'ehr',
    tier_observed: 'L1',
    status: 'reachable',
    latency_ms: 12,
    confidence: 'high',
    freshness_s: 0,
    phi_mode: false,
    ...overrides,
  };
}

async function main() {
  await waitForControlPlane();
  // ---- happy path -------------------------------------------------------
  // 1. Operator (Configurator stand-in) creates a one-time enrollment token.
  const tok = await api('POST', '/api/enroll/tokens', { device_id: DEVICE_ID, site_id: SITE_ID });
  check('operator issues one-time enrollment token', tok.status === 200 && !!tok.body.enrollment_token,
    `status=${tok.status} body=${JSON.stringify(tok.body)}`);

  // 2. Device generates its own keypair (software path; TPM flagged above).
  const keys = forge.pki.rsa.generateKeyPair(2048);
  fs.mkdirSync('/data', { recursive: true });
  fs.writeFileSync('/data/device_key.pem', forge.pki.privateKeyToPem(keys.privateKey));

  // 3. Redeem token (pinning long-term public key for retrust) -> OTT + fp.
  const deviceKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const redeem = await api('POST', '/api/enroll/redeem', {
    enrollment_token: tok.body.enrollment_token,
    public_key_pem: pubkeyPem(keys),
  });
  check('token redeemed + key pinned (for retrust)', redeem.status === 200 && !!redeem.body.step_ca?.ott);

  // 3b. Token is single-use: replay must fail.
  const replay = await api('POST', '/api/enroll/redeem', { enrollment_token: tok.body.enrollment_token });
  check('token replay refused', replay.status === 403);

  // 4. Pin the CA: fetch roots.pem directly, hash, compare to what the
  //    control plane told us. A MITM'd CA would diverge here.
  // CA endpoints are HTTPS with a not-yet-trusted cert; verification is
  // deliberately skipped here and the fingerprint pin below is the trust check.
  const rootsRes = await request(`${CA}/roots.pem`, { dispatcher: insecure });
  const rootsPem = await rootsRes.body.text();
  const der = Buffer.from(rootsPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, ''), 'base64');
  const fp = crypto.createHash('sha256').update(der).digest('hex');
  check('CA fingerprint pin matches', fp === redeem.body.step_ca.fingerprint, fp.slice(0, 16));

  // 5. CSR -> step-ca sign with the OTT.
  const csr = makeCsr(DEVICE_ID, keys);
  const signRes = await request(`${CA}/1.0/sign`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ csr, ott: redeem.body.step_ca.ott }),
    dispatcher: insecure,
  });
  const signText = await signRes.body.text();
  let signBody = null;
  try { signBody = JSON.parse(signText); } catch { /* keep raw */ }
  const deviceCertPem = signBody?.crt ?? signBody?.cert;
  // step-ca answers 201 Created on /sign (not 200).
  check('step-ca issued device certificate', [200, 201].includes(signRes.statusCode) && !!deviceCertPem,
    `status=${signRes.statusCode} body=${signText.slice(0, 300)}`);

  // 6. mTLS agent with the real device cert, trusting the pinned root.
  //    The device must present leaf + intermediate (step-ca returns the
  //    intermediate as `ca` in the sign response) — the server trusts the
  //    root only, so an unchained leaf fails verification.
  const deviceChain = `${deviceCertPem}\n${signBody.ca ?? ''}`;
  const mtls = new Agent({
    connect: {
      rejectUnauthorized: false, // server identity still compose-internal; client auth is what we're testing
      ca: rootsPem,
      cert: deviceChain,
      key: forge.pki.privateKeyToPem(keys.privateKey),
    },
  });

  const hb = await api('POST', '/api/heartbeat', null, mtls);
  check('mTLS heartbeat accepted (quarantined)', hb.status === 200 && hb.body?.state === 'quarantine',
    `status=${hb.status} body=${JSON.stringify(hb.body)}`);

  // 7. Quarantine gate: heartbeat event allowed, check_result refused.
  const hbEv = await api('POST', '/api/events', canonicalEvent('heartbeat'), mtls);
  check('heartbeat event allowed in quarantine', hbEv.status === 202);
  const crEv = await api('POST', '/api/events', canonicalEvent('check_result'), mtls);
  check('check_result refused while quarantined', crEv.status === 403);

  // 8. Operator confirms identity + config integrity -> active.
  const confirm = await api('POST', `/api/devices/${DEVICE_ID}/confirm`);
  check('operator confirm clears quarantine', confirm.status === 200 && confirm.body.state === 'active');

  const crEv2 = await api('POST', '/api/events', canonicalEvent('check_result'), mtls);
  check('check_result accepted after confirm', crEv2.status === 202);

  // ---- key-continuity retrust (approved Phase 3 flow) ---------------------
  // Simulates the expired-cert path: challenge -> SIGNED PoP -> new OTT.
  const ch = await api('POST', '/api/enroll/retrust/challenge', { device_id: DEVICE_ID });
  check('retrust challenge issued', ch.status === 200 && !!ch.body.challenge,
    `status=${ch.status} body=${JSON.stringify(ch.body)}`);

  const payload = `netbox-retrust-v1\0${DEVICE_ID}\0${ch.body.challenge}`;
  const sig = signPayload(deviceKeyPem, payload);
  const rt = await api('POST', '/api/enroll/retrust', {
    device_id: DEVICE_ID,
    challenge: ch.body.challenge,
    signature_b64: sig,
    public_key_pem: pubkeyPem(keys),
  });
  check('retrust PoP accepted, fresh OTT issued', rt.status === 200 && !!rt.body.step_ca?.ott,
    `status=${rt.status} body=${JSON.stringify(rt.body)}`);

  const chBad = await api('POST', '/api/enroll/retrust/challenge', { device_id: DEVICE_ID });
  const badSig = Buffer.from('not-a-real-signature').toString('base64');
  const rtBad = await api('POST', '/api/enroll/retrust', {
    device_id: DEVICE_ID, challenge: chBad.body.challenge,
    signature_b64: badSig, public_key_pem: pubkeyPem(keys),
  });
  check('retrust with invalid signature refused', rtBad.status === 403);

  // ---- negative 1: forged token ----------------------------------------
  const forged = await api('POST', '/api/enroll/redeem', { enrollment_token: 'forged-token-value' });
  check('forged enrollment token refused', forged.status === 403);

  // ---- negative 2: self-signed client cert ------------------------------
  const rogueKeys = forge.pki.rsa.generateKeyPair(2048);
  const rogueCert = forge.pki.createCertificate();
  rogueCert.publicKey = rogueKeys.publicKey;
  rogueCert.serialNumber = '01';
  rogueCert.validity.notBefore = new Date();
  rogueCert.validity.notAfter = new Date(Date.now() + 86400_000);
  rogueCert.setSubject([{ name: 'commonName', value: crypto.randomUUID() }]);
  rogueCert.setIssuer([{ name: 'commonName', value: 'rogue-ca' }]);
  rogueCert.sign(rogueKeys.privateKey, forge.md.sha256.create());
  const rogueAgent = new Agent({
    connect: {
      rejectUnauthorized: false,
      cert: forge.pki.certificateToPem(rogueCert),
      key: forge.pki.privateKeyToPem(rogueKeys.privateKey),
    },
  });
  const rogue = await api('POST', '/api/heartbeat', null, rogueAgent);
  check('self-signed client cert refused at mTLS gate', rogue.status === 401);

  // Rogue device must not exist in the registry at all.
  const devices = await api('GET', '/api/devices');
  const roguePresent = devices.body.some(d => d.device_id === rogueCert.subject.getField('CN').value);
  check('rogue device absent from registry', !roguePresent);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('simulator crashed:', e); process.exit(1); });
