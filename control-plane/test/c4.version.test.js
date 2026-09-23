#!/usr/bin/env node
// control-plane/test/c4.version.test.js
// Verifies finding C4: OTA version strings are strictly validated both on the
// control-plane rollout-creation path and on the device update-client path.
// A malicious version such as "1;touch /tmp/pwned;#" must be rejected before
// it can reach the filesystem, a shell command, or a network request.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('C4 — OTA version validation', () => {
  it('server rejects a malicious version on rollout create', async () => {
    const { isValidReleaseVersion } = await import('../../control-plane/src/routes/releases.js');
    assert.ok(isValidReleaseVersion('1.2.3'), 'plain semver is valid');
    assert.ok(isValidReleaseVersion('1.2.3-alpha.1'), 'semver with pre-release is valid');
    assert.ok(!isValidReleaseVersion('1;touch /tmp/pwned;#'), 'shell metacharacters rejected');
    assert.ok(!isValidReleaseVersion('../etc/passwd'), 'path traversal rejected');
    assert.ok(!isValidReleaseVersion('1.2'), 'too short rejected');
  });

  it('device rejects a malicious version and never downloads or verifies it', async () => {
    const { validateVersion, runUpdateCycle } = await import('../../beacon-relay-agent/lib/update.js');
    assert.ok(validateVersion('1.2.3'), 'plain semver is valid');
    assert.ok(!validateVersion('1;touch /tmp/pwned;#'), 'shell metacharacters rejected');

    // runUpdateCycle must bail out before calling fetchBytes when version is bad.
    let fetchBytesCalled = false;
    let verifyCalled = false;
    const r = await runUpdateCycle(
      { cpBase: 'https://cp', currentVersion: '0.1.0', deviceId: 'd1' },
      {
        fetchJson: async () => ({ version: '1;touch /tmp/pwned;#' }),
        fetchBytes: async () => { fetchBytesCalled = true; return Buffer.alloc(0); },
        verifyBundleFn: () => { verifyCalled = true; return true; },
        applyBundleFn: () => ({ ok: true }),
        healthCheckFn: async () => ({ healthy: true }),
      },
    );
    assert.ok(r.action === 'rejected' || r.reason.includes('version'), `expected version rejection, got ${JSON.stringify(r)}`);
    assert.ok(!fetchBytesCalled, 'fetchBytes must not be called for invalid version');
    assert.ok(!verifyCalled, 'verifyBundle must not be called for invalid version');
  });

  it('device fetchBytes fails closed on non-200 status', async () => {
    const { runUpdateCycle } = await import('../../beacon-relay-agent/lib/update.js');
    const r = await runUpdateCycle(
      { cpBase: 'https://cp', currentVersion: '0.1.0', deviceId: 'd1' },
      {
        fetchJson: async () => ({ version: '1.2.3' }),
        fetchBytes: async () => { throw new Error('bundle download failed: 404'); },
        verifyBundleFn: () => true,
      },
    );
    assert.ok(r.action === 'rejected' || r.action === 'install-failed' || r.reason?.includes('404'),
      `expected failure after non-200 fetch, got ${JSON.stringify(r)}`);
  });
});
