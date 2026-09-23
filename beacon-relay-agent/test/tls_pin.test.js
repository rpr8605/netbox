#!/usr/bin/env node
// beacon-relay-agent/test/tls_pin.test.js
// Verifies finding H1: the device pins the step-ca root and refuses to talk
// to a control plane whose certificate is signed by any other CA.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import forge from '../../control-plane/node_modules/node-forge/lib/index.js';

function makeCaAndCert(cn) {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date(Date.now() + 3600_000);
  caCert.setSubject([{ name: 'commonName', value: `${cn}-ca` }]);
  caCert.setIssuer([{ name: 'commonName', value: `${cn}-ca` }]);
  caCert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 3600_000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: `${cn}-ca` }]);
  cert.setExtensions([{
    name: 'subjectAltName',
    altNames: [{ type: 2, value: cn }],
  }]);
  cert.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    ca: forge.pki.certificateToPem(caCert),
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function startServer(cert, key, port) {
  return new Promise(resolve => {
    const srv = https.createServer({ cert, key }, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

describe('H1 — device pins control-plane CA', () => {
  let goodServer;
  let badServer;
  let goodCa;
  let badCa;
  const goodPort = 18321;
  const badPort = 18322;

  before(async () => {
    goodCa = makeCaAndCert('control-plane');
    badCa = makeCaAndCert('wrong-ca');
    goodServer = await startServer(goodCa.cert, goodCa.key, goodPort);
    badServer = await startServer(badCa.cert, badCa.key, badPort);
  });

  after(() => {
    goodServer?.close();
    badServer?.close();
  });

  it('connects when the server cert chains to the pinned CA', async () => {
    process.env.CA_ROOT_PEM = goodCa.ca;
    process.env.CP_SERVERNAME = 'control-plane';
    const { api } = await import('../lib/tls_pin.js');
    const r = await api('GET', `https://127.0.0.1:${goodPort}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it('rejects a server cert signed by a different CA', async () => {
    process.env.CA_ROOT_PEM = goodCa.ca;
    process.env.CP_SERVERNAME = 'control-plane';
    const { api } = await import('../lib/tls_pin.js');
    const r = await api('GET', `https://127.0.0.1:${badPort}/health`);
    assert.notEqual(r.status, 200, 'wrong-CA request must not succeed');
    assert.ok(r.body?.error || r.status === 0, 'wrong-CA request returns an error');
  });
});
