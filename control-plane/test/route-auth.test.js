#!/usr/bin/env node
// control-plane/test/route-auth.test.js
// Verifies finding H3: every Fastify route declares an auth policy. The policy
// is one of: 'device' (device mTLS), 'operator:<perm>' (RBAC preHandler), or
// 'public' (explicitly unauthenticated). The test builds the route tree and
// fails on any route missing a declared policy.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import enrollRoutes from '../src/routes/enroll.js';
import deviceRoutes from '../src/routes/devices.js';
import eventRoutes from '../src/routes/events.js';
import retrustRoutes from '../src/routes/retrust.js';
import channelRoutes from '../src/routes/channels.js';
import alertRoutes from '../src/routes/alerts.js';
import supportRoutes from '../src/routes/support.js';
import topologyViewRoutes from '../src/routes/topology_view.js';
import releaseRoutes from '../src/routes/releases.js';
import actionRegistryRoutes from '../src/routes/action_registry.js';

describe('H3 — every route declares an auth policy', () => {
  let app;
  const routes = [];

  before(async () => {
    app = Fastify({ logger: false });
    app.config = {
      twilio: {}, ses: {}, sendgrid: {}, webhook: {},
    };
    app.addHook('onRoute', (routeOptions) => {
      // Fastify auto-registers a HEAD route for every GET. The HEAD sibling
      // inherits the same handler/options, so we only assert on the explicit
      // methods in the test output.
      if (routeOptions.method === 'HEAD') return;
      routes.push({ method: routeOptions.method, url: routeOptions.url, config: routeOptions.config });
    });
    await app.register(enrollRoutes);
    await app.register(deviceRoutes);
    await app.register(eventRoutes);
    await app.register(retrustRoutes);
    await app.register(channelRoutes);
    await app.register(alertRoutes);
    await app.register(supportRoutes);
    await app.register(topologyViewRoutes);
    await app.register(releaseRoutes);
    await app.register(actionRegistryRoutes);
    // Static file route and health/audit/demo are registered below so the test
    // covers the whole surface.
    app.get('/fleet.html', { config: { auth: 'operator:topology:rollup' } }, async () => 'ok');
    app.get('/api/health', { config: { auth: 'public' } }, async () => ({ ok: true }));
    app.get('/api/demo', { config: { auth: 'public' } }, async () => ({ demo: false }));
    app.get('/api/audit', { config: { auth: 'operator:audit:read' } }, async () => []);
    await app.ready();
  });

  it('has no route without a declared auth policy', () => {
    const missing = routes.filter(r => !r.config?.auth);
    assert.deepEqual(
      missing.map(r => `${r.method} ${r.url}`),
      [],
      `routes missing config.auth: ${missing.map(r => `${r.method} ${r.url}`).join(', ')}`,
    );
  });

  it('declares sensible policies for the known ungated routes', () => {
    const byUrl = Object.fromEntries(routes.map(r => [r.url, r.config?.auth]));
    assert.equal(byUrl['/api/alert-rules'], 'operator:alerts:rules:write', 'POST alert-rules gated');
    assert.equal(byUrl['/api/alert-contacts'], 'operator:alerts:rules:write', 'POST alert-contacts gated');
    assert.equal(byUrl['/api/support/sessions/:id/close'], 'operator:support:request', 'support close gated');
    assert.equal(byUrl['/api/devices'], 'operator:devices:read', 'device list gated');
    assert.equal(byUrl['/api/devices/:id'], 'operator:devices:read', 'device detail gated');
    assert.equal(byUrl['/api/alerts'], 'operator:alerts:read', 'alert list gated');
    assert.equal(byUrl['/api/channels'], 'operator:channels:read', 'channel list gated');
    assert.equal(byUrl['/api/sites/:id/topology'], 'operator:topology:read', 'topology gated');
    assert.equal(byUrl['/api/sites/:id/full-status'], 'operator:topology:read', 'full-status gated');
    assert.equal(byUrl['/api/support/sessions/:id'], 'operator:support:request', 'support read gated');
  });
});
