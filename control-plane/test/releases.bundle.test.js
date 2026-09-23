#!/usr/bin/env node
// control-plane/test/releases.bundle.test.js
// Verifies finding M5: the bundle download route applies the same revocation
// and state checks as the event-ingestion path (deviceFromCert). A revoked
// device must be refused before it can pull a signed bundle.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { upsertDevice } from '../src/db.js';
import { bundleHandler } from '../src/routes/releases.js';

function makeReq(deviceId) {
  return {
    params: { version: '1.2.3' },
    socket: {
      authorized: true,
      getPeerCertificate: () => ({ subject: { CN: deviceId }, serialNumber: '01' }),
    },
  };
}

function makeReply() {
  const reply = {
    statusCode: null,
    payload: null,
    code(n) { this.statusCode = n; return this; },
    send(v) { this.payload = v; return this; },
    header() { return this; },
  };
  return reply;
}

describe('M5 — bundle download reuses deviceFromCert checks', () => {
  it('returns 403 for a revoked device', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;
    await upsertDevice({ deviceId, siteId: 'site-test', state: 'revoked' });
    const req = makeReq(deviceId);
    const reply = makeReply();
    await bundleHandler(req, reply);
    assert.equal(reply.statusCode, 403, `expected 403, got ${reply.statusCode}: ${JSON.stringify(reply.payload)}`);
  });

  it('returns 404 (not 403) for an active device when no bundle exists', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;
    await upsertDevice({ deviceId, siteId: 'site-test', state: 'active' });
    const req = makeReq(deviceId);
    const reply = makeReply();
    await bundleHandler(req, reply);
    assert.equal(reply.statusCode, 404, `expected 404, got ${reply.statusCode}: ${JSON.stringify(reply.payload)}`);
  });
});
