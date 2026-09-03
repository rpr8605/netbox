#!/usr/bin/env node
// scripts/test_step1_signals.js — Step 1 demo harness (DEV/TEST ONLY).
// Mocks the agent-side emit so NO mTLS or control plane is needed. Runs:
//  A. one valid security_signal event via schema -> OK (gated payload path)
//  B. same event but `status` set -> /api/events EXPECTED 400 (route ring gate)
//  C. Graph: admin-create + after-hours-signIn mocked responses -> payloads
//  D. Backup: Tier 1 proxy (segment_match+realm_match), Tier 2 api registered
//     PLUS unregistered/absent proof (was, no-emit) — all mocked fetch.
// Prints raw request/response bodies for inspection.
import Ajv from '../control-plane/node_modules/ajv/dist/ajv.js';
import addFormats from '../control-plane/node_modules/ajv-formats/dist/index.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { emitSecuritySignal } from '../netbox-agent/lib/signal_emit.js';
import { setMockPostEvent } from '../netbox-agent/lib/post_event.js';
import { runGraphSignals } from '../netbox-agent/lib/graph.js';
import { checkBackupProxyTier1, checkBackupApiTier2 } from '../netbox-agent/lib/backup_risk.js';

const schema = JSON.parse(fs.readFileSync('schemas/netbox_event.schema.json', 'utf8'));
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

// --- DEV MOCK: route lib/post_event.js's postEvent through a capture buffer.
const posts = [];
setMockPostEvent(async (ev) => { posts.push(ev); return { status: 202, body: ev }; });

function sample(kind, extra = {}) {
  return { event_id: crypto.randomUUID(),
           device_id: crypto.randomUUID(),
           site_id: crypto.randomUUID(),
           occurred_at: new Date().toISOString(),
           kind, service: 'custom', tier_observed: 'L0',
           latency_ms: 12, confidence: 'high', freshness_s: 2,
           phi_mode: false, ...extra };
}

async function runSchemaCases() {
  console.log('--- A. valid security_signal gated payload ---');
  const good = sample('security_signal', {
    signal: 'unusual',
    severity: 'warn',
    security_signal_payload: {
      signal: 'unusual', severity: 'warn',
      source: 'graph-audit',
      basis: 'admin account created via audit hook',
      observed: { upn: 'admin@hosp', at: 'x' },
    } });
  const ok = validate(good);
  console.log('schema validate:', ok);
  if (!ok) console.log('errors:', validate.errors);

  console.log('--- B. security_signal WITH status (route-level 400) ---');
  const bad = { ...good, status: 'reachable' };
  const { status, body } = await routeAdapterbad(bad);
  console.log('route response:', status, body);
}
// Simulates the route rule directly (events.js gate): a 400 iff status included
// and kind is security_signal; else 202 Ajv-validate fallthrough.
async function routeAdapterbad(ev) {
  if (ev.kind === 'security_signal' && ev.status !== undefined) {
    return { status: 400, body: { error: "security_signal events must not carry `status`" } };
  }
  return { status: 200, body: { accepted: true } };
}

async function runGraphCase() {
  console.log('--- C. Graph mock: admin create & after-hours sign-in ---');
  async function mockFetch(method, url) {
    if (method === 'POST' && /login\.microsoftonline\.com/.test(url)) return { access_token: 'mock' };
    if (method === 'GET' && /directoryAudits/.test(url)) return {
      value: [{ activityDisplayName: 'Add user',
                targetResources: [{ userPrincipalName: 'admin@hosp' }],
                activityDateTime: new Date(Date.now() - 3600e3).toISOString() }]
    };
    if (method === 'GET' && /signIns/.test(url)) return {
      value: [{ createdDateTime: '2026-08-31T23:10:00Z',
                userPrincipalName: 'late@hosp', appDisplayName: 'VPN' }]
    };
    return {};
  }
  // Pull a token + pull each of the two tails, then emit via our mockPost.
  const ctx = { deviceId: crypto.randomUUID(), siteId: crypto.randomUUID(),
                site_hours: [[18, 24], [0, 6]] };
  await runGraphSignals(ctx, mockFetch);
  console.log('graph signals posted:', JSON.stringify(posts.filter(p =>
      p.kind === 'security_signal').map(({ kind, signal, severity,
      security_signal_payload }) => ({ kind, signal, severity,
      security_signal_payload })), null, 2));
}

async function runBackupCases() {
  console.log('--- D. Backup-risk mock ---');
  // Tier1: segment_match && realm_match ⇒ advisory (proxy reason string).
  const ctx = { deviceId: 'd', siteId: 's',
                backup_destination: { segment_match: true, realm_match: true,
                  ip: '10.1.2.5', realm: 'prodrealm' } };
  await checkBackupProxyTier1(ctx);
  console.log('tier1 emitted:', posts.at(-1)?.security_signal_payload);

  // Tier2 (verified): integration_registered=true + API HEAD 200+verify_imm_u.
  const ctx2 = { deviceId: 'd', siteId: 's',
                 backup_vendor: { integration_registered: true, name: 'Veeam',
                   integration_endpoint: 'mock://api/v', verify_imm_u: true } };
  await checkBackupApiTier2(ctx2, async (ep) => ({ status: 200, endpoint: ep }));
  console.log('tier2 emitted:', posts.at(-1)?.security_signal_payload);

  // Unregistered ⇒ should NOT emit (no new posts since previous one).
  const before = posts.length;
  await checkBackupApiTier2({ deviceId: 'd', siteId: 's',
    backup_vendor: { integration_registered: false, name: 'Veeam' } });
  console.log('tier2 unregistered posted delta:', posts.length - before, '(expected 0)');
}

await runSchemaCases();
await runGraphCase();
await runBackupCases();
console.log('=== summary: posts emitted ===');
console.log(posts.map(p => `${p.kind}/${p.signal}`).join('\n'));
