#!/usr/bin/env node
// control-plane/migrate.js
// One-shot migration from the legacy SQLite file to PostgreSQL.
// Idempotent: rows with the same primary key are skipped (ON CONFLICT DO NOTHING).
// Guarded by a marker row in Postgres so the migration runs exactly once per
// database, even if the SQLite file is still present on subsequent boots.
// After a successful migration the SQLite file is renamed to *.migrated so it
// cannot be re-imported accidentally.
// Safe to run before the control-plane starts; it exits cleanly when either the
// source SQLite file or the target DATABASE_URL is missing.
import Database from 'better-sqlite3';
import pg from 'pg';
import fs from 'node:fs';
import { PG_SCHEMA, PG_ALTER_COLUMNS } from './src/schema.js';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const DB_PATH = process.env.DB_PATH ?? '/data/beacon-relay.db';
const MIGRATION_ID = 'sqlite_to_postgres_v1';

if (!DATABASE_URL) {
  console.log('migrate: DATABASE_URL not set; nothing to migrate.');
  process.exit(0);
}

if (!fs.existsSync(DB_PATH)) {
  console.log(`migrate: SQLite source ${DB_PATH} not found; nothing to migrate.`);
  process.exit(0);
}

const MIGRATED_PATH = `${DB_PATH}.migrated`;

// Tables in an order that respects foreign-key relationships where they exist.
const TABLES = [
  'devices',
  'sites',
  'device_replacements',
  'enrollment_tokens',
  'retrust_challenges',
  'channels',
  'events',
  'audit_log',
  'alert_rules',
  'alert_contacts',
  'alerts',
  'incident_signatures',
  'resolution_records',
  'rollouts',
  'action_registry',
  'support_sessions',
  'revoked_serials',
];

const pgClient = new Client({ connectionString: DATABASE_URL });
await pgClient.connect();

try {
  // Ensure the target schema exists before copying rows. The control-plane
  // will also ensure this on boot, but migration runs first.
  await pgClient.query(PG_SCHEMA);
  await pgClient.query(PG_ALTER_COLUMNS);

  // Guard: only run the migration once per Postgres database. This is the
  // primary safety control; the *.migrated rename below is a defense-in-depth
  // measure on disk.
  const markerRes = await pgClient.query(
    'SELECT 1 FROM schema_migrations WHERE migration_id = $1',
    [MIGRATION_ID]
  );
  if (markerRes.rowCount > 0) {
    console.log(`migrate: marker ${MIGRATION_ID} already present; skipping.`);
    process.exit(0);
  }

  const sqlite = new Database(DB_PATH, { readonly: true });

  await pgClient.query('BEGIN');
  let total = 0;

  for (const table of TABLES) {
    // Table may be empty or missing in an old SQLite file.
    let columns;
    try {
      columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    } catch {
      console.log(`migrate: skipping missing table ${table}`);
      continue;
    }
    if (columns.length === 0) continue;

    const colList = columns.map(c => `"${c}"`).join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const insertSql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    for (const row of rows) {
      const values = columns.map(c => row[c] ?? null);
      await pgClient.query(insertSql, values);
    }
    console.log(`migrate: ${table} ${rows.length} rows`);
    total += rows.length;
  }

  // Record that the migration completed successfully. This must happen inside
  // the same transaction as the data copy so a failed commit never records a
  // false completion.
  await pgClient.query(
    'INSERT INTO schema_migrations (migration_id, applied_at) VALUES ($1, NOW()::TEXT)',
    [MIGRATION_ID]
  );

  await pgClient.query('COMMIT');
  sqlite.close();

  // Defense in depth: after the transaction commits, atomically rename the
  // source SQLite file so a later process cannot read it back in even if the
  // marker check were somehow bypassed.
  fs.renameSync(DB_PATH, MIGRATED_PATH);
  console.log(`migrate: completed; ${total} rows copied; source renamed to ${MIGRATED_PATH}.`);
} catch (err) {
  try { await pgClient.query('ROLLBACK'); } catch { /* rollback can fail if no transaction */ }
  console.error('migrate: failed:', err.message);
  process.exit(1);
} finally {
  await pgClient.end();
}
