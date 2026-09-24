#!/usr/bin/env node
// control-plane/test/dev-auth.security.test.js
// Verifies the dev-auth stub contract:
//   1. X-Dev-Role / ?role= are honored ONLY when CONSOLE_DEV_AUTH=1 and
//      NODE_ENV !== 'production'.
//   2. With dev auth off, both header and query role are ignored and the
//      RBAC gate denies with 403.
//   3. With NODE_ENV=production and CONSOLE_DEV_AUTH=1, the server refuses to
//      start (module-level throw).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, 'fixtures', 'dev-auth-minimal-server.js');

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      const url = stdout.trim();
      if (url.startsWith('http://')) {
        resolve({ proc, url });
      }
    });
    proc.stderr.on('data', (d) => {
      // suppress dev-auth warning noise during the test run
    });
    proc.on('error', reject);
    setTimeout(() => {
      proc.kill();
      reject(new Error('server did not start in time'));
    }, 5000);
  });
}

async function httpGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const body = await res.text();
  return { status: res.status, body };
}

describe('dev-auth stub security', () => {
  it('ignores X-Dev-Role and ?role= when CONSOLE_DEV_AUTH is off', async () => {
    const { proc, url } = await startServer({ CONSOLE_DEV_AUTH: '0' });
    try {
      const noAuth = await httpGet(`${url}/api/gated`);
      assert.equal(noAuth.status, 403, 'no auth should 403');

      const header = await httpGet(`${url}/api/gated`, { 'X-Dev-Role': 'operations-manager' });
      assert.equal(header.status, 403, 'X-Dev-Role should be ignored when dev auth off');

      const query = await httpGet(`${url}/api/gated?role=operations-manager`);
      assert.equal(query.status, 403, '?role= should be ignored when dev auth off');
    } finally {
      proc.kill();
    }
  });

  it('honors X-Dev-Role and ?role= when CONSOLE_DEV_AUTH=1', async () => {
    const { proc, url } = await startServer({ CONSOLE_DEV_AUTH: '1', NODE_ENV: 'test' });
    try {
      const defaultRole = await httpGet(`${url}/api/gated`);
      assert.equal(defaultRole.status, 200, 'default role should allow devices:read');

      const header = await httpGet(`${url}/api/gated`, { 'X-Dev-Role': 'support-technician' });
      assert.equal(header.status, 200, 'support-technician should be allowed via header');

      const query = await httpGet(`${url}/api/gated?role=support-technician`);
      assert.equal(query.status, 200, 'support-technician should be allowed via query');

      const unknown = await httpGet(`${url}/api/gated`, { 'X-Dev-Role': 'attacker' });
      assert.equal(unknown.status, 403, 'unknown role should be denied');
    } finally {
      proc.kill();
    }
  });

  it('refuses to start in production with CONSOLE_DEV_AUTH=1', async () => {
    const proc = spawn(process.execPath, [
      '--input-type=module', '-e',
      "import './src/auth/dev_auth.js'; console.log('started');",
    ], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'production', CONSOLE_DEV_AUTH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const code = await new Promise((resolve) => proc.on('close', resolve));
    assert.notEqual(code, 0, 'process should exit with an error');
    assert.match(stderr, /CONSOLE_DEV_AUTH=1 is not allowed in production/);
  });
});
