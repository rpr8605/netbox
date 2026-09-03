#!/usr/bin/env node
// scripts/seed_demo_sites.js — seed three synthetic sites with a realistic
// vendor mix for the Fleet Console topology demo. Synthetic data only.
//   Site 1 "MEDITECH Expanse"   — EHR + Mirth channels; ONE CORRELATED FAILURE:
//                                 the interface engine is down AND two dependent
//                                 channels (adt, lab) are down as a result.
//   Site 2 "VA / VistA"         — HL7v2 tap pattern; all reachable.
//   Site 3 "athenahealth"       — FHIR-native; all active.
// The correlated failure exists so the rule-based "co-occurring signals" panel
// has real correlated facts to render (engine down + dependents down).
// Run: node scripts/seed_demo_sites.js  (control plane must be up)
import crypto from 'node:crypto';
import forge from '../control-plane/node_modules/node-forge/lib/index.js';
import { request, Agent } from '../control-plane/node_modules/undici/index.js';

const CP = process.env.CONTROL_PLANE_URL ?? 'https://localhost:9100';
const CA = process.env.CA_URL ?? 'https://localhost:9000';
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, path, body, agent = insecure) {
  const res = await request(`${CP}${path}`, {
    method, dispatcher: agent,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.statusCode, body: parsed ?? text };
}

async function enrollDevice(deviceId, siteId) {
  const tok = await api('POST', '/api/enroll/tokens', { device_id: deviceId, site_id: siteId });
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const redeem = await api('POST', '/api/enroll/redeem', { enrollment_token: tok.body.enrollment_token, public_key_pem: forge.pki.publicKeyToPem(keys.publicKey) });
  const rootsRes = await request(`${CA}/roots.pem`, { dispatcher: insecure });
  const rootsPem = await rootsRes.body.text();
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: deviceId }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const signRes = await request(`${CA}/1.0/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csr: forge.pki.certificationRequestToPem(csr), ott: redeem.body.step_ca.ott }), dispatcher: insecure });
  const signBody = JSON.parse(await signRes.body.text());
  const chain = `${signBody.crt ?? signBody.cert}\n${signBody.ca ?? ''}`;
  const mtls = new Agent({ connect: { rejectUnauthorized: false, ca: rootsPem, cert: chain, key: keyPem } });
  await api('POST', '/api/heartbeat', null, mtls);
  await api('POST', `/api/devices/${deviceId}/confirm`);
  return { mtls, deviceId, siteId };
}

function ev(deviceId, siteId, { service, status, tier, detail, check_name, adapter, channel_id, latency_ms = 20 }) {
  return {
    event_id: crypto.randomUUID(), device_id: deviceId, site_id: siteId,
    occurred_at: new Date().toISOString(), kind: 'check_result', service,
    status, latency_ms, confidence: 'high', freshness_s: 0, phi_mode: false,
    detail, check_name, adapter, ...(tier ? { tier_observed: tier } : {}),
    ...(channel_id ? { channel_id } : {}),
  };
}

async function postEvents(dev, events) {
  for (const e of events) {
    await request(`${CP}/api/events`, { method: 'POST', dispatcher: dev.mtls, headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) });
  }
}

// Register the interface-engine channels so the topology shows display names.
async function registerChannels() {
  await api('POST', '/api/channels', { channel_id: 'adt-to-lab', display_name: 'ADT -> Lab', engine: 'mirth' });
  await api('POST', '/api/channels', { channel_id: 'oru-result', display_name: 'ORU Result', engine: 'mirth' });
  await api('POST', '/api/channels', { channel_id: 'meds-to-pharmacy', display_name: 'Meds -> Pharmacy', engine: 'mirth' });
}

async function main() {
  await registerChannels();

  // --- Site 1: MEDITECH Expanse, with the correlated engine-down failure ----
  const s1 = { id: crypto.randomUUID(), device: crypto.randomUUID() };
  const d1 = await enrollDevice(s1.device, s1.id);
  // engine (mirth) DOWN, its dependent channels down, EHR still up (it's a
  // separate path) — the co-occurrence the panel must surface as correlation.
  await postEvents(d1, [
    ev(s1.device, s1.id, { service: 'ehr', status: 'active', tier: 'L3', check_name: 'ehr-fhir-poll', adapter: 'fhir', detail: 'FHIR ok: metadata + Patient/synthetic-001 read (HTTP 200)' }),
    ev(s1.device, s1.id, { service: 'adt', status: 'down', check_name: 'mllp-listener-tcp', adapter: 'net', channel_id: 'adt-to-lab', detail: 'TCP mllp.example.local:2575 unreachable (ECONNREFUSED)' }),
    ev(s1.device, s1.id, { service: 'lab', status: 'down', check_name: 'oru-flow', adapter: 'net', channel_id: 'oru-result', detail: 'Mirth channel oru-result state STOPPED' }),
    ev(s1.device, s1.id, { service: 'pharmacy', status: 'degraded', check_name: 'meds-flow', adapter: 'net', channel_id: 'meds-to-pharmacy', detail: 'Mirth channel meds-to-pharmacy destination ERROR' }),
    ev(s1.device, s1.id, { service: 'imaging', status: 'reachable', tier: 'L1', check_name: 'pacs-tcp', adapter: 'net', detail: 'TCP pacs.example.local:104 open' }),
    ev(s1.device, s1.id, { service: 'eprescribe', status: 'verified_ready', tier: 'L2', check_name: 'surescripts-edge', adapter: 'net', detail: 'TLS ok on surescripts edge' }),
    ev(s1.device, s1.id, { service: 'internet', status: 'active', tier: 'L3', check_name: 'wan', adapter: 'net', detail: 'wan ok' }),
    ev(s1.device, s1.id, { service: 'phone', status: 'active', check_name: 'sip', adapter: 'net', detail: 'sip registered' }),
    ev(s1.device, s1.id, { service: 'printing', status: 'active', check_name: 'spooler', adapter: 'net', detail: 'spooler ok' }),
  ]);

  // --- Site 2: VA / VistA — HL7v2 tap pattern, all reachable ----------------
  const s2 = { id: crypto.randomUUID(), device: crypto.randomUUID() };
  const d2 = await enrollDevice(s2.device, s2.id);
  await postEvents(d2, [
    ev(s2.device, s2.id, { service: 'ehr', status: 'reachable', tier: 'L1', check_name: 'mllp-listener-tcp', adapter: 'net', detail: 'TCP vista.example.local:2575 open' }),
    ev(s2.device, s2.id, { service: 'adt', status: 'reachable', tier: 'L1', check_name: 'adt-tcp', adapter: 'net', detail: 'TCP adt feed open' }),
    ev(s2.device, s2.id, { service: 'lab', status: 'reachable', tier: 'L1', check_name: 'lab-tcp', adapter: 'net', detail: 'lab feed open' }),
    ev(s2.device, s2.id, { service: 'internet', status: 'active', tier: 'L3', check_name: 'wan', adapter: 'net', detail: 'wan ok' }),
    ev(s2.device, s2.id, { service: 'phone', status: 'active', check_name: 'sip', adapter: 'net', detail: 'sip registered' }),
  ]);

  // --- Site 3: athenahealth — FHIR-native, all active -----------------------
  const s3 = { id: crypto.randomUUID(), device: crypto.randomUUID() };
  const d3 = await enrollDevice(s3.device, s3.id);
  await postEvents(d3, [
    ev(s3.device, s3.id, { service: 'ehr', status: 'active', tier: 'L3', check_name: 'ehr-fhir-poll', adapter: 'fhir', detail: 'FHIR ok: metadata + Patient read (HTTP 200)' }),
    ev(s3.device, s3.id, { service: 'adt', status: 'active', tier: 'L3', check_name: 'adt-fhir', adapter: 'fhir', detail: 'adt active' }),
    ev(s3.device, s3.id, { service: 'lab', status: 'active', tier: 'L3', check_name: 'lab-fhir', adapter: 'fhir', detail: 'lab active' }),
    ev(s3.device, s3.id, { service: 'internet', status: 'active', tier: 'L3', check_name: 'wan', adapter: 'net', detail: 'wan ok' }),
    ev(s3.device, s3.id, { service: 'eprescribe', status: 'active', tier: 'L3', check_name: 'surescripts', adapter: 'net', detail: 'eprescribe ok' }),
  ]);

  console.log('seeded 3 sites:');
  console.log('  site1 (MEDITECH, engine-down correlation):', s1.id);
  console.log('  site2 (VA / VistA):', s2.id);
  console.log('  site3 (athenahealth):', s3.id);
}
main().catch(e => { console.error(e); process.exit(1); });
