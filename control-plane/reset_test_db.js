#!/usr/bin/env node
// scripts/reset_test_db.js
// Resets the test database. When DATABASE_URL is set, drops and recreates an
// isolated Postgres database. When DATABASE_URL is not set (SQLite / zero-ops
// local tests), removes the on-disk SQLite file if configured, or no-ops when
// tests use an in-memory database.
import fs from 'node:fs';
import pg from 'pg';

const { Client } = pg;

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  // SQLite / zero-ops path: delete the on-disk file if one is configured,
  // otherwise there is nothing to reset (tests use :memory:).
  const dbPath = process.env.DB_PATH;
  if (dbPath && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log(`reset_test_db: removed SQLite file ${dbPath}`);
  } else {
    console.log('reset_test_db: DATABASE_URL not set; SQLite tests are self-isolating');
  }
  process.exit(0);
}

function rewriteDbName(urlString, dbName) {
  const url = new URL(urlString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

const testDbUrl = new URL(baseUrl);
const testDbName = testDbUrl.pathname.replace(/^\//, '') || 'beacon_relay_test';
const maintenanceUrl = rewriteDbName(baseUrl, 'postgres');

const client = new Client({ connectionString: maintenanceUrl });
await client.connect();
try {
  // Terminate any existing connections to the test database before dropping it.
  await client.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = $1
      AND pid <> pg_backend_pid()
  `, [testDbName]);
  await client.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  await client.query(`CREATE DATABASE ${testDbName}`);
  console.log(`reset_test_db: recreated ${testDbName}`);
} catch (err) {
  console.error('reset_test_db: failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
