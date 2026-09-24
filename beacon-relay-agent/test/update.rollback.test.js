#!/usr/bin/env node
// beacon-relay-agent/test/update.rollback.test.js
// Verifies finding H2: the OTA update cycle must NOT mark the current (old)
// slot good/bad before rebooting. The correct flow is:
//   check -> download -> verify -> install -> reboot
// After reboot into the NEW slot:
//   health-check-pass -> mark-good on the booted (new) slot
//   health-check-fail -> mark-bad on the booted (new) slot, then reboot
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;

describe('H2 — OTA rollback targets the booted slot after reboot', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-update-test-'));
    process.env.BEACON_DATA_DIR = tmpDir;
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.BEACON_DATA_DIR;
  });

  it('runUpdateCycle installs and requests reboot, never touches slots in-cycle', async () => {
    const { runUpdateCycle } = await import('../lib/update.js');
    const calls = [];
    const r = await runUpdateCycle(
      { cpBase: 'https://cp', currentVersion: '0.1.0', deviceId: 'd1' },
      {
        fetchJson: async () => ({ version: '1.2.3' }),
        fetchBytes: async () => Buffer.from('bundle'),
        verifyBundleFn: () => true,
        applyBundleFn: () => { calls.push('apply'); return { ok: true }; },
        markGoodFn: () => { calls.push('mark-good'); return true; },
        rollbackFn: () => { calls.push('mark-bad'); return true; },
        healthCheckFn: async () => { calls.push('health-check'); return { healthy: true }; },
      },
    );
    assert.equal(r.action, 'installed-pending-reboot', `expected pending-reboot, got ${r.action}`);
    assert.deepEqual(calls, ['apply'], 'only applyBundle should run in-cycle');
  });

  it('post-boot health-check success marks the booted slot good', async () => {
    const { finishUpdateBoot } = await import('../lib/update.js');
    const calls = [];
    const r = await finishUpdateBoot(
      { cpBase: 'https://cp', deviceId: 'd1' },
      {
        healthCheckFn: async () => { calls.push('health-check'); return { healthy: true }; },
        markGoodFn: () => { calls.push('mark-good'); return true; },
        rollbackFn: () => { calls.push('mark-bad'); return true; },
        rebootFn: () => { calls.push('reboot'); },
      },
    );
    assert.equal(r.action, 'boot-marked-good', r.action);
    assert.deepEqual(calls, ['health-check', 'mark-good'], 'health check then mark-good on booted slot');
  });

  it('post-boot health-check failure marks the booted slot bad and reboots', async () => {
    const { finishUpdateBoot } = await import('../lib/update.js');
    const calls = [];
    const r = await finishUpdateBoot(
      { cpBase: 'https://cp', deviceId: 'd1' },
      {
        healthCheckFn: async () => { calls.push('health-check'); return { healthy: false, detail: 'no cp' }; },
        markGoodFn: () => { calls.push('mark-good'); return true; },
        rollbackFn: () => { calls.push('mark-bad'); return true; },
        rebootFn: () => { calls.push('reboot'); },
      },
    );
    assert.equal(r.action, 'boot-rolled-back', r.action);
    assert.deepEqual(calls, ['health-check', 'mark-bad', 'reboot'], 'health check fails, mark-bad booted slot, reboot');
  });
});
