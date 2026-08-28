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
import { getDevice, listDevices, listEvents, upsertDevice } from '../db.js';

export default async function deviceRoutes(app) {
  app.get('/api/devices', async () => listDevices());

  app.get('/api/devices/:id', async (req, reply) => {
    const d = getDevice(req.params.id);
    if (!d) return reply.code(404).send({ error: 'unknown device' });
    return { ...d, recent_events: listEvents(d.device_id, 20) };
  });

  app.post('/api/devices/:id/confirm', async (req, reply) => {
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
}
