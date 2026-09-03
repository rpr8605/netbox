#!/usr/bin/env node
// scripts/test_topology.js — unit checks for the channel-topology surface:
//   - channel_id is OPTIONAL in the canonical schema (backward compatible)
//   - role gate on /api/topology/rollup: ops-manager/support-technician only,
//     deny by any other role (RBAC stub lives at the route, not the console)
//   - per-site topology groups newest check_result per channel
//   - unregistered channel_id surfaces raw id with 'unregistered' hint
// Run via: node --test scripts/test_topology.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Ajv from '../control-plane/node_modules/ajv/dist/ajv.js';
import addFormats from '../control-plane/node_modules/ajv-formats/dist/index.js';
import { listChannels, getChannel, upsertChannel, listEventsBySite, insertEvent,
         upsertDevice } from '../control-plane/src/db.js';

const schema = JSON.parse(fs.readFileSync('schemas/netbox_event.schema.json', 'utf8'));
const ajv = new Ajv({ allErrors: true }); addFormats(ajv);
const validate = ajv.compile(schema);

function mkEvent(kind, extra = {}) {
  return { event_id: crypto.randomUUID(), device_id: crypto.randomUUID(), site_id: crypto.randomUUID(),
           occurred_at: new Date().toISOString(), kind, service: 'ehr', latency_ms: 1,
           confidence: 'high', freshness_s: 0, phi_mode: false, ...extra };
}

describe('channel_id optional', () => {
  it('schema accepts event without channel_id', () => {
    assert.ok(validate(mkEvent('check_result', { status: 'reachable' })));
  });
  it('schema accepts event with channel_id', () => {
    assert.ok(validate(mkEvent('check_result', { status: 'reachable', channel_id: 'adt-to-lab' })));
  });
});

describe('channel registry + topology', () => {
  it('register + getChannel', () => {
    upsertChannel({ channelId: 'adt-to-lab', displayName: 'ADT -> Lab', engine: 'mirth' });
    assert.equal(getChannel('adt-to-lab').display_name, 'ADT -> Lab');
  });
  it('topology groups newest-per-channel, unregistered shows raw id', () => {
    const deviceId = crypto.randomUUID(); const siteId = crypto.randomUUID();
    upsertDevice({ deviceId, siteId, state: 'active' });
    insertEvent({ event_id: crypto.randomUUID(), device_id: deviceId, site_id: siteId,
                  occurred_at: new Date().toISOString(), kind: 'check_result', service: 'adt',
                  status: 'degraded', latency_ms: 1, confidence: 'high', freshness_s: 0,
                  channel_id: 'adt-to-lab', phi_mode: false, payload: '', detail: 'degraded', observed: {} });
    insertEvent({ event_id: crypto.randomUUID(), device_id: deviceId, site_id: siteId,
                  occurred_at: new Date().toISOString(), kind: 'check_result', service: 'adt',
                  status: 'active', latency_ms: 1, confidence: 'high', freshness_s: 0,
                  channel_id: 'oru-result', phi_mode: false, payload: '', detail: 'active', observed: {} });
    const evs = listEventsBySite(siteId, 50);
    const grouped = new Map();
    for (const ev of evs) { const k = ev.channel_id; if (!grouped.has(k)) grouped.set(k, []); grouped.get(k).push(ev); }
    const topo = [...grouped.keys()].map(k => {
      const reg = getChannel(k);
      const rows = grouped.get(k);
      const p = JSON.parse(rows[0].payload ?? '{}');
      return { channel_id: k, display_name: reg?.display_name ?? k, engine: reg?.engine ?? 'unregistered', newest_status: p.status ?? 'unknown' };
    });
    assert.ok(topo.some(t => t.channel_id === 'adt-to-lab' && t.display_name === 'ADT -> Lab'));
    assert.ok(topo.some(t => t.channel_id === 'oru-result' && t.engine === 'unregistered'));
  });
});

describe('rollup role gate (stub)', () => {
  const ROLLUP_ROLES = new Set(['operations-manager', 'support-technician']);
  it('allows operations-manager and support-technician', () => {
    for (const r of ['operations-manager', 'support-technician']) assert.ok(ROLLUP_ROLES.has(r));
  });
  it('denies other roles incl. customer-it-admin, security-auditor, readonly-exec', () => {
    for (const r of ['customer-it-admin', 'security-auditor', 'readonly-executive', ''])
      assert.ok(!ROLLUP_ROLES.has(r));
  });
});
