#!/usr/bin/env node
// scripts/reset_test_db.js
// Resets the PostgreSQL test database named by DATABASE_URL.
// Drops and recreates an isolated database so test suites start from a clean schema.
import pg from 'pg';

const { Client } = pg;

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('reset_test_db: DATABASE_URL is required (SQLite support removed in SQLITE-1/M6)');
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
