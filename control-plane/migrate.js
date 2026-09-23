#!/usr/bin/env node
// control-plane/migrate.js
// One-shot migration from the legacy SQLite file to PostgreSQL.
// Idempotent: rows with the same primary key are skipped (ON CONFLICT DO NOTHING).
// Safe to run before the control-plane starts; it exits cleanly when either the
// source SQLite file or the target DATABASE_URL is missing.
import Database from 'better-sqlite3';
import pg from 'pg';
import fs from 'node:fs';
import { PG_SCHEMA, PG_ALTER_COLUMNS } from './src/schema.js';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const DB_PATH = process.env.DB_PATH ?? '/data/beacon-relay.db';

if (!DATABASE_URL) {
  console.log('migrate: DATABASE_URL not set; nothing to migrate.');
  process.exit(0);
}

if (!fs.existsSync(DB_PATH)) {
  console.log(`migrate: SQLite source ${DB_PATH} not found; nothing to migrate.`);
  process.exit(0);
}

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

const sqlite = new Database(DB_PATH, { readonly: true });

const pgClient = new Client({ connectionString: DATABASE_URL });
await pgClient.connect();

try {
  // Ensure the target schema exists before copying rows. The control-plane
  // will also ensure this on boot, but migration runs first.
  await pgClient.query(PG_SCHEMA);
  await pgClient.query(PG_ALTER_COLUMNS);

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

  await pgClient.query('COMMIT');
  console.log(`migrate: completed; ${total} rows copied.`);
} catch (err) {
  await pgClient.query('ROLLBACK');
  console.error('migrate: failed:', err.message);
  process.exit(1);
} finally {
  await pgClient.end();
  sqlite.close();
}
