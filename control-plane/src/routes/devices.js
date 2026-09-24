// control-plane/src/routes/devices.js
// Responsibility: device registry reads + the quarantine -> active confirmation.
//   GET  /api/devices                 list (console)
//   GET  /api/devices/:id             detail incl. last events (console)
//   POST /api/devices/:id/confirm     operator confirms identity + config
//                                     integrity; flips quarantine -> active.
//
// The confirm step is the human half of the quarantine gate (docs/specs/BEACON_RELAY_BUILD_SPEC.md §2): the
// device cannot self-certify out of quarantine — an operator (once real RBAC auth
// lands: an RBAC'd one) must confirm, and the device must have presented a valid
// step-ca-issued cert at least once (last_seen_at set by the mTLS gate).
import { getDevice, listDevices, listEvents, upsertDevice, replaceDevice, recordRevokedSerial } from '../db.js';
import { requirePerm } from '../rbac.js';
import { appendAudit } from '../db.js';
import { revokeStepCaCertificate, canonicalSerial } from '../ca.js';

export default async function deviceRoutes(app) {
  app.get('/api/devices', {
    preHandler: requirePerm('devices:read', appendAudit),
    config: { auth: 'operator:devices:read' },
  }, async () => listDevices());

  app.get('/api/devices/:id', {
    preHandler: requirePerm('devices:read', appendAudit),
    config: { auth: 'operator:devices:read' },
  }, async (req, reply) => {
    const d = await getDevice(req.params.id);
    if (!d) return reply.code(404).send({ error: 'unknown device' });
    return { ...d, recent_events: await listEvents(d.device_id, 20) };
  });

  // confirm flips quarantine -> active: a WRITE to the device registry, so it
  // requires devices:write. Wired (was unauthenticated before the RBAC pass).
  app.post('/api/devices/:id/confirm', {
    preHandler: requirePerm('devices:write', appendAudit),
    config: { auth: 'operator:devices:write' },
  }, async (req, reply) => {
    const d = await getDevice(req.params.id);
    if (!d) return reply.code(404).send({ error: 'unknown device' });
    if (d.state === 'revoked') return reply.code(409).send({ error: 'device revoked' });
    if (!d.cert_serial || !d.last_seen_at) {
      // No valid mTLS presentation on record — confirming anyway would defeat
      // the entire enrollment flow, so this is a hard error, not a warning.
      return reply.code(409).send({
        error: 'device has not presented a valid certificate; cannot confirm',
      });
    }
    await upsertDevice({
      deviceId: d.device_id,
      siteId: d.site_id,
      state: 'active',
      certSerial: d.cert_serial,
      certNotAfter: d.cert_not_after,
    });
    return { device_id: d.device_id, state: 'active' };
  });

  // Field-swap workflow: retire an old device and stand in a replacement device
  // at the same site. Restricted to operations-manager because it permanently
  // destroys a device identity in step-ca; support-technicians may not perform
  // this action. The flow revokes the old certificate in step-ca first, then
  // records the serial locally so the next mTLS presentation is rejected before
  // any DB state check.
  app.post('/api/devices/:id/replace', {
    preHandler: requirePerm('devices:replace', appendAudit),
    config: { auth: 'operator:devices:replace' },
  }, async (req, reply) => {
    const oldDeviceId = req.params.id;
    const { new_device_id, reason } = req.body ?? {};
    if (!new_device_id || typeof new_device_id !== 'string') {
      return reply.code(400).send({ error: 'new_device_id required' });
    }
    try {
      const oldDevice = await getDevice(oldDeviceId);
      if (!oldDevice) return reply.code(404).send({ error: 'old device not found' });

      // Revoke the old device's certificate in step-ca if it ever presented one.
      // If the CA call fails, stop the swap rather than leaving a live identity.
      if (oldDevice.cert_serial) {
        await revokeStepCaCertificate(oldDevice.cert_serial);
        await recordRevokedSerial(oldDevice.cert_serial, oldDeviceId, 'replace');
      }

      const role = req.user?.role ?? 'operations-manager';
      const result = await replaceDevice({ oldDeviceId, newDeviceId: new_device_id, reason, actor: role });
      return result;
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
  });
}
