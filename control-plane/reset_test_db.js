#!/usr/bin/env node
// scripts/reset_test_db.js
// Drops and recreates an isolated Postgres database for the test suites.
// Run before `node --test` when DATABASE_URL points at the test database.
// Expects DATABASE_URL to be set; the test DB name is taken from the path of
// DATABASE_URL, and the maintenance connection is derived by rewriting the
// database name to 'postgres'.
import pg from 'pg';

const { Client } = pg;

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('reset_test_db: DATABASE_URL is not set');
  process.exit(1);
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
