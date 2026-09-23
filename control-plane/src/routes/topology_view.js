// control-plane/src/routes/topology_view.js
// Responsibility: the per-site "full status" view model for the Fleet Console
// demo (spec §7). One call returns everything the topology view needs:
//   - the critical-service register (every service enum, not just channels)
//    with each service's latest observed status + the check that produced it
//   - the interface-engine channel topology (from the channel registry +
//     newest check_result per channel)
//   - recent check_results for the detail panel's rule-based rendering
//
// RULE-BASED, NOT GENERATIVE: this view model returns STRUCTURED FACTS ONLY.
// The detail panel renders them deterministically — no prose about WHY a node
// is down, no inferred root cause. (EHR spec §11: explanation is Handoff's
// job, not Beacon Relay's.) The "co-occurring signals" list is a mechanical
// co-occurrence: other nodes at the SAME site currently degraded/down,
// presented as facts without asserting causation.
import crypto from 'node:crypto';
import { listEventsBySite, listChannels, getChannel, listSites } from '../db.js';
import { can } from '../rbac.js';
import { appendAudit } from '../db.js';

// The critical-service register — the canonical schema's service enum is the
// register of record. Ordered by operational criticality for display.
const CRITICAL_SERVICES = ['ehr', 'adt', 'lab', 'pharmacy', 'imaging', 'eprescribe', 'internet', 'phone', 'printing', 'custom', 'cert_expiration', 'firewall', 'dns', 'wan', 'm365_account_health'];

// Static tier meanings — the L0-L4 definitions from spec §3, as display text.
// Rule-based: this is a lookup table, not generated narration.
export const TIER_MEANING = {
  L0: 'L0 — basic reachability (ICMP/ping)',
  L1: 'L1 — TCP port open',
  L2: 'L2 — TLS handshake / certificate valid',
  L3: 'L3 — authenticated synthetic transaction',
  L4: 'L4 — confirmed real traffic observed',
};

// latest-per-key over a newest-first event list.
function latestPer(events, keyFn) {
  const seen = new Map();
  for (const ev of events) {
    const k = keyFn(ev);
    if (!seen.has(k)) seen.set(k, ev);
  }
  return seen;
}

// Seconds a node has been in its current status = now minus the occurred_at
// of the OLDEST event in the current run of identical statuses. Walk the
// newest-first list until the status changes; that boundary is when the
// current state began. Deterministic, derived only from recorded events.
function timeInState(events, currentStatus) {
  if (!events.length) return null;
  const now = Date.now();
  let stateStart = null;
  for (const ev of events) {
    const p = JSON.parse(ev.payload ?? '{}');
    if ((p.status ?? 'unknown') !== currentStatus) break;
    stateStart = ev.occurred_at;
  }
  if (!stateStart) return null;
  return Math.max(0, Math.round((now - Date.parse(stateStart)) / 1000));
}

export default async function topologyViewRoutes(app) {
  app.get('/api/sites/:id/full-status', async (req) => {
    const siteId = req.params.id;
    const events = listEventsBySite(siteId, 500);
    const checkResults = events.filter(e => e.kind === 'check_result');

    // Latest status per critical service. A service with NO events is 'unknown'
    // — never reported as healthy by default (that would be a stale good).
    const byService = latestPer(checkResults, e => e.service);
    const services = CRITICAL_SERVICES.map(svc => {
      const ev = byService.get(svc);
      if (!ev) return { service: svc, status: 'unknown', detail: null, tier_observed: null, occurred_at: null, check_name: null, latency_ms: null };
      const p = JSON.parse(ev.payload ?? '{}');
      const serviceEvents = checkResults.filter(e => e.service === svc);
      return {
        service: svc,
        status: p.status ?? 'unknown',
        detail: p.detail ?? null,
        tier_observed: p.tier_observed ?? null,
        occurred_at: ev.occurred_at,
        check_name: p.check_name ?? null,
        adapter: p.adapter ?? null,
        latency_ms: ev.latency_ms ?? null,
        channel_id: ev.channel_id ?? null,
        time_in_state_s: timeInState(serviceEvents, p.status ?? 'unknown'),
      };
    });

    // Interface-engine channel topology: newest check_result per channel_id.
    const channelEvents = checkResults.filter(e => e.channel_id);
    const byChannel = latestPer(channelEvents, e => e.channel_id);
    const channels = [...byChannel.entries()].map(([chId, ev]) => {
      const p = JSON.parse(ev.payload ?? '{}');
      const reg = getChannel(chId);
      const chEvents = channelEvents.filter(e => e.channel_id === chId);
      return {
        channel_id: chId,
        display_name: reg?.display_name ?? chId,
        engine: reg?.engine ?? 'unregistered',
        site_id: reg?.site_id ?? null,
        source_system: reg?.source_system ?? null,
        destination_system: reg?.destination_system ?? null,
        status: p.status ?? 'unknown',
        detail: p.detail ?? null,
        occurred_at: ev.occurred_at,
        time_in_state_s: timeInState(chEvents, p.status ?? 'unknown'),
      };
    });

    // Co-occurring signals: every OTHER node (service or channel) at this site
    // currently degraded/down. Computed per node at render time by the client
    // from this same payload — here we just make the degraded/down set explicit.
    const degradedOrDown = [
      ...services.filter(s => s.status === 'degraded' || s.status === 'down').map(s => ({ kind: 'service', name: s.service, status: s.status })),
      ...channels.filter(c => c.status === 'degraded' || c.status === 'down').map(c => ({ kind: 'channel', name: c.display_name, status: c.status })),
    ];

    return {
      site_id: siteId,
      services,
      channels,
      degraded_or_down: degradedOrDown,
      tier_meaning: TIER_MEANING,
    };
  });

  // Geographic fleet map (TOPOLOGY_AND_TROUBLESHOOTING_MEMORY.md §1). Returns
  // one pin per site with lat/lng and the site's current overall status (worst
  // of its critical-service statuses). RBAC: ops-manager/support-technician see
  // the whole fleet; customer-it-admin must pass their own site_id and sees only
  // that pin.
  const STATUS_WEIGHT = { down: 5, degraded: 4, active: 3, verified_ready: 2, reachable: 1, unknown: 0 };
  function worstStatus(statuses) {
    let worst = null;
    for (const s of statuses) {
      if (s === 'unknown') continue; // unknown is the baseline; it must not drown out known-good states.
      if (worst == null || (STATUS_WEIGHT[s] ?? -1) > (STATUS_WEIGHT[worst] ?? -1)) worst = s;
    }
    return worst ?? 'unknown';
  }
  app.get('/api/fleet/map', { preHandler: async (req, reply) => {
    const role = req.query?.role ?? req.body?.role ?? null;
    const requestedSite = req.query?.site_id ?? null;
    if (can(role, 'topology:rollup')) return;
    // customer-it-admin may see only their own site pin.
    if (role === 'customer-it-admin' && requestedSite) return;
    appendAudit({ auditId: crypto.randomUUID(), actor: role ?? 'anonymous', action: 'rbac.denied', target: 'topology:rollup', detail: req.url });
    return reply.code(403).send({ error: `role '${role ?? 'none'}' lacks fleet map access` });
  } }, async (req) => {
    const role = req.query?.role ?? req.body?.role ?? null;
    const requestedSite = req.query?.site_id ?? null;
    const sites = [];
    for (const site of listSites()) {
      if (role === 'customer-it-admin' && site.site_id !== requestedSite) continue;
      // Overall site status = worst latest status among critical services at this site.
      const events = listEventsBySite(site.site_id, 500);
      const checkResults = events.filter(e => e.kind === 'check_result');
      const byService = latestPer(checkResults, e => e.service);
      const statuses = CRITICAL_SERVICES.map(svc => {
        const ev = byService.get(svc);
        if (!ev) return 'unknown';
        const p = JSON.parse(ev.payload ?? '{}');
        return p.status ?? 'unknown';
      });
      sites.push({
        site_id: site.site_id,
        name: site.name ?? site.site_id,
        lat: site.lat,
        lng: site.lng,
        status: worstStatus(statuses),
      });
    }
    return { sites };
  });
}
