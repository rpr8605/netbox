#!/usr/bin/env node
// control-plane/test/enroll.security.test.js
// Verifies finding C2: enrollment-token creation is gated and safe.
//   - existing device_id refused unless re_enroll=true
//   - active device_id always refused (never downgraded)
//   - new device_id allowed, state set to quarantine
// The actual HTTP preHandler gate is tested via the alerting/RBAC integration
// suite; this unit test covers the policy helper that the route uses.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('C2 — enrollment token policy', () => {
  it('allows new devices and sets quarantine state', async () => {
    const { enrollmentTokenPolicy } = await import('../src/routes/enroll.js');
    const r = enrollmentTokenPolicy('new-device', null, false);
    assert.ok(r.ok, 'new device allowed');
    assert.equal(r.state, 'quarantine', 'new device starts in quarantine');
  });

  it('refuses an existing device without explicit re-enroll flag', async () => {
    const { enrollmentTokenPolicy } = await import('../src/routes/enroll.js');
    const r = enrollmentTokenPolicy('existing-device', { state: 'quarantine', device_key_fp: 'abc' }, false);
    assert.ok(!r.ok, 'existing device refused without re_enroll');
    assert.equal(r.code, 409, 'returns conflict');
  });

  it('refuses an active device even with re-enroll flag', async () => {
    const { enrollmentTokenPolicy } = await import('../src/routes/enroll.js');
    const r = enrollmentTokenPolicy('active-device', { state: 'active', device_key_fp: 'abc' }, true);
    assert.ok(!r.ok, 'active device refused');
    assert.equal(r.code, 409, 'returns conflict');
  });

  it('allows re-enroll of a non-active device without touching state or key fp', async () => {
    const { enrollmentTokenPolicy } = await import('../src/routes/enroll.js');
    const r = enrollmentTokenPolicy('quarantined-device', { state: 'quarantine', device_key_fp: 'abc' }, true);
    assert.ok(r.ok, 'quarantined device allowed to re-enroll');
    assert.equal(r.state, 'quarantine', 'state is preserved, not downgraded');
    assert.equal(r.deviceKeyFp, 'abc', 'existing key fingerprint is preserved');
  });
});
