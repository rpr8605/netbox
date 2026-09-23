#!/usr/bin/env node
// scripts/demo_reset.js — stop the demo stack and remove local state so the
// next demo starts from a clean synthetic dataset.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

console.log('[demo] stopping docker compose stack...');
const down = spawnSync('docker', ['compose', 'down', '-v'], { stdio: 'inherit', shell: true });
if (down.status !== 0) process.exit(down.status ?? 1);

const dataDir = path.resolve(process.cwd(), 'data');
if (fs.existsSync(dataDir)) {
  console.log(`[demo] removing local data directory: ${dataDir}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('[demo] reset complete');
