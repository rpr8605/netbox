#!/usr/bin/env node
// control-plane/test/token.consumption.test.js
// Verifies finding M3: enrollment-token and retrust-challenge consumption is
// atomic. A single UPDATE ... RETURNING statement consumes the row; a second
// consecutive call must see the row as already used and return null.
//
// This test also asserts the implementation issues exactly ONE SQL statement
// per consumption, proving the SELECT-then-UPDATE race window is gone.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createEnrollmentToken, consumeEnrollmentToken,
  createRetrustChallenge, consumeRetrustChallenge,
  db,
} from '../src/db.js';

describe('M3 — atomic token/challenge consumption', () => {
  let queryCount;
  let driverRestore = null;

  before(() => {
    // Patch the active driver's statement function so we can count statements.
    // Postgres exposes `db.query`; SQLite exposes `db.prepare`. Both are async
    // enough for our purposes (SQLite prepare is synchronous, but the test only
    // needs to count invocations).
    if (db.query) {
      const originalQuery = db.query.bind(db);
      db.query = async (...args) => {
        queryCount += 1;
        return originalQuery(...args);
      };
      driverRestore = () => { db.query = originalQuery; };
    } else if (db.prepare) {
      const originalPrepare = db.prepare.bind(db);
      db.prepare = (...args) => {
        queryCount += 1;
        return originalPrepare(...args);
      };
      driverRestore = () => { db.prepare = originalPrepare; };
    }
  });

  after(() => {
    driverRestore?.();
  });

  it('consumes an enrollment token with a single SQL statement', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').slice(0, 19);
    await createEnrollmentToken({ tokenHash, deviceId, siteId: 'site-test', expiresAt });

    queryCount = 0;
    const first = await consumeEnrollmentToken(tokenHash);
    assert.ok(first, 'first consumption returns the row');
    assert.equal(first.device_id, deviceId, 'row has the right device');
    assert.equal(queryCount, 1, 'consumption must use exactly one SQL statement');

    const second = await consumeEnrollmentToken(tokenHash);
    assert.equal(second, null, 'second consumption returns null');
  });

  it('consumes a retrust challenge with a single SQL statement', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;
    const challenge = crypto.randomBytes(32).toString('base64url');
    const challengeHash = crypto.createHash('sha256').update(challenge).digest('hex');
    await createRetrustChallenge({ challengeHash, deviceId });

    queryCount = 0;
    const first = await consumeRetrustChallenge(challengeHash, deviceId);
    assert.ok(first, 'first consumption returns the row');
    assert.equal(first.device_id, deviceId, 'row has the right device');
    assert.equal(queryCount, 1, 'consumption must use exactly one SQL statement');

    const second = await consumeRetrustChallenge(challengeHash, deviceId);
    assert.equal(second, null, 'second consumption returns null');
  });
});
