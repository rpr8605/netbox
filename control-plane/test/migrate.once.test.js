#!/usr/bin/env node
// control-plane/test/migrate.once.test.js
// Verifies that the SQLite -> PostgreSQL migration is truly one-shot:
//   - a marker row in Postgres prevents re-runs
//   - the SQLite source is renamed to *.migrated on success
//   - a row deleted in Postgres after migration is NOT resurrected when the
//     migration script is invoked again (simulating a container restart).
// Requires: a running PostgreSQL reachable via DATABASE_URL (defaults to the
// local compose instance). Creates and drops an isolated test database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Database from 'better-sqlite3';

const { Client } = pg;

const BASE_DATABASE_URL = process.env.DATABASE_URL;
if (!BASE_DATABASE_URL) {
  throw new Error('DATABASE_URL must be set to run migration safety tests');
}
const TEST_DB_NAME = 'beacon_relay_migration_test';

function rewriteDbName(urlString, dbName) {
  const url = new URL(urlString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

const maintenanceUrl = rewriteDbName(BASE_DATABASE_URL, 'postgres');
const testDbUrl = rewriteDbName(BASE_DATABASE_URL, TEST_DB_NAME);
const MIGRATE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrate.js');
const MIGRATE_CWD = path.dirname(MIGRATE_SCRIPT);

describe('SQLite-to-PostgreSQL migration safety', () => {
  let tmpDir;
  let sqlitePath;
  let maintenanceClient;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-migrate-test-'));
    sqlitePath = path.join(tmpDir, 'legacy.db');
    maintenanceClient = new Client({ connectionString: maintenanceUrl });
    await maintenanceClient.connect();
    await maintenanceClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await maintenanceClient.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  });

  after(async () => {
    try {
      await maintenanceClient?.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    } catch { /* ignore cleanup errors */ }
    await maintenanceClient?.end();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs once, renames the SQLite file, and never resurrects deleted rows', async () => {
    // Seed a minimal legacy SQLite file with one device.
    const sqlite = new Database(sqlitePath);
    sqlite.exec(`
      CREATE TABLE devices (
        device_id      TEXT PRIMARY KEY,
        site_id        TEXT NOT NULL,
        state          TEXT NOT NULL,
        cert_serial    TEXT,
        cert_not_after TEXT,
        device_key_fp  TEXT,
        enrolled_at    TEXT,
        last_seen_at   TEXT,
        created_at     TEXT NOT NULL DEFAULT '2024-01-01'
      );
    `);
    const deviceId = crypto.randomUUID();
    sqlite.prepare('INSERT INTO devices (device_id, site_id, state) VALUES (?, ?, ?)')
      .run(deviceId, 'site-test', 'active');
    sqlite.close();

    const env = { ...process.env, DATABASE_URL: testDbUrl, DB_PATH: sqlitePath };

    // First migration: copy row, record marker, rename source file.
    const out1 = execFileSync(process.execPath, [MIGRATE_SCRIPT], { cwd: MIGRATE_CWD, env, encoding: 'utf8' });
    assert.ok(out1.includes('completed'), 'first migration reports completion');
    assert.ok(out1.includes(`${sqlitePath}.migrated`), 'first migration reports source rename');
    assert.ok(!fs.existsSync(sqlitePath), 'original SQLite file is gone');
    assert.ok(fs.existsSync(`${sqlitePath}.migrated`), 'SQLite file renamed to .migrated');

    // Verify the device arrived in Postgres, then delete it.
    const pgClient = new Client({ connectionString: testDbUrl });
    await pgClient.connect();
    const migrated = await pgClient.query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    assert.equal(migrated.rowCount, 1, 'migrated device is present in Postgres');
    await pgClient.query('DELETE FROM devices WHERE device_id = $1', [deviceId]);
    const deleted = await pgClient.query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    assert.equal(deleted.rowCount, 0, 'device was deleted in Postgres');
    await pgClient.end();

    // Simulate a restart with the legacy file restored (e.g. a volume snapshot
    // or admin mistake). The marker row must prevent re-import.
    fs.copyFileSync(`${sqlitePath}.migrated`, sqlitePath);
    const out2 = execFileSync(process.execPath, [MIGRATE_SCRIPT], { cwd: MIGRATE_CWD, env, encoding: 'utf8' });
    assert.ok(out2.includes('marker sqlite_to_postgres_v1 already present'), 'second run skips because marker exists');

    // The deleted row must remain deleted.
    const pgClient2 = new Client({ connectionString: testDbUrl });
    await pgClient2.connect();
    const afterRestart = await pgClient2.query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    assert.equal(afterRestart.rowCount, 0, 'deleted device is NOT resurrected after restart');
    await pgClient2.end();
  });
});
