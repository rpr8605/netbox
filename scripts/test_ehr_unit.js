#!/usr/bin/env node
// scripts/test_ehr_unit.js — unit-level checks for the EHR/EMR adapters with
// REAL stub servers (FHIR R4, Mirth admin, raw TCP, forged-TLS), plus profile
// loader negative cases. No device enrollment, no compose stack — every event
// is captured through the postEvent mock and validated against the canonical
// schema here (the same AJV tree the control plane uses). Run via
//   node scripts/test_ehr_unit.js
import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import forge from '../control-plane/node_modules/node-forge/lib/index.js';
import Ajv from '../control-plane/node_modules/ajv/dist/ajv.js';
import addFormats from '../control-plane/node_modules/ajv-formats/dist/index.js';
import { loadProfile, runProfile } from '../netbox-agent/lib/ehr_check.js';
import { runNetCheck } from '../netbox-agent/lib/net_checks.js';
import { setMockPostEvent } from '../netbox-agent/lib/post_event.js';

const schema = JSON.parse(fs.readFileSync('schemas/netbox_event.schema.json', 'utf8'));
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// --- capture every emitted event -------------------------------------------
const posts = [];
setMockPostEvent(async (ev) => { posts.push(ev); return { status: 202, body: ev }; });

// --- stub servers ------------------------------------------------------------
const forgeCert = (() => {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '03';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 30 * 86400e3);
  cert.setSubject([{ name: 'commonName', value: 'stub-hospital' }]);
  cert.setIssuer([{ name: 'commonName', value: 'stub-ca' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
})();

// FHIR stub: /fhir/r4/metadata, /fhir/r4/Patient/synthetic-001,
// POST /oauth/token (client_credentials AND backend_services — the assertion
// signature is verified with the public key so the RS384 path is proven).
let fhirKeys;
function startFhirStub() {
  fhirKeys = forge.pki.rsa.generateKeyPair(2048);
  const server = http.createServer((req, res) => {
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
        let okAuth = false;
        // client_credentials path
        if (p.get('client_id') === 'synthetic-client' && p.get('client_secret') === 'synthetic-secret') okAuth = true;
        // backend_services path — verify the signed JWT assertion
        const assertion = p.get('client_assertion');
        if (assertion) {
          const [h, s] = assertion.split('.');
          try {
            const md = forge.md.sha384.create();
            md.update(`${h}.${s}`, 'utf8');
            const pub = forge.pki.publicKeyFromPem(forge.pki.publicKeyToPem(fhirKeys.publicKey));
            const sigBytes = Buffer.from(assertion.split('.')[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
            okAuth = pub.verify(md.digest().bytes(), sigBytes.toString('binary'));
          } catch { okAuth = false; }
        }
        const ok = okAuth && ['synthetic-client', 'synthetic-client'].includes(p.get('client_id') || 'synthetic-client');
        if (!ok) return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client' }));
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'stub-token', token_type: 'bearer', expires_in: 300 }));
      });
    }
    if (u.pathname === '/fhir/r4/Patient/synthetic-001') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resourceType: 'Patient', id: 'synthetic-001' }));
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ resourceType: 'OperationOutcome' }));
  });
  return server;
}

// Mirth stub: POST /api/sessions (Basic), GET /api/channels,
// GET /api/channels/:id/status, DELETE /api/sessions/current. Mirth-mode can
// flip a channel to ERRORED so the 'degraded' mapping is a real negative case.
let mirthMode = 'good';
function startMirthStub() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/api/sessions' && req.method === 'POST') {
      const auth = req.headers.authorization ?? '';
      const creds = Buffer.from(auth.replace('Basic ', ''), 'base64').toString();
      if (creds !== 'admin:adminpass') return res.writeHead(401).end();
      return res.writeHead(200, { 'set-cookie': ['JSESSIONID=stub123'], 'content-type': 'application/json' }).end('{}');
    }
    if (u.pathname === '/api/sessions/current' && req.method === 'DELETE') {
      return res.writeHead(204).end();
    }
    if (u.pathname === '/api/channels' && req.method === 'GET') {
      return res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify([{ id: '1', name: 'adt-to-lab' }, { id: '2', name: 'oru-result' }]));
    }
    const m = u.pathname.match(/^\/api\/channels\/(\d+)\/status$/);
    if (m && req.method === 'GET') {
      const degrade = mirthMode === 'degraded' && m[1] === '2';
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        channelId: m[1],
        state: degrade ? 'STOPPED' : 'STARTED',
        connectorStatuses: [
          { name: 'source', state: 'CONNECTED' },
          { name: 'dest-lab', state: degrade ? 'ERROR' : 'CONNECTED' },
        ],
      }));
    }
    res.writeHead(404).end();
  });
  return server;
}

// Start servers on ephemeral ports
// Start a server (http/net/tls) on an ephemeral loopback port. The handler
// magic lives at creation time; listen() only does the bind.
async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}
// closeIfUndrained: close with a hard deadline — stub servers may hold
// half-open sockets from intentionally-failing TLS/TCP probes, and close(cb)
// would otherwise wait for them forever and hang the harness.
async function closeServer(server) {
  await Promise.race([
    new Promise(r => server.close(r)),
    new Promise(r => setTimeout(r, 500)),
  ]);
}

const ctx = { deviceId: crypto.randomUUID(), siteId: crypto.randomUUID() };
function validateAll(events) {
  for (const ev of events) {
    if (!validate(ev)) {
      console.log('schema violation:', validate.errors);
      return false;
    }
  }
  return true;
}
// runOne — route a single adapter case through the canonical-event path
// (runProfile), so the status-mapping verdicts are exercised as real events,
// not just as returned objects.
async function runOne(adapter, name, service, params, opts = {}) {
  const p = { profile_id: `unit-${name}`, vendor: 'UNIT', checks: [{ name, service, adapter, params }] };
  return (await runProfile(ctx, p, { logger: () => {}, ...opts })).results[0];
}

async function main() {
  // ---- FHIR across HTTP ----------------------------------------------------
  const fhirServer = startFhirStub();
  const fhirPort = await listen(fhirServer);
  const fhirProfile = {
    profile_id: 'meditech-expanse', vendor: 'MEDITECH',
    checks: [
      { name: 'ehr-fhir-poll', service: 'ehr', adapter: 'fhir',
        params: { base_url: `http://127.0.0.1:${fhirPort}/fhir/r4`,
                  auth: { method: 'client_credentials', token_url: `http://127.0.0.1:${fhirPort}/oauth/token`,
                          client_id: 'synthetic-client', client_secret: 'synthetic-secret' },
                  resource_read: { resource_type: 'Patient', id: 'synthetic-001' } } },
    ],
  };
  const r1 = await runProfile(ctx, fhirProfile, { logger: () => {} });
  check('FHIR: metadata + scoped read -> active/L3', r1.results[0].status === 'active' && r1.results[0].tier === 'L3', JSON.stringify(r1.results[0].detail));

  // backend_services auth: signed assertion verified by stub
  const { runFhirCheck } = await import('../netbox-agent/lib/fhir_r4.js');
  const p2 = { base_url: `http://127.0.0.1:${fhirPort}/fhir/r4`,
               auth: { method: 'backend_services', token_url: `http://127.0.0.1:${fhirPort}/oauth/token`,
                       client_id: 'synthetic-client', private_key: forge.pki.privateKeyToPem(fhirKeys.privateKey) } };
  const r2 = await runOne('fhir', 'backend-services', 'ehr', p2);
  check('FHIR backend_services signed assertion accepted (RS384 verified)', ['active', 'verified_ready'].includes(r2.status), r2.detail);

  // wrong secret -> 'unknown', never 'down'
  const bad = { base_url: `http://127.0.0.1:${fhirPort}/fhir/r4`,
                auth: { method: 'client_credentials', token_url: `http://127.0.0.1:${fhirPort}/oauth/token`,
                        client_id: 'synthetic-client', client_secret: 'WRONG' } };
  const r3 = await runOne('fhir', 'wrong-secret', 'ehr', bad);
  check('FHIR wrong secret -> unknown (not down)', r3.status === 'unknown', r3.detail);

  // endpoint stops listening -> 'down'
  const u = new URL(`http://127.0.0.1:${fhirPort}/fhir/r4`);
  await closeServer(fhirServer);
  const r4 = await runOne('fhir', 'endpoint-closed', 'ehr', { base_url: u.href, auth: { method: 'none' } });
  check('FHIR endpoint down -> down', r4.status === 'down', r4.detail);

  // ---- Mirth across HTTP ---------------------------------------------------
  const { runMirthCheck } = await import('../netbox-agent/lib/mirth_admin.js');
  const mirthServer = startMirthStub();
  const mirthPort = await listen(mirthServer);
  const m1 = await runOne('mirth', 'healthy', 'adt', { base_url: `http://127.0.0.1:${mirthPort}/api`, username: 'admin', password: 'adminpass' });
  check('Mirth all channels STARTED -> active/L3', m1.status === 'active', m1.detail);

  mirthMode = 'degraded';
  const m2 = await runOne('mirth', 'one-channel-stopped', 'adt', { base_url: `http://127.0.0.1:${mirthPort}/api`, username: 'admin', password: 'adminpass' });
  check('Mirth one channel STOPPED/ERRORED -> degraded', m2.status === 'degraded', m2.detail);

  const m3 = await runOne('mirth', 'wrong-creds', 'adt', { base_url: `http://127.0.0.1:${mirthPort}/api`, username: 'admin', password: 'WRONG' });
  check('Mirth wrong creds -> unknown (not down)', m3.status === 'unknown', m3.detail);

  await closeServer(mirthServer);
  const m4 = await runOne('mirth', 'endpoint-closed', 'adt', { base_url: `http://127.0.0.1:${mirthPort}/api`, username: 'admin', password: 'adminpass' });
  check('Mirth endpoint down -> down', m4.status === 'down', m4.detail);
  mirthMode = 'good';

  // ---- net (cleartext TCP + forged TLS) ------------------------------------
  const tcpServer = net.createServer(() => {});
  const tcpPort = await listen(tcpServer);
  const n1 = await runOne('net', 'cleartext', 'ehr', { host: '127.0.0.1', port: tcpPort, tls: false });
  check('net cleartext -> reachable/L1', n1.status === 'reachable' && n1.tier === 'L1', n1.detail);

  const tlsServer = tls.createServer({ key: forgeCert.key, cert: forgeCert.cert }, (sock) => sock.end());
  const tlsPort = await listen(tlsServer);
  const n2 = await runOne('net', 'tls-valid', 'ehr', { host: '127.0.0.1', port: tlsPort, tls: true });
  check('net TLS valid -> verified_ready/L2', n2.status === 'verified_ready' && n2.tier === 'L2', n2.detail);

  const n3 = await runOne('net', 'tls-on-plain', 'ehr', { host: '127.0.0.1', port: tcpPort, tls: true });
  check('net TLS required but plain TCP -> degraded/L1', n3.status === 'degraded' && n3.tier === 'L1', n3.detail);

  await closeServer(tcpServer);
  const n4 = await runOne('net', 'port-closed', 'ehr', { host: '127.0.0.1', port: tcpPort, tls: false });
  check('net port down -> down', n4.status === 'down', n4.detail);

  // ---- loader negative cases ----------------------------------------------
  try { loadProfile({ profile_id: 'x', vendor: 'y', checks: [] }); check('loader rejects empty checks', false); }
  catch { check('loader rejects empty checks', true); }
  try { loadProfile('config/ehr-profiles/no-such.json'); check('loader rejects missing file', false); }
  catch { check('loader rejects missing file', true); }
  try { loadProfile({ profile_id: 'x', vendor: 'y', checks: [{ name: 'n', service: 'ehr', adapter: 'bogus', params: {} }] }); check('loader rejects unknown adapter', false); }
  catch { check('loader rejects unknown adapter', true); }

  // ---- every emitted event validates ---------------------------------------
  check('all emitted events validate against canonical schema', validateAll(posts), `${posts.length} events`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} unit checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('unit harness crashed:', e); process.exit(1); });
