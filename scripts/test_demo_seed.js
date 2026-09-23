#!/usr/bin/env node
// scripts/test_demo_seed.js — unit tests for the synthetic demo hospital seed.
// Verifies count, geography, naming convention, and absence of PHI-shaped data.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoSites, baselineEvents, buildDemoAlertRules } from './demo_seed.js';

const PHI_LIKE = /\b\d{3}-\d{2}-\d{4}\b|\b\d{3}-\d{3}-\d{4}\b|\b\d{2}\/\d{2}\/\d{4}\b|\b\d{9,10}\b|\bMRN\b|\bSSN\b|\bDOB\b/i;

describe('demo seed', () => {
  it('creates 4-6 hospitals in MO/KS', () => {
    const sites = buildDemoSites();
    assert.ok(sites.length >= 4 && sites.length <= 6, `expected 4-6 sites, got ${sites.length}`);
    for (const s of sites) {
      assert.ok(s.lat >= 36 && s.lat <= 40, 'latitude in MO/KS range');
      assert.ok(s.lng >= -99 && s.lng <= -89, 'longitude in MO/KS range');
    }
  });

  it('uses Demo County Memorial style fictional names', () => {
    const sites = buildDemoSites();
    for (const s of sites) {
      assert.ok(s.name.includes('Demo') || /County|Regional|Medical|Community|Health|Center/i.test(s.name),
        `name looks synthetic: ${s.name}`);
      assert.ok(!PHI_LIKE.test(s.name), 'name contains no PHI-like tokens');
    }
  });

  it('uses deterministic site and device IDs', () => {
    const sites = buildDemoSites();
    const ids = new Set();
    for (const s of sites) {
      assert.ok(s.site_id.startsWith('demo-site-'));
      assert.ok(s.device_id.startsWith('demo-device-'));
      ids.add(s.site_id);
      ids.add(s.device_id);
    }
    assert.equal(ids.size, sites.length * 2, 'all IDs unique');
  });

  it('baseline events are metadata-only and demo-labeled', () => {
    const sites = buildDemoSites();
    const events = baselineEvents(sites[0]);
    assert.ok(events.length > 0);
    for (const e of events) {
      assert.equal(e.phi_mode, false);
      assert.equal(e.kind, 'check_result');
      assert.ok(e.detail);
      assert.ok(!PHI_LIKE.test(JSON.stringify(e)), 'event has no PHI-like tokens');
    }
  });

  it('alert rules have plain-language impact statements', () => {
    const rules = buildDemoAlertRules();
    assert.ok(rules.length > 0);
    for (const r of rules) {
      assert.ok(r.impact_stmt);
      assert.ok(!/tcp|udp|port \d|icmp|econnrefused/i.test(r.impact_stmt), 'impact is plain language');
      assert.ok(!PHI_LIKE.test(r.impact_stmt), 'impact has no PHI-like tokens');
    }
  });
});
