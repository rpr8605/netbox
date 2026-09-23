// control-plane/src/routes/devices.js
// Responsibility: device registry reads + the quarantine -> active confirmation.
//   GET  /api/devices                 list (console)
//   GET  /api/devices/:id             detail incl. last events (console)
//   POST /api/devices/:id/confirm     operator confirms identity + config
//                                     integrity; flips quarantine -> active.
//
// The confirm step is the human half of the quarantine gate (spec §2): the
// device cannot self-certify out of quarantine — an operator (Phase 8: an
// RBAC'd one) must confirm, and the device must have presented a valid
// step-ca-issued cert at least once (last_seen_at set by the mTLS gate).
import { getDevice, listDevices, listEvents, upsertDevice, replaceDevice } from '../db.js';
import { requirePerm } from '../rbac.js';
import { appendAudit } from '../db.js';

export default async function deviceRoutes(app) {
  app.get('/api/devices', async () => listDevices());

  app.get('/api/devices/:id', async (req, reply) => {
    const d = getDevice(req.params.id);
    if (!d) return reply.code(404).send({ error: 'unknown device' });
    return { ...d, recent_events: listEvents(d.device_id, 20) };
  });

  // confirm flips quarantine -> active: a WRITE to the device registry, so it
  // requires devices:write. Wired (was unauthenticated before the RBAC pass).
  app.post('/api/devices/:id/confirm', { preHandler: requirePerm('devices:write', appendAudit) }, async (req, reply) => {
    const d = getDevice(req.params.id);
    if (!d) return reply.code(404).send({ error: 'unknown device' });
    if (d.state === 'revoked') return reply.code(409).send({ error: 'device revoked' });
    if (!d.cert_serial || !d.last_seen_at) {
      // No valid mTLS presentation on record — confirming anyway would defeat
      // the entire enrollment flow, so this is a hard error, not a warning.
      return reply.code(409).send({
        error: 'device has not presented a valid certificate; cannot confirm',
      });
    }
    upsertDevice({
      deviceId: d.device_id,
      siteId: d.site_id,
      state: 'active',
      certSerial: d.cert_serial,
      certNotAfter: d.cert_not_after,
    });
    return { device_id: d.device_id, state: 'active' };
  });

  // Field-swap workflow: retire an old device and stand in a replacement device
  // at the same site. Requires devices:write; audits the replacement.
  app.post('/api/devices/:id/replace', { preHandler: requirePerm('devices:write', appendAudit) }, async (req, reply) => {
    const oldDeviceId = req.params.id;
    const { new_device_id, reason } = req.body ?? {};
    if (!new_device_id || typeof new_device_id !== 'string') {
      return reply.code(400).send({ error: 'new_device_id required' });
    }
    try {
      const role = req.body?.role ?? req.query?.role ?? 'operations-manager';
      const result = replaceDevice({ oldDeviceId, newDeviceId: new_device_id, reason, actor: role });
      return result;
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
}
