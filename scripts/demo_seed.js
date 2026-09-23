#!/usr/bin/env node
// scripts/demo_seed.js — seed synthetic critical-access hospitals in MO/KS for
// the one-command demo. All data is fictional; no PHI-shaped fields are used.
// Exports buildDemoSites() for unit testing and seedDemoSites() for runtime.
import crypto from 'node:crypto';
import path from 'node:path';
import forge from '../control-plane/node_modules/node-forge/lib/index.js';
import { request, Agent } from '../control-plane/node_modules/undici/index.js';

const CP = process.env.CONTROL_PLANE_URL ?? 'https://localhost:10443';
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

// Build the deterministic synthetic hospital list. Coordinates are approximate
// city centers in Missouri and Kansas; names are intentionally fictional.
export function buildDemoSites() {
  return [
    {
      site_id: 'demo-site-barton-county-memorial',
      device_id: 'demo-device-barton-county-memorial',
      name: 'Barton County Memorial Hospital',
      lat: 37.4947, lng: -94.2766, // Lamar, MO area
    },
    {
      site_id: 'demo-site-lafayette-county-regional',
      device_id: 'demo-device-lafayette-county-regional',
      name: 'Lafayette County Regional Medical Center',
      lat: 39.1847, lng: -93.8794, // Lexington, MO area
    },
    {
      site_id: 'demo-site-johnson-county-medical',
      device_id: 'demo-device-johnson-county-medical',
      name: 'Johnson County Medical Center',
      lat: 38.7628, lng: -93.7360, // Warrensburg, MO area
    },
    {
      site_id: 'demo-site-cass-county-community',
      device_id: 'demo-device-cass-county-community',
      name: 'Cass County Community Hospital',
      lat: 38.6533, lng: -94.3488, // Harrisonville, MO area
    },
    {
      site_id: 'demo-site-wyandotte-county-health',
      device_id: 'demo-device-wyandotte-county-health',
      name: 'Wyandotte County Health System',
      lat: 39.1142, lng: -94.6275, // Kansas City, KS area
    },
    {
      site_id: 'demo-site-miami-county-medical',
      device_id: 'demo-device-miami-county-medical',
      name: 'Miami County Medical Center',
      lat: 38.5722, lng: -94.8791, // Paola, KS area
    },
  ];
}

async function enrollDevice(deviceId, siteId) {
  const tok = await api('POST', '/api/enroll/tokens', {
    device_id: deviceId, site_id: siteId, name: null, lat: null, lng: null,
  });
  if (tok.status !== 200 || !tok.body.enrollment_token) throw new Error(`token issue failed for ${deviceId}: ${JSON.stringify(tok.body)}`);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const redeem = await api('POST', '/api/enroll/redeem', {
    enrollment_token: tok.body.enrollment_token,
    public_key_pem: forge.pki.publicKeyToPem(keys.publicKey),
  });
  if (redeem.status !== 200 || !redeem.body.step_ca?.ott) throw new Error(`redeem failed for ${deviceId}: ${JSON.stringify(redeem.body)}`);
  const rootsRes = await request(`${CA}/roots.pem`, { dispatcher: insecure });
  const rootsPem = await rootsRes.body.text();
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: deviceId }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const signRes = await request(`${CA}/1.0/sign`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ csr: forge.pki.certificationRequestToPem(csr), ott: redeem.body.step_ca.ott }),
    dispatcher: insecure,
  });
  const signBody = JSON.parse(await signRes.body.text());
  const chain = `${signBody.crt ?? signBody.cert}\n${signBody.ca ?? ''}`;
  const mtls = new Agent({ connect: { rejectUnauthorized: false, ca: rootsPem, cert: chain, key: keyPem } });
  const hb = await api('POST', '/api/heartbeat', null, mtls);
  if (hb.status !== 200) throw new Error(`heartbeat failed for ${deviceId}: ${JSON.stringify(hb.body)}`);
  const confirm = await api('POST', `/api/devices/${deviceId}/confirm?role=operations-manager`);
  if (confirm.status !== 200) throw new Error(`confirm failed for ${deviceId}: ${JSON.stringify(confirm.body)}`);
  return { mtls, deviceId, siteId, certPem: chain, keyPem };
}

export function demoEvent(deviceId, siteId, { service, status, tier, detail, check_name, adapter, channel_id }) {
  return {
    event_id: crypto.randomUUID(), device_id: deviceId, site_id: siteId,
    occurred_at: new Date().toISOString(), kind: 'check_result', service,
    status, latency_ms: 12, confidence: 'high', freshness_s: 0, phi_mode: false,
    detail, check_name, adapter, ...(tier ? { tier_observed: tier } : {}),
    ...(channel_id ? { channel_id } : {}),
  };
}

async function registerChannels() {
  const channels = [
    { channel_id: 'adt-to-lab', display_name: 'ADT -> Lab', engine: 'mirth', source_system: 'ADT', destination_system: 'Lab' },
    { channel_id: 'oru-result', display_name: 'ORU Result', engine: 'mirth', source_system: 'Lab', destination_system: 'Results' },
    { channel_id: 'meds-to-pharmacy', display_name: 'Meds -> Pharmacy', engine: 'mirth', source_system: 'Meds', destination_system: 'Pharmacy' },
  ];
  for (const c of channels) {
    await api('POST', '/api/channels?role=operations-manager', c);
  }
}

export function buildDemoAlertRules() {
  return [
    { severity: 'P2', service: 'lab', impact_stmt: 'Lab interface results delayed from this site', runbook_url: 'https://runbooks.local/lab-delayed' },
    { severity: 'P2', service: 'dns', impact_stmt: 'DNS resolution unavailable from this site', runbook_url: 'https://runbooks.local/dns-down' },
    { severity: 'P2', service: 'cert_expiration', impact_stmt: 'TLS certificate nearing expiry for a critical dependency', runbook_url: 'https://runbooks.local/cert-renewal' },
    { severity: 'P2', service: 'internet', impact_stmt: 'Internet connectivity degraded at this site', runbook_url: 'https://runbooks.local/wan-flap' },
  ];
}

export async function createDemoAlertRules() {
  const rules = buildDemoAlertRules();
  const created = [];
  for (const r of rules) {
    const res = await api('POST', '/api/alert-rules', r);
    if (res.status !== 200) throw new Error(`rule create failed: ${JSON.stringify(res.body)}`);
    created.push({ ...res.body, ...r });
  }
  return created;
}

export function baselineEvents(site) {
  const { device_id, site_id } = site;
  return [
    demoEvent(device_id, site_id, { service: 'ehr', status: 'active', tier: 'L3', check_name: 'ehr-fhir-poll', adapter: 'fhir', detail: 'FHIR ok: metadata + Patient/synthetic-001 read' }),
    demoEvent(device_id, site_id, { service: 'adt', status: 'active', tier: 'L3', check_name: 'adt-fhir', adapter: 'fhir', channel_id: 'adt-to-lab', detail: 'ADT flow active' }),
    demoEvent(device_id, site_id, { service: 'lab', status: 'active', tier: 'L3', check_name: 'lab-fhir', adapter: 'fhir', channel_id: 'oru-result', detail: 'Lab flow active' }),
    demoEvent(device_id, site_id, { service: 'pharmacy', status: 'active', tier: 'L3', check_name: 'meds-flow', adapter: 'net', channel_id: 'meds-to-pharmacy', detail: 'Pharmacy interface active' }),
    demoEvent(device_id, site_id, { service: 'internet', status: 'active', tier: 'L3', check_name: 'wan', adapter: 'net', detail: 'WAN primary up' }),
    demoEvent(device_id, site_id, { service: 'dns', status: 'active', tier: 'L3', check_name: 'dns', adapter: 'net', detail: 'DNS resolver responding' }),
    demoEvent(device_id, site_id, { service: 'cert_expiration', status: 'verified_ready', tier: 'L2', check_name: 'tls-valid-cert', adapter: 'net', detail: 'TLS certificate valid' }),
  ];
}

export async function seedDemoSites(cpUrl = CP, caUrl = CA) {
  if (cpUrl !== CP) throw new Error('re-targeting cpUrl not implemented in this helper');
  await registerChannels();
  const sites = buildDemoSites();
  const rules = await createDemoAlertRules();
  const seeded = [];
  for (const site of sites) {
    const dev = await enrollDevice(site.device_id, site.site_id);
    // Update site display name and coordinates.
    await api('POST', '/api/enroll/tokens', { device_id: site.device_id, site_id: site.site_id, name: site.name, lat: site.lat, lng: site.lng });
    for (const e of baselineEvents(site)) {
      await request(`${CP}/api/events`, { method: 'POST', dispatcher: dev.mtls, headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) });
    }
    seeded.push({ ...site, ...dev });
  }
  return { sites: seeded, rules };
}

async function main() {
  const health = await api('GET', '/api/health');
  if (health.status !== 200) throw new Error('control plane unreachable — run `docker compose up -d step-ca control-plane` first');
  const { sites, rules } = await seedDemoSites();
  console.log(`seeded ${sites.length} demo sites:`);
  for (const s of sites) console.log(`  ${s.name} (${s.site_id})`);
  console.log(`created ${rules.length} alert rules for the incident timeline`);
}

const { fileURLToPath } = await import('url');
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(e); process.exit(1); });
}
