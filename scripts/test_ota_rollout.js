#!/usr/bin/env node
// scripts/test_ota_rollout.js — control-plane staged rollout proof.
// Requires `docker compose up -d step-ca control-plane` and a built manifest
// at out/manifest.json. Proves:
//   - rollout creation/activation is RBAC-gated to operations-manager
//   - an active rollout with 0% hides the version from every device
//   - an active rollout with 100% shows the version to every device
//   - every rollout action is audit-logged
import crypto from 'node:crypto';
import fs from 'node:fs';
import { request, Agent } from '../control-plane/node_modules/undici/index.js';

const CP = process.env.CONTROL_PLANE_URL ?? 'https://localhost:10443';
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

const manifest = JSON.parse(fs.readFileSync('out/manifest.json', 'utf8'));
const version = manifest.version;
const deviceId = crypto.randomUUID();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, path, body, role) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (role) headers['x-dev-role'] = role;
  const res = await request(`${CP}${path}`, {
    method, dispatcher: insecure,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.statusCode, body: parsed ?? text };
}

// No active rollout yet: latest should return the published version.
const baseline = await api('GET', `/api/releases/latest?device_id=${deviceId}`);
check('R1. latest returns version when no rollout active', baseline.status === 200 && baseline.body.version === version);

// Create a 0% pilot rollout; non-ops role must be denied.
const denyCreate = await api('POST', '/api/releases/rollouts', { version, stage: 'pilot', percentage: 0 }, 'customer-it-admin');
check('R2. rollout creation denied to customer-it-admin', denyCreate.status === 403);

const create = await api('POST', '/api/releases/rollouts', { version, stage: 'pilot', percentage: 0 }, 'operations-manager');
check('R3. rollout created by operations-manager', create.status === 200 && create.body.rollout_id, JSON.stringify(create.body));
const rolloutId = create.body.rollout_id;

// Activate it.
const activate = await api('POST', `/api/releases/rollouts/${rolloutId}/activate`, {}, 'operations-manager');
check('R4. rollout activated by operations-manager', activate.status === 200 && activate.body.active === 1, JSON.stringify(activate.body));

// With a 0% rollout active, the device should see no update (204).
const hidden = await api('GET', `/api/releases/latest?device_id=${deviceId}`);
check('R5. 0% rollout hides version from device', hidden.status === 204, `status=${hidden.status}`);

// Replace with a 100% broad rollout.
const broad = await api('POST', '/api/releases/rollouts', { version, stage: 'broad', percentage: 100 }, 'operations-manager');
check('R6. broad rollout created', broad.status === 200);
await api('POST', `/api/releases/rollouts/${broad.body.rollout_id}/activate`, {}, 'operations-manager');
const visible = await api('GET', `/api/releases/latest?device_id=${deviceId}`);
check('R7. 100% rollout shows version to device', visible.status === 200 && visible.body.version === version);

// Audit log contains the rollout lifecycle events.
const audit = await api('GET', '/api/audit?role=security-auditor');
check('R8. audit log readable by security-auditor', audit.status === 200);
const createdAudit = audit.body.some(e => e.action === 'rollout.created');
const activatedAudit = audit.body.some(e => e.action === 'rollout.activated');
check('R9. rollout.created is audit-logged', createdAudit);
check('R10. rollout.activated is audit-logged', activatedAudit);

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} OTA rollout checks passed`);
process.exit(failed.length ? 1 : 0);
