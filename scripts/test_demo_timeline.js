#!/usr/bin/env node
// scripts/test_demo_timeline.js — unit tests for the scripted incident timeline.
// Verifies the required demo scenarios are present and that delays compress
// correctly for fast test runs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline } from './demo_timeline.js';
import { buildDemoSites } from './demo_seed.js';

describe('demo timeline', () => {
  it('covers the five required incident scenarios', () => {
    const sites = buildDemoSites();
    const steps = buildTimeline(sites, 600_000);
    const descs = steps.map(s => s.desc);
    assert.ok(descs.some(d => /channel stall|lab down/i.test(d)), 'interface channel stall');
    assert.ok(descs.some(d => /TLS|cert/i.test(d)), 'TLS cert near expiry');
    assert.ok(descs.some(d => /WAN|primary|backup/i.test(d)), 'WAN flap');
    assert.ok(descs.some(d => /DNS/i.test(d)), 'DNS failure');
    assert.ok(descs.some(d => /similar|memory/i.test(d)), 'incident memory');
  });

  it('compresses to a short duration for tests', () => {
    const sites = buildDemoSites();
    const steps = buildTimeline(sites, 5_000);
    assert.ok(steps.length > 0);
    const last = steps[steps.length - 1];
    assert.ok(last.at <= 5_000, `last step at ${last.at} exceeds compressed duration`);
  });

  it('steps are ordered by at timestamp', () => {
    const sites = buildDemoSites();
    const steps = buildTimeline(sites, 60_000);
    for (let i = 1; i < steps.length; i++) {
      assert.ok(steps[i].at >= steps[i - 1].at, 'steps are non-decreasing');
    }
  });

  it('rejects fewer than 6 sites', () => {
    assert.throws(() => buildTimeline(buildDemoSites().slice(0, 3), 60_000), /at least 6 demo sites/);
  });
});
