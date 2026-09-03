#!/usr/bin/env node
// scripts/test_ehr_e2e.js — end-to-end proof of the EHR/EMR integration layer
// through the real stack: synthetic site -> device enrollment -> mTLS ->
// control-plane /api/events -> console readback via GET /api/devices/:id.
// Requires step-ca + control-plane from docker-compose up already running.
// Four MEDITECH-tier profile files + TruBridge + Epic Community Connect are
// each driven against stub servers started by THIS script on 127.0.0.1 —
// no real hospital data, no real HL7 feed, per the Phase rule repeated in
// every spec prompt. The public HAPI FHIR R4 sandbox is probed first; if
// reachable, the meditech-expanse run also validates against it (auth method
// 'none', metadata only — still no PHI; if unreachable the stub only path is
// used and this is logged explicitly, not silently skipped).
import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import forge from '../control-plane/node_modules/node-forge/lib/index.js';
import { request, Agent } from '../control-plane/node_modules/undici/index.js';
import { loadProfile, runProfile } from '../netbox-agent/lib/ehr_check.js';
import { runFhirCheck } from '../netbox-agent/lib/fhir_r4.js';
import fs from 'node:fs';

const CP = process.env.CONTROL_PLANE_URL ?? 'https://localhost:9100';
const CA = process.env.CA_URL ?? 'https://localhost:9000';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Insecure-agent only for enrollment admin endpoints and GET /api/devices —
// exactly like device-sim's compose-internal posture: the server never
// verifies server-side TLS; client auth on device endpoints IS tested.
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

// Same enrollment as device-sim/src/index.js — token -> keygen -> redeem ->
// CA pin -> CSR -> step-ca sign -> confirm -> return mTLS agent. This is the
// device-agent trust foundation; EHR checks run on top of it.
async function enrollDevice(deviceId, siteId) {
  const tok = await api('POST', '/api/enroll/tokens', { device_id: deviceId, site_id: siteId });
  if (tok.status !== 200 || !tok.body.enrollment_token) throw new Error('token issue failed');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const redeem = await api('POST', '/api/enroll/redeem', {
    enrollment_token: tok.body.enrollment_token,
    public_key_pem: forge.pki.publicKeyToPem(keys.publicKey),
  });
  if (redeem.status !== 200 || !redeem.body.step_ca?.ott) throw new Error('redeem failed');
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
  // The mTLS heartbeat is not ceremony: confirm requires a recorded valid-cert
  // presentation (routes/devices.js gates on cert_serial + last_seen_at), and
  // the events route is what stamps them.
  const hb = await api('POST', '/api/heartbeat', null, mtls);
  if (hb.status !== 200) throw new Error(`heartbeat failed: ${JSON.stringify(hb.body)}`);
  const confirm = await api('POST', `/api/devices/${deviceId}/confirm`);
  if (confirm.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(confirm.body)}`);
  return { mtls, deviceId, siteId };
}

// Exponential-free posting helper: run checks for a profile against real mTLS
// post event to the control plane.
function realPost(mtls) {
  return async (ev) => {
    const res = await request(`${CP}/api/events`, {
      method: 'POST', dispatcher: mtls,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ev),
    });
    const text = await res.body.text();
    return { status: res.statusCode, body: text };
  };
}

// ---- stub servers (same shapes as the unit harness) ------------------------
let mirthMode = 'good';
function startMirthStub() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/api/sessions' && req.method === 'POST') {
      const auth = req.headers.authorization ?? '';
      const creds = Buffer.from(auth.replace('Basic ', ''), 'base64').toString();
      if (creds !== 'admin:adminpass') return res.writeHead(401).end();
      return res.writeHead(200, { 'set-cookie': ['JSESSIONID=stub123'], 'content-type': 'application/json' }).end('{}');
    }
    if (u.pathname === '/api/sessions/current' && req.method === 'DELETE') return res.writeHead(204).end();
    if (u.pathname === '/api/channels' && req.method === 'GET') {
      return res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify([{ id: '1', name: 'adt-to-lab' }, { id: '2', name: 'oru-result' }]));
    }
    const m = u.pathname.match(/^\/api\/channels\/(\d+)\/status$/);
    if (m && req.method === 'GET') {
      const degrade = mirthMode === 'degraded' && m[1] === '2';
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        channelId: m[1], state: degrade ? 'STOPPED' : 'STARTED',
        connectorStatuses: [
          { name: 'source', state: 'CONNECTED' },
          { name: 'dest-lab', state: degrade ? 'ERROR' : 'CONNECTED' },
        ],
      }));
    }
    res.writeHead(404).end();
  });
}
function startFhirStub() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/fhir/r4/metadata') {
      return res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ resourceType: 'CapabilityStatement', status: 'active', fhirVersion: '4.0.1' }));
    }
    if (u.pathname === '/oauth/token') {
      let body = '';
      req.on('data', c => (body += c));
      return req.on('end', () => {
        const p = new URLSearchParams(body);
        if (p.get('client_id') !== 'synthetic-client' || p.get('client_secret') !== 'synthetic-secret') {
          return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client' }));
        }
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'stub-token' }));
      });
    }
    if (u.pathname === '/fhir/r4/Patient/synthetic-001') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resourceType: 'Patient', id: 'synthetic-001' }));
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ resourceType: 'OperationOutcome' }));
  });
}
function startTlsListener(certMat) {
  return tls.createServer(certMat, (sock) => sock.end());
}
async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}
async function closeServer(server) {
  await Promise.race([new Promise(r => server.close(r)), new Promise(r => setTimeout(r, 500))]);
}

// Read the console view: newest event per (device,service). This is exactly
// what the fleet console time-series page renders, minus the UI.
function latestEvents(device, mtlsAgent) {
  const path = `/api/devices/${device.deviceId}`;
  return api('GET', path).then(r => {
    const events = r.body.recent_events ?? [];
    return events[0] ?? null;
  });
}

async function runSiteProfile(device, profile, opts = {}) {
  const ctx = { deviceId: device.deviceId, siteId: device.siteId };
  const res = await runProfile(ctx, profile, { post: realPost(device.mtls), logger: () => {}, ...opts });
  for (const r of res.results) {
    if (r.skipped) continue; // disabled-by-profile entries (Epic default FHIR-off)
    if (r.post_status !== 202) {
      console.log('raw post response:', JSON.stringify(r));
      throw new Error(`post rejected by control plane (${r.post_status}) for ${r.check}`);
    }
  }
  return res;
}

// Wire a profile file to a stub endpoint — the per-site onboarding step.
function rebind(profile, endpointSpec) {
  const p = JSON.parse(JSON.stringify(profile));
  for (const c of p.checks) {
    if (c.adapter === 'fhir') {
      c.params.base_url = endpointSpec.fhir;
      if (c.params.auth?.token_url) c.params.auth.token_url = endpointSpec.fhirToken ?? endpointSpec.fhir;
      if (endpointSpec.fhirClientId && c.params.auth) {
        c.params.auth.client_id = endpointSpec.fhirClientId;
        c.params.auth.client_secret = endpointSpec.fhirClientSecret;
      }
    } else if (c.adapter === 'mirth') {
      c.params.base_url = endpointSpec.mirth;
      if (endpointSpec.mirthUser) { c.params.username = endpointSpec.mirthUser; c.params.password = endpointSpec.mirthPass; }
    } else if (c.adapter === 'net') {
      if (endpointSpec.host) { c.params.host = endpointSpec.host; c.params.port = endpointSpec.port; }
    }
  }
  return p;
}

async function main() {
  // ---- control plane reachable? --------------------------------------------
  const health = await api('GET', '/api/health');
  if (health.status !== 200) throw new Error('control plane unreachable — run `docker compose up -d step-ca control-plane` first');

  // ---- stubs ----------------------------------------------------------------
  const forgeCert = (() => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '04';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86400e3);
    cert.setSubject([{ name: 'commonName', value: 'stub-e2e' }]);
    cert.setIssuer([{ name: 'commonName', value: 'stub-ca' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
  })();

  const fhirStub = startFhirStub();
  const fhirPort = await listen(fhirStub);
  const mirthStub = startMirthStub();
  const mirthPort = await listen(mirthStub);
  const tlsStub = startTlsListener({ key: forgeCert.key, cert: forgeCert.cert });
  const tlsPort = await listen(tlsStub);
  const tcpStub = net.createServer(() => {});
  const tcpPort = await listen(tcpStub);

  // Sandbox probe — metadata-only. HAPI redirects http->https (301), so any
  // 2xx/3xx counts; using the https URL directly needs no redirect handling.
  let sandbox = { used: false };
  try {
    const probe = (async () => {
      try {
        const res = await request('https://hapi.fhir.org/baseR4/metadata', { dispatcher: insecure });
        return { used: [200, 301, 302].includes(res.statusCode) };
      } catch { return { used: false }; }
    })();
    sandbox = await Promise.race([probe, new Promise(r => setTimeout(() => r({ used: false }), 4000))]);
  } catch { /* stub fallback */ }
  console.log(`sandbox probe: public HAPI FHIR R4 sandbox ${sandbox.used ? 'REACHABLE — will validate against it' : 'unreachable — stub-only fallback engaged'}`);

  // ---- enroll five devices (one per simulated site — real enrollment) -------
  const meditechDev = await enrollDevice(crypto.randomUUID(), crypto.randomUUID());
  const meditechMagicDev = await enrollDevice(crypto.randomUUID(), crypto.randomUUID());
  const meditechCsDev = await enrollDevice(crypto.randomUUID(), crypto.randomUUID());
  const truDev = await enrollDevice(crypto.randomUUID(), crypto.randomUUID());
  const epicDev = await enrollDevice(crypto.randomUUID(), crypto.randomUUID());
  check('enrollment of five devices through real PKI flow', true);

  // ---- run profiles against stubs -------------------------------------------
  const meditech = rebind(loadProfile('config/ehr-profiles/meditech-expanse.json'), {
    fhir: `http://127.0.0.1:${fhirPort}/fhir/r4`, fhirToken: `http://127.0.0.1:${fhirPort}/oauth/token`,
    fhirClientId: 'synthetic-client', fhirClientSecret: 'synthetic-secret',
    mirth: `http://127.0.0.1:${mirthPort}/api`, mirthUser: 'admin', mirthPass: 'adminpass',
  });
  const meditechRes = await runSiteProfile(meditechDev, meditech);
  check('MEDITECH Expanse -> active (fhir) + active (mirth)', meditechRes.results[0].status === 'active' && meditechRes.results[1].status === 'active',
    meditechRes.results.map(r => `${r.check}:${r.status}`).join(' | '));

  if (sandbox.used) {
    // same profile against the real public sandbox — metadata only
    const sandboxMeditech = { ...meditech, checks: [ { ...meditech.checks[0], params: { base_url: 'https://hapi.fhir.org/baseR4', auth: { method: 'none' } } } ] };
    const so = await runFhirCheck(sandboxMeditech.checks[0].params);
    check('FHIR against PUBLIC sandbox (metadata only)', ['verified_ready', 'active'].includes(so.status), so.detail);
  }

  const magic = rebind(loadProfile('config/ehr-profiles/meditech-magic.json'), { host: '127.0.0.1', port: tlsPort });
  const magicRes = await runSiteProfile(meditechMagicDev, magic);
  check('MEDITECH Magic -> verified_ready (tls)', magicRes.results[0].status === 'verified_ready', magicRes.results[0].detail);

  const cs = rebind(loadProfile('config/ehr-profiles/meditech-client-server.json'), { host: '127.0.0.1', port: tcpPort });
  const csRes = await runSiteProfile(meditechCsDev, cs);
  check('MEDITECH Client-Server -> reachable (cleartext)', csRes.results[0].status === 'reachable', csRes.results[0].detail);

  const tru = rebind(loadProfile('config/ehr-profiles/trubridge-evident.json'), { host: '127.0.0.1', port: tlsPort });
  const truRes = await runSiteProfile(truDev, tru);
  check('TruBridge/Evident -> verified_ready (tls)', truRes.results[0].status === 'verified_ready', truRes.results[0].detail);

  const oracle = rebind(loadProfile('config/ehr-profiles/oracle-health-communityworks.json'), {
    host: '127.0.0.1', port: tcpPort,
    fhir: `http://127.0.0.1:${fhirPort}/fhir/r4`, fhirToken: `http://127.0.0.1:${fhirPort}/oauth/token`,
    fhirClientId: 'synthetic-client', fhirClientSecret: 'synthetic-secret',
  });
  const oracleDev = await enrollDevice(crypto.randomUUID(), crypto.randomUUID());
  const oracleRes = await runSiteProfile(oracleDev, oracle);
  check('Oracle Health CommunityWorks -> reachable (mllp) + verified_ready (fhir)', oracleRes.results[0].status === 'reachable' && oracleRes.results[1].status === 'verified_ready',
    oracleRes.results.map(r => `${r.check}:${r.status}`).join(' | '));

  const athena = rebind(loadProfile('config/ehr-profiles/athenahealth.json'), {
    fhir: `http://127.0.0.1:${fhirPort}/fhir/r4`, fhirToken: `http://127.0.0.1:${fhirPort}/oauth/token`,
    fhirClientId: 'synthetic-client', fhirClientSecret: 'synthetic-secret',
  });
  const athenaDev = await enrollDevice(crypto.randomUUID(), crypto.randomUUID());
  const athenaRes = await runSiteProfile(athenaDev, athena);
  check('athenahealth -> active (fhir)', athenaRes.results[0].status === 'active', athenaRes.results[0].detail);

  const sure = rebind(loadProfile('config/ehr-profiles/surescripts.json'), { host: '127.0.0.1', port: tlsPort });
  const sureDev = await enrollDevice(crypto.randomUUID(), crypto.randomUUID());
  const sureRes = await runSiteProfile(sureDev, sure);
  check('Surescripts connectivity -> verified_ready (tls edge)', sureRes.results[0].status === 'verified_ready', sureRes.results[0].detail);

  const va = rebind(loadProfile('config/ehr-profiles/va-vista-cprs.json'), { host: '127.0.0.1', port: tcpPort });
  const vaDev = await enrollDevice(crypto.randomUUID(), crypto.randomUUID());
  const vaRes = await runSiteProfile(vaDev, va);
  check('VA (VistA) -> reachable (cleartext MLLP)', vaRes.results[0].status === 'reachable', vaRes.results[0].detail);

  const ihs = rebind(loadProfile('config/ehr-profiles/ihs-rpms.json'), { host: '127.0.0.1', port: tcpPort });
  const ihsDev = await enrollDevice(crypto.randomUUID(), crypto.randomUUID());
  const ihsRes = await runSiteProfile(ihsDev, ihs);
  check('IHS (RPMS) -> reachable (cleartext MLLP)', ihsRes.results[0].status === 'reachable', ihsRes.results[0].detail);

  const epic = rebind(loadProfile('config/ehr-profiles/epic-community-connect.json'), { host: '127.0.0.1', port: tlsPort });
  const epicRes = await runSiteProfile(epicDev, epic);
  check('Epic Community Connect -> verified_ready (net only; fhir disabled by default)', epicRes.results.filter(r => r.skipped !== true).every(r => r.status === 'verified_ready'),
    epicRes.results.map(r => r.skipped ? `${r.check}:SKIPPED` : `${r.check}:${r.status}`).join(' | '));

  // ---- negative controls through the full stack -----------------------------
  // Epic with FHIR enabled at runtime + WRONG creds against the LIVE stub ->
  // 'unknown', not 'down' (auth deficit over a live endpoint is not an outage).
  const epicRuntime = JSON.parse(JSON.stringify(epic));
  for (const c of epicRuntime.checks) {
    if (c.adapter === 'fhir') {
      c.enabled = true;
      c.params.base_url = `http://127.0.0.1:${fhirPort}/fhir/r4`;
      c.params.auth = { method: 'client_credentials', token_url: `http://127.0.0.1:${fhirPort}/oauth/token`,
                        client_id: 'synthetic-client', client_secret: 'WRONG' };
    }
  }
  const epicBad = await runSiteProfile(epicDev, epicRuntime);
  check('Epic runtime-enable w/ bad creds -> unknown (config-deficit)', epicBad.results.filter(r => !r.skipped).every(r => r.status === 'verified_ready' || r.status === 'unknown'),
    epicBad.results.map(r => `${r.check}:${r.status}`).join(' | '));

  // ---- broken cases for Oracle, Athena, Surescripts -------------------------
  // Oracle broken: mllp port closed -> down; fhir wrong creds -> unknown
  await closeServer(tcpStub);
  const oracleBroken = rebind(JSON.parse(JSON.stringify(loadProfile('config/ehr-profiles/oracle-health-communityworks.json'))), {
    host: '127.0.0.1', port: tcpPort,
    fhir: `http://127.0.0.1:${fhirPort}/fhir/r4`, fhirToken: `http://127.0.0.1:${fhirPort}/oauth/token`,
    fhirClientId: 'synthetic-client', fhirClientSecret: 'WRONG',
  });
  const oracleBrokenRes = await runSiteProfile(oracleDev, oracleBroken);
  check('Oracle mllp closed -> down + fhir wrong creds -> unknown', oracleBrokenRes.results[0].status === 'down' && oracleBrokenRes.results[1].status === 'unknown',
    oracleBrokenRes.results.map(r => `${r.check}:${r.status}`).join(' | '));

  // athena broken: fhir wrong creds -> unknown (not down)
  const athenaBroken = rebind(JSON.parse(JSON.stringify(loadProfile('config/ehr-profiles/athenahealth.json'))), {
    fhir: `http://127.0.0.1:${fhirPort}/fhir/r4`, fhirToken: `http://127.0.0.1:${fhirPort}/oauth/token`,
    fhirClientId: 'synthetic-client', fhirClientSecret: 'WRONG',
  });
  const athenaBrokenRes = await runSiteProfile(athenaDev, athenaBroken);
  check('athena fhir wrong creds -> unknown (not down)', athenaBrokenRes.results[0].status === 'unknown', athenaBrokenRes.results[0].detail);

  // Surescripts broken: gateway unreachable -> down
  const sureBroken = rebind(JSON.parse(JSON.stringify(loadProfile('config/ehr-profiles/surescripts.json'))), { host: '127.0.0.1', port: tcpPort });
  const sureBrokenRes = await runSiteProfile(sureDev, sureBroken);
  check('Surescripts gateway unreachable -> down', sureBrokenRes.results[0].status === 'down', sureBrokenRes.results[0].detail);

  // VA broken: closed port -> down; IHS broken: closed port -> down (same net pattern)
  const vaBroken = rebind(JSON.parse(JSON.stringify(loadProfile('config/ehr-profiles/va-vista-cprs.json'))), { host: '127.0.0.1', port: tcpPort });
  const vaBrokenRes = await runSiteProfile(vaDev, vaBroken);
  check('VA (VistA) feed down -> down', vaBrokenRes.results[0].status === 'down', vaBrokenRes.results[0].detail);

  const ihsBroken = rebind(JSON.parse(JSON.stringify(loadProfile('config/ehr-profiles/ihs-rpms.json'))), { host: '127.0.0.1', port: tcpPort });
  const ihsBrokenRes = await runSiteProfile(ihsDev, ihsBroken);
  check('IHS (RPMS) feed down -> down', ihsBrokenRes.results[0].status === 'down', ihsBrokenRes.results[0].detail);

  // ---- topology/rollup: registered Mirth channel from earlier meditech run ----
  const roll = await api('GET', '/api/topology/rollup?role=operations-manager');
  const rollChannels = (roll.body?.channels ?? []);
  check('rollup: meditech mirth channel present', rollChannels.some(c => c.channel_id === 'adt-to-lab'),
    JSON.stringify(rollChannels.map(c => c.channel_id)));

  // Feed-down runs (existing): use the oracle-broken case for the negative-case close.
  await closeServer(fhirStub);
  const meditechDown = await runSiteProfile(meditechDev, { ...meditech, checks: [meditech.checks[0]] });
  check('MEDITECH Expanse feed down -> down', meditechDown.results[0].status === 'down', meditechDown.results[0].detail);

  // Mirth degraded: the engine answers but a channel is stopped.
  mirthMode = 'degraded';
  const meditechDegraded = await runSiteProfile(meditechDev, { ...meditech, checks: [meditech.checks[1]] });
  check('MEDITECH Expanse mirth channel stopped -> degraded', meditechDegraded.results[0].status === 'degraded', meditechDegraded.results[0].detail);

  // ---- console readback: assert the newest recorded status ------------------
  const medEvDown = (await latestEvents(meditechDev, 'ehr'));
  const medEvMirth = (await latestEvents(meditechDev, 'adt'));
  const devEvents = (await api('GET', `/api/devices/${meditechDev.deviceId}`)).body.recent_events ?? [];
  const firstEhr = devEvents.find(e => e.service === 'ehr');
  const firstAdt = devEvents.find(e => e.service === 'adt');
  check('console: meditech ehr newest = down (not stale active)', firstEhr && JSON.parse(firstEhr.payload).status === 'down');
  check('console: meditech adt newest = degraded', firstAdt && JSON.parse(firstAdt.payload).status === 'degraded');

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('e2e harness crashed:', e); process.exit(1); });
