// control-plane/src/routes/channels.js
// Responsibility: the interface-channel topology surface for the Fleet Console.
//   POST /api/channels                   register a channel_id -> display name/engine (operator)
//   GET  /api/channels                   list the registry
//   GET  /api/sites/:id/topology         per-site view: newest check_result per channel
//   GET  /api/topology/rollup?role=<r>   cross-site rollup, ROLE-GATED to
//                                        operations-manager | support-technician per the RBAC
//                                        row (spec §5) — anyone else gets 403.
//
// RBAC is a STUB here (Phase 2 has no auth yet): the role comes from the query
// string and is validated against an allow-list. The gate is structural — a
// real auth layer (Phase 8) must map principal->role here, but the "rollup is
// ops-manager/support-technician ONLY" decision lives at this route, not in
// the console.
import { listChannels, getChannel, getDevice, listEvents, listEventsBySite, listDevices, upsertChannel } from '../db.js';

// The ONLY two roles allowed on the cross-site rollup. customer-it-admin /
// security-auditor / readonly-executive get per-site views instead, never the
// fleet rollup — this set is the whole point of the route.
const ROLLUP_ROLES = new Set(['operations-manager', 'support-technician']);

function rollupAllowed(role, reply) {
  if (!ROLLUP_ROLES.has(role)) {
    reply.code(403).send({ error: 'rollup restricted to operations-manager/support-technician roles' });
    return false;
  }
  return true;
}

// Group event rows into topology view per channel. Unregistered channel_ids
// surface the raw id with an explicit 'unregistered' hint — the registry is a
// naming convenience, never a gate.
function toTopology(events) {
  const byChannel = new Map();
  for (const ev of events) {
    const chId = ev.channel_id ?? null;
    if (!chId) continue;
    if (!byChannel.has(chId)) byChannel.set(chId, []);
    const p = JSON.parse(ev.payload ?? '{}');
    byChannel.get(chId).push({ status: p.status ?? 'unknown', detail: p.detail ?? '', occurred_at: ev.occurred_at, kind: ev.kind });
  }
  const channels = [];
  for (const [chId, evs] of byChannel) {
    const reg = getChannel(chId);
    channels.push({
      channel_id: chId,
      display_name: reg?.display_name ?? chId,
      engine: reg?.engine ?? 'unregistered',
      newest: evs[0],
    });
  }
  return channels;
}

export default async function channelRoutes(app) {
  // Operator registers a channel_id -> display name/engine. Same stub-gate as
  // /api/enroll/tokens (Phase 2): real RBAC in Phase 8.
  app.post('/api/channels', async (req, reply) => {
    const { channel_id, display_name, engine } = req.body ?? {};
    if (!channel_id || !display_name || !engine) {
      return reply.code(400).send({ error: 'channel_id, display_name, engine required' });
    }
    upsertChannel({ channelId: channel_id, displayName: display_name, engine });
    return { channel_id, display_name, engine };
  });
  app.get('/api/channels', async () => listChannels());

  // Flat newest-per-(site,channel) row set. Kept in the route because the
  // per-site and fleet rollups share it; the actual SQL grouping is one
  // GROUP BY over events, not a per-site loop (correct at any size).
  function newestPerChannel(rows) {
    const byKey = new Map();
    for (const ev of rows) {
      const key = `${ev.site_id}\u0000${ev.channel_id}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(ev);
    }
    const out = [];
    for (const evs of byKey.values()) {
      out.push(evs[0]); // rows are ordered occurred_at DESC
    }
    return out;
  }

  // Per-site topology: newest check_result per channel at one site.
  app.get('/api/sites/:id/topology', async (req) => {
    const siteId = req.params.id;
    const evs = listEventsBySite(siteId, 200);
    const newest = newestPerChannel(evs);
    const topo = toTopology(newest);
    return { site_id: siteId, channels: topo };
  });

  // Cross-site rollup: fleet-wide newest-per-channel across sites. RBAC-gated.
  app.get('/api/topology/rollup', async (req, reply) => {
    const role = req.query.role ?? req.body?.role ?? null;
    if (!rollupAllowed(role, reply)) return;
    // Gather each registered device's recent events and fold by site/channel.
    const all = [];
    for (const device of listDevices()) {
      for (const ev of listEvents(device.device_id, 50)) all.push(ev);
    }
    const newest = newestPerChannel(all);
    const topo = toTopology(newest);
    // summarize counts per status for the ops roll-up header
    const summary = topo.reduce((acc, c) => { acc[c.newest.status] = (acc[c.newest.status] ?? 0) + 1; return acc; }, {});
    return { summary, channels: topo };
  });
}
