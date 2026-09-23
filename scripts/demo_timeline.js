#!/usr/bin/env node
// scripts/demo_timeline.js — scripted ~10-minute incident timeline for the demo.
// Exports buildTimeline() for unit testing and runTimeline() for runtime.
import { request, Agent } from '../control-plane/node_modules/undici/index.js';
import forge from '../control-plane/node_modules/node-forge/lib/index.js';
import { demoEvent, buildDemoSites, baselineEvents } from './demo_seed.js';

const CP = process.env.CONTROL_PLANE_URL ?? 'https://localhost:10443';
const CA = process.env.CA_URL ?? 'https://localhost:9000';
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

async function api(method, path, body, agent = insecure) {
  const res = await request(`${CP}${path}`, {
    method, dispatcher: agent,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.statusCode, body: parsed ?? text };
}

// Re-enroll a deterministic demo device so the timeline can post events for it.
async function enrollDemoDevice(site) {
  const tok = await api('POST', '/api/enroll/tokens', {
    device_id: site.device_id, site_id: site.site_id, name: site.name, lat: site.lat, lng: site.lng,
  });
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const redeem = await api('POST', '/api/enroll/redeem', {
    enrollment_token: tok.body.enrollment_token,
    public_key_pem: forge.pki.publicKeyToPem(keys.publicKey),
  });
  const rootsRes = await request(`${CA}/roots.pem`, { dispatcher: insecure });
  const rootsPem = await rootsRes.body.text();
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: site.device_id }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const signRes = await request(`${CA}/1.0/sign`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ csr: forge.pki.certificationRequestToPem(csr), ott: redeem.body.step_ca.ott }),
    dispatcher: insecure,
  });
  const signBody = JSON.parse(await signRes.body.text());
  const chain = `${signBody.crt ?? signBody.cert}\n${signBody.ca ?? ''}`;
  const mtls = new Agent({ connect: { rejectUnauthorized: false, ca: rootsPem, cert: chain, key: keyPem } });
  const hb = await api('POST', '/api/heartbeat', null, mtls);
  if (hb.status !== 200) throw new Error(`heartbeat failed: ${JSON.stringify(hb.body)}`);
  await api('POST', `/api/devices/${site.device_id}/confirm?role=operations-manager`);
  return { mtls, deviceId: site.device_id, siteId: site.site_id };
}

// Build a deterministic incident timeline. The default duration is 10 minutes;
// callers can override for fast test runs.
export function buildTimeline(sites, durationMs = 10 * 60 * 1000) {
  if (!sites || sites.length < 6) throw new Error('timeline needs at least 6 demo sites');
  const s1 = sites[0]; // lab channel stall
  const s2 = sites[1]; // TLS cert near expiry
  const s3 = sites[2]; // WAN flap
  const s4 = sites[3]; // DNS failure
  const s5 = sites[4]; // incident memory (closed lab incident)
  const s6 = sites[5]; // final recovery stage

  const pct = p => Math.round(durationMs * p);
  const steps = [];
  const push = (p, desc, fn) => steps.push({ at: pct(p), desc, fn });

  // 0% — baseline already seeded; reinforce a healthy heartbeat.
  push(0.00, 'baseline healthy', async ({ agents }) => {
    for (const dev of Object.values(agents)) {
      await api('POST', '/api/heartbeat', null, dev.mtls);
    }
  });

  // 5% — interface channel stall on site 1.
  push(0.05, 'interface channel stall: lab down', async ({ agents }) => {
    const dev = agents[s1.site_id];
    await postEvent(dev, demoEvent(dev.deviceId, dev.siteId, { service: 'lab', status: 'down', check_name: 'lab-fhir', adapter: 'fhir', channel_id: 'oru-result', detail: 'Mirth channel oru-result state STOPPED' }));
    await postEvent(dev, demoEvent(dev.deviceId, dev.siteId, { service: 'pharmacy', status: 'degraded', check_name: 'meds-flow', adapter: 'net', channel_id: 'meds-to-pharmacy', detail: 'Mirth channel meds-to-pharmacy destination ERROR' }));
  });

  // 10% — fire the lab alert for the stalled channel.
  push(0.10, 'fire lab alert', async ({ rules }) => {
    const rule = rules.find(r => r.service === 'lab');
    await api('POST', '/api/alerts/fire?role=operations-manager', { rule_id: rule.rule_id, device_id: s1.device_id, site_id: s1.site_id });
  });

  // 20% — TLS cert near expiry on site 2.
  push(0.20, 'TLS certificate near expiry', async ({ agents, rules }) => {
    const dev = agents[s2.site_id];
    await postEvent(dev, demoEvent(dev.deviceId, dev.siteId, { service: 'cert_expiration', status: 'degraded', check_name: 'tls-soon-cert', adapter: 'net', detail: 'Certificate expires in 7 day(s)' }));
    const rule = rules.find(r => r.service === 'cert_expiration');
    await api('POST', '/api/alerts/fire?role=operations-manager', { rule_id: rule.rule_id, device_id: s2.device_id, site_id: s2.site_id });
  });

  // 30% — WAN flap on site 3.
  push(0.30, 'WAN primary circuit down, backup active', async ({ agents }) => {
    const dev = agents[s3.site_id];
    await postEvent(dev, demoEvent(dev.deviceId, dev.siteId, { service: 'internet', status: 'degraded', tier: 'L1', check_name: 'wan-failover', adapter: 'net', detail: 'WAN primary down; backup circuit active' }));
  });

  // 40% — WAN recovery.
  push(0.40, 'WAN primary recovered', async ({ agents }) => {
    const dev = agents[s3.site_id];
    await postEvent(dev, demoEvent(dev.deviceId, dev.siteId, { service: 'internet', status: 'active', tier: 'L3', check_name: 'wan', adapter: 'net', detail: 'WAN primary up' }));
  });

  // 50% — DNS failure alert on site 4.
  push(0.50, 'DNS resolver failure', async ({ agents, rules }) => {
    const dev = agents[s4.site_id];
    await postEvent(dev, demoEvent(dev.deviceId, dev.siteId, { service: 'dns', status: 'down', check_name: 'dns', adapter: 'net', detail: 'DNS resolver unreachable' }));
    const rule = rules.find(r => r.service === 'dns');
    await api('POST', '/api/alerts/fire?role=operations-manager', { rule_id: rule.rule_id, device_id: s4.device_id, site_id: s4.site_id });
  });

  // 60% — create a closed lab-down incident on site 5 so the memory bank has a match.
  push(0.60, 'seed closed incident for memory', async ({ agents, rules }) => {
    const dev = agents[s5.site_id];
    await postEvent(dev, demoEvent(dev.deviceId, dev.siteId, { service: 'lab', status: 'down', check_name: 'lab-fhir', adapter: 'fhir', channel_id: 'oru-result', detail: 'Mirth channel oru-result state STOPPED' }));
    const rule = rules.find(r => r.service === 'lab');
    const fired = await api('POST', '/api/alerts/fire?role=operations-manager', { rule_id: rule.rule_id, device_id: s5.device_id, site_id: s5.site_id });
    const alertId = fired.body?.alertId;
    await api('POST', `/api/alerts/${alertId}/close?role=operations-manager`, {
      root_cause_category: 'interface-engine-deadlock',
      action_taken: 'restarted HL7 listener via Action Registry entry',
      actor: 'demo-operator',
    });
  });

  // 70% — trigger the same lab-down pattern on site 1 again and ask for similar incidents.
  push(0.70, 'similar incident memory lookup', async ({ agents, rules }) => {
    const dev = agents[s1.site_id];
    await postEvent(dev, demoEvent(dev.deviceId, dev.siteId, { service: 'lab', status: 'down', check_name: 'lab-fhir', adapter: 'fhir', channel_id: 'oru-result', detail: 'Mirth channel oru-result state STOPPED again' }));
    const rule = rules.find(r => r.service === 'lab');
    const fired = await api('POST', '/api/alerts/fire?role=operations-manager', { rule_id: rule.rule_id, device_id: s1.device_id, site_id: s1.site_id });
    const alertId = fired.body?.alertId;
    const similar = await api('GET', `/api/alerts/${alertId}/similar?role=operations-manager`);
    console.log(`[demo] similar incidents found: ${similar.body?.summary?.count ?? 0}`);
  });

  // 80% — start recovery across affected sites.
  push(0.80, 'recover DNS and lab channels', async ({ agents }) => {
    const devDns = agents[s4.site_id];
    await postEvent(devDns, demoEvent(devDns.deviceId, devDns.siteId, { service: 'dns', status: 'active', tier: 'L3', check_name: 'dns', adapter: 'net', detail: 'DNS resolver responding' }));
    const devLab = agents[s1.site_id];
    await postEvent(devLab, demoEvent(devLab.deviceId, devLab.siteId, { service: 'lab', status: 'active', tier: 'L3', check_name: 'lab-fhir', adapter: 'fhir', channel_id: 'oru-result', detail: 'Lab flow recovered' }));
    await postEvent(devLab, demoEvent(devLab.deviceId, devLab.siteId, { service: 'pharmacy', status: 'active', tier: 'L3', check_name: 'meds-flow', adapter: 'net', channel_id: 'meds-to-pharmacy', detail: 'Pharmacy interface recovered' }));
  });

  // 95% — final all-clear baseline refresh on the last site.
  push(0.95, 'all-clear baseline refresh', async ({ agents }) => {
    const dev = agents[s6.site_id];
    for (const e of baselineEvents(s6)) {
      await postEvent(dev, e);
    }
  });

  return steps;
}

async function postEvent(dev, ev) {
  await request(`${CP}/api/events`, {
    method: 'POST', dispatcher: dev.mtls,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ev),
  });
}

export async function runTimeline({ durationSeconds = 600, onStep = null } = {}) {
  const sites = buildDemoSites();
  const agents = {};
  for (const site of sites) {
    agents[site.site_id] = await enrollDemoDevice(site);
  }
  // Fetch rules created by the seed step.
  const rulesRes = await api('GET', '/api/alert-rules?role=operations-manager');
  const rules = rulesRes.body ?? [];
  const steps = buildTimeline(sites, durationSeconds * 1000);
  const ctx = { agents, rules, sites };

  let nextIndex = 0;
  const start = Date.now();
  while (nextIndex < steps.length) {
    const elapsed = Date.now() - start;
    const step = steps[nextIndex];
    if (elapsed >= step.at) {
      console.log(`[demo] ${new Date().toISOString()} — ${step.desc}`);
      try {
        await step.fn(ctx);
        if (onStep) onStep({ step, ok: true });
      } catch (e) {
        console.error(`[demo] step failed: ${step.desc}`, e.message);
        if (onStep) onStep({ step, ok: false, error: e.message });
      }
      nextIndex++;
    } else {
      await new Promise(r => setTimeout(r, Math.min(500, step.at - elapsed)));
    }
  }
  console.log('[demo] timeline complete');
}

async function main() {
  const args = process.argv.slice(2);
  const durationIndex = args.indexOf('--duration-seconds');
  const durationSeconds = durationIndex !== -1 ? Number(args[durationIndex + 1]) : 600;
  const health = await api('GET', '/api/health');
  if (health.status !== 200) throw new Error('control plane unreachable — run `docker compose up -d step-ca control-plane` first');
  console.log(`[demo] running scripted incident timeline for ${durationSeconds}s`);
  await runTimeline({ durationSeconds });
}

import path from 'node:path';
const { fileURLToPath } = await import('url');
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(e); process.exit(1); });
}
