#!/usr/bin/env node
// scripts/test_device_replace_e2e.js — end-to-end proof that a device swap
// actually revokes the old certificate in step-ca and that the next mTLS
// connection with the old cert is rejected. Requires the docker-compose stack
// (step-ca + control-plane) to be running.
import { request, Agent } from '../control-plane/node_modules/undici/index.js';
import forge from '../control-plane/node_modules/node-forge/lib/index.js';
import crypto from 'node:crypto';

const CP = process.env.CONTROL_PLANE_URL ?? 'https://localhost:10443';
const CA = process.env.CA_URL ?? 'https://localhost:9000';

const insecure = new Agent({ connect: { rejectUnauthorized: false } });
async function api(method, path, body, agent = insecure) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  const url = new URL(path, CP);
  const role = url.searchParams.get('role');
  if (role) {
    headers['x-dev-role'] = role;
    url.searchParams.delete('role');
  }
  const res = await request(url.toString(), {
    method, dispatcher: agent,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.statusCode, body: parsed ?? text };
}

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
  const hb = await api('POST', '/api/heartbeat', null, mtls);
  if (hb.status !== 200) throw new Error(`heartbeat failed: ${JSON.stringify(hb.body)}`);
  const confirm = await api('POST', `/api/devices/${deviceId}/confirm?role=operations-manager`);
  if (confirm.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(confirm.body)}`);
  return { mtls, deviceId, siteId, certPem: chain, keyPem };
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const health = await api('GET', '/api/health');
  if (health.status !== 200) throw new Error('control plane unreachable — run `docker compose up -d step-ca control-plane` first');

  const siteId = crypto.randomUUID();
  const oldDevice = await enrollDevice(crypto.randomUUID(), siteId);
  check('old device enrolled and confirmed active', true);

  const newDeviceId = crypto.randomUUID();
  const techReplace = await api('POST', `/api/devices/${oldDevice.deviceId}/replace?role=support-technician`, {
    new_device_id: newDeviceId, reason: 'unit test role denial',
  });
  check('support-technician cannot call replace', techReplace.status === 403, JSON.stringify(techReplace.body));

  const opsReplace = await api('POST', `/api/devices/${oldDevice.deviceId}/replace?role=operations-manager`, {
    new_device_id: newDeviceId, reason: 'E2E device swap test',
  });
  check('operations-manager can replace device', opsReplace.status === 200, JSON.stringify(opsReplace.body));

  const oldRow = (await api('GET', `/api/devices/${oldDevice.deviceId}?role=operations-manager`)).body;
  check('old device state is revoked', oldRow?.state === 'revoked');

  const newRow = (await api('GET', `/api/devices/${newDeviceId}?role=operations-manager`)).body;
  check('replacement device exists in quarantine', newRow?.state === 'quarantine' && newRow?.site_id === siteId);

  // The same old client certificate must now be rejected.
  const oldHb = await api('POST', '/api/heartbeat', null, oldDevice.mtls);
  check('old certificate rejected on next heartbeat', oldHb.status === 403,
    `status=${oldHb.status} body=${JSON.stringify(oldHb.body)}`);

  // step-ca itself should refuse to renew the revoked certificate.
  const renewRes = await request(`${CA}/1.0/renew`, {
    method: 'POST',
    dispatcher: oldDevice.mtls,
    headers: { 'content-type': 'application/json' },
  });
  check('step-ca refuses renewal of revoked cert', renewRes.statusCode === 401 || renewRes.statusCode === 403,
    `status=${renewRes.statusCode}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} device-swap E2E checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('device swap E2E crashed:', e); process.exit(1); });
