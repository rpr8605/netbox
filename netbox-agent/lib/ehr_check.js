// netbox-agent/lib/ehr_check.js
// Responsibility: the EHR/EMR check orchestrator — loads one per-site config
// profile (EHR spec §2's "config profile, not new code"), dispatches each
// check entry to exactly one of the four protocol adapters, and emits one
// canonical check_result event per entry via post_event.js.
// Called by: scripts/test_ehr_unit.js, scripts/test_ehr_e2e.js today;
// wiring the agent daemon's periodic loop is a separate follow-on (graph.js,
// backup_risk.js have the same standalone pattern tonight).
//
// STATUS MAPPING — the whole-vendor semantic lives here, not per-adapter:
//   net checks     : down / degraded / verified_ready(TLS) / reachable(cleartext)
//   fhir           : down / degraded; verified_ready (metadata only); active
//                    (metadata + scoped read 200); unknown (token/auth deficit)
//   mirth          : down / unknown (session/credential deficit); active (all
//                    channels STARTED); degraded (mixed/zero channels)
// 'unknown' is reserved for config deficits so an operator never pages on them
// — a district console shows degraded/down only for things that are actually
// down. Confidence is derived: 'low' for unknown, 'high' for direct reads.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { runNetCheck } from './net_checks.js';
import { runFhirCheck } from './fhir_r4.js';
import { runMirthCheck } from './mirth_admin.js';
import { postEvent } from './post_event.js';

const ADAPTERS = { net: runNetCheck, fhir: runFhirCheck, mirth: runMirthCheck };

// loadProfile — parse + validate one config profile document. Throws on ANY
// structural violation rather than skipping entries: a profile is site
// onboarding data compiled into behavior, and a malformed entry that silently
// no-checks would read as "everything healthy" on the console. Fields:
// profile_id, vendor, vendor_note (optional text), checks[] each with
// name/service/adapter/params + optional enabled (default true).
export function loadProfile(profileOrPath) {
  let p = profileOrPath;
  if (typeof profileOrPath === 'string') {
    p = JSON.parse(fs.readFileSync(profileOrPath, 'utf8'));
  }
  if (!p || typeof p !== 'object') throw new Error('profile: not an object');
  if (typeof p.profile_id !== 'string' || !p.profile_id) throw new Error('profile: profile_id required');
  if (typeof p.vendor !== 'string' || !p.vendor) throw new Error('profile: vendor required');
  if (!Array.isArray(p.checks) || p.checks.length === 0) throw new Error('profile: checks must be a non-empty array');
  for (const c of p.checks) {
    if (typeof c.name !== 'string' || !c.name) throw new Error(`profile ${p.profile_id}: check missing name`);
    if (typeof c.service !== 'string' || !c.service) throw new Error(`profile ${p.profile_id}:${c.name}: service required`);
    if (!ADAPTERS[c.adapter]) throw new Error(`profile ${p.profile_id}:${c.name}: unknown adapter '${c.adapter}'`);
    if (c.params == null || typeof c.params !== 'object') throw new Error(`profile ${p.profile_id}:${c.name}: params required`);
  }
  return p;
}

// Derive a per-check confidence enum. 'unknown' != an observation, so 'low';
// every real read is 'high'. Kept centralized so the mapping can't fragment.
function confidenceOf(status) {
  return status === 'unknown' ? 'low' : 'high';
}

// One adapter run + one canonical event. channel_id (topology grouping) is
// attached when the adapter surfaces a stable channel name — today that is
// Mirth (observed.channel_name). Additional fields (detail/observed) ride
// through because the schema is additionalProperties:true; the server's
// validate is still the authority.
async function emitCheck(ctx, check, result, post) {
  const ev = {
    event_id: crypto.randomUUID(),
    device_id: ctx.deviceId,
    site_id: ctx.siteId,
    occurred_at: new Date().toISOString(),
    kind: 'check_result',
    service: check.service,
    status: result.status,
    latency_ms: Math.max(0, Math.round(result.latency_ms ?? 0)),
    confidence: confidenceOf(result.status),
    freshness_s: 0,
    phi_mode: false,
    detail: result.detail,
    observed: result.observed,
    adapter: check.adapter,
    check_name: check.name,
  };
  const channelId = result.observed?.channel_name ?? null;
  if (channelId) ev.channel_id = channelId;
  if (result.tier) ev.tier_observed = result.tier;
  return post(ev);
}

// runProfile — executes all enabled checks, emits one event per check, and
// returns a compact summary for the caller/log. A disabled entry is SKIPPED
// by design (Epic Community Connect ships with FHIR disabled until the parent
// org grants API creds, EHR spec §5; flag was approved during onboarding).
export async function runProfile(ctx, profile, { post = postEvent, logger = console.log } = {}) {
  const summary = [];
  for (const check of profile.checks) {
    if (check.enabled === false) {
      logger(`ehr_check: skip disabled ${check.name} (${check.adapter})`);
      summary.push({ check: check.name, skipped: true });
      continue;
    }
    const adapter = ADAPTERS[check.adapter];
    const result = await adapter(check.params);
    const postRes = await emitCheck(ctx, check, result, post);
    logger(`ehr_check: ${check.service}/${check.name} -> ${result.status} (${result.detail}) [post ${postRes?.status ?? 'mocked'}]`);
    summary.push({
      check: check.name, service: check.service, adapter: check.adapter,
      status: result.status, tier: result.tier ?? null, detail: result.detail,
      post_status: postRes?.status ?? 'mocked',
    });
  }
  return { profile_id: profile.profile_id, vendor: profile.vendor, results: summary };
}
