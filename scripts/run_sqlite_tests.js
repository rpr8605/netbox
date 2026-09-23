#!/usr/bin/env node
// scripts/run_sqlite_tests.js
// Cross-platform runner for the SQLite-only unit tests.
// Windows `set DATABASE_URL=&&` does not work on macOS/Linux; this wrapper
// unsets DATABASE_URL and runs the selected test files against the SQLite
// fallback driver.
import { spawnSync } from 'node:child_process';

const files = [
  'scripts/test_device_lifecycle.js',
  'scripts/test_topology.js',
];

const env = { ...process.env, NODE_ENV: 'test' };
delete env.DATABASE_URL;

const result = spawnSync(
  process.execPath,
  ['--test', ...files],
  { env, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
