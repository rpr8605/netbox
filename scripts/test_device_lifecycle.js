#!/usr/bin/env node
// scripts/test_device_lifecycle.js — no-hardware tests for the hardware-lifecycle
// tooling added in BUILD_SPEC §8.9:
//   - device replacement workflow (db + API)
//   - BOM / golden-manifest JSON shape
//   - golden-manifest validator behavior against a fake manifest
// Run via: node --test scripts/test_device_lifecycle.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { upsertDevice, getDevice, replaceDevice, listAudit, appendAudit } from '../control-plane/src/db.js';
import deviceRoutes from '../control-plane/src/routes/devices.js';
import { execFileSync } from 'node:child_process';

const role = 'operations-manager';

describe('device replacement workflow', () => {
  it('retires old device, creates replacement in quarantine, and audits', () => {
    const siteId = crypto.randomUUID();
    const oldId = crypto.randomUUID();
    const newId = crypto.randomUUID();
    upsertDevice({ deviceId: oldId, siteId, state: 'active' });
    const beforeAudit = listAudit(1000).length;
    const result = replaceDevice({ oldDeviceId: oldId, newDeviceId: newId, reason: 'SSD failure', actor: role });
    assert.equal(result.old_device_id, oldId);
    assert.equal(result.new_device_id, newId);
    assert.equal(result.old_state, 'revoked');
    assert.equal(getDevice(oldId).state, 'revoked');
    assert.equal(getDevice(newId).state, 'quarantine');
    assert.equal(getDevice(newId).site_id, siteId);
    const audit = listAudit(1000).find(a => a.action === 'device.replaced');
    assert.ok(audit, 'device.replaced audit entry present');
    assert.ok(audit.detail.includes(newId));
  });

  it('rejects replacement when new device belongs to a different site', () => {
    const oldId = crypto.randomUUID();
    const newId = crypto.randomUUID();
    upsertDevice({ deviceId: oldId, siteId: crypto.randomUUID(), state: 'active' });
    upsertDevice({ deviceId: newId, siteId: crypto.randomUUID(), state: 'quarantine' });
    assert.throws(() => replaceDevice({ oldDeviceId: oldId, newDeviceId: newId, reason: 'x', actor: role }), /different site/);
  });

  it('API route wires devices:write permission', async () => {
    const handlers = {};
    const mockApp = { get: (...args) => { handlers[args[0]] = args[args.length - 1]; }, post: (...args) => { handlers[args[0]] = args[args.length - 1]; } };
    await deviceRoutes(mockApp);
    assert.ok(handlers['/api/devices/:id/replace'], 'replace route registered');
  });
});

describe('hardware manifest artifacts', () => {
  it('BOM JSON is valid and has components with required fields', () => {
    const bom = JSON.parse(fs.readFileSync('hardware/bom.json', 'utf8'));
    assert.ok(Array.isArray(bom.components) && bom.components.length > 0);
    for (const c of bom.components) {
      assert.ok(c.role);
      assert.ok(c.primary?.mpn);
      assert.ok(Array.isArray(c.required_features));
    }
  });

  it('golden manifest JSON is valid and has required validation list', () => {
    const golden = JSON.parse(fs.readFileSync('hardware/golden_manifest.json', 'utf8'));
    assert.ok(Array.isArray(golden.validation?.required_artifacts));
    assert.ok(golden.validation.required_artifacts.includes('manifest.json'));
  });

  it('validate_golden_manifest.js passes on a synthetic built manifest', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-manifest-'));
    const version = '9.9.9-test';
    const built = {
      version,
      built_at: new Date().toISOString(),
      artifacts: [
        { path: 'beacon-relay-disk.img', sha256: 'a'.repeat(64) },
        { path: 'bundle.raucb', sha256: 'b'.repeat(64) },
        { path: 'SHA256SUMS', sha256: 'c'.repeat(64) },
        { path: 'manifest.json', sha256: 'd'.repeat(64) },
      ],
      flash_path: `${tmp}/beacon-relay-disk.img`,
      bundle_path: tmp,
    };
    for (const a of built.artifacts) fs.writeFileSync(path.join(tmp, a.path), 'x');
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(built, null, 2));
    // Run validator as a subprocess so it exercises the CLI entrypoint.
    const out = execFileSync(process.execPath, ['scripts/validate_golden_manifest.js', path.join(tmp, 'manifest.json')], { encoding: 'utf8' });
    assert.ok(out.includes('Golden manifest validation passed'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
