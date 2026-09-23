#!/usr/bin/env node
// scripts/demo.js — one-command demo orchestrator.
// Starts the docker-compose stack, seeds synthetic hospitals, keeps the device
// simulator alive, and plays the ~10-minute incident timeline.
import { spawn } from 'node:child_process';
import { request, Agent } from '../control-plane/node_modules/undici/index.js';
import { seedDemoSites } from './demo_seed.js';
import { runTimeline } from './demo_timeline.js';

const CP = process.env.CONTROL_PLANE_URL ?? 'https://localhost:10443';
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

async function api(method, path, body) {
  const res = await request(`${CP}${path}`, {
    method, dispatcher: insecure,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.statusCode, body: parsed ?? text };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', env: process.env, ...opts });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)));
    p.on('error', reject);
  });
}

async function waitForControlPlane(attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await api('GET', '/api/health');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('control plane did not become healthy');
}

async function main() {
  process.env.DEMO_MODE = '1';

  console.log('[demo] starting stack...');
  await run('docker', ['compose', 'up', '-d', 'step-ca', 'control-plane']);

  console.log('[demo] waiting for control plane...');
  await waitForControlPlane();

  console.log('[demo] seeding synthetic hospitals...');
  await seedDemoSites();

  console.log('[demo] starting device simulator in demo loop...');
  // Start device-sim with DEMO_MODE=1 so it posts periodic heartbeats.
  await run('docker', ['compose', 'up', '-d', 'device-sim']);

  console.log('[demo] starting incident timeline (press Ctrl-C to stop)...');
  console.log('[demo] open https://localhost:10443/fleet.html?demo=1 for the Fleet Map');
  const args = process.argv.slice(2);
  const durationIndex = args.indexOf('--duration-seconds');
  const durationSeconds = durationIndex !== -1 ? Number(args[durationIndex + 1]) : 600;

  await runTimeline({ durationSeconds });

  console.log('[demo] timeline finished; device-sim is still running.');
  console.log('[demo] stop with: docker compose down');
}

main().catch(e => { console.error(e); process.exit(1); });
