// control-plane/src/routes/events.js
// Responsibility: mTLS-gated device endpoints — heartbeat + event ingestion.
//
// Gate order (deliberate, spec §2 quarantine):
//   1. TLS layer must have verified the client cert against the step-ca root
//      (server.js sets rejectUnauthorized — an invalid/self-signed cert never
//      reaches this code).
//   2. The cert's CN must match a registered device_id (a valid cert for an
//      unknown device is still refused — cert + registry row, both required).
//   3. Quarantined devices may heartbeat ONLY; event ingestion is refused with
//      403 until an operator confirms the device out of quarantine.
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'node:fs';
import { getDevice, insertEvent, touchDevice, recordCertPresentation } from '../db.js';

const schema = JSON.parse(fs.readFileSync('./schemas/netbox_event.schema.json', 'utf8'));
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

// Allowed event kinds per device state. Quarantine permits heartbeat only —
// that's the whole point of the state.
const ALLOWED_BY_STATE = {
  quarantine: new Set(['heartbeat']),
  active: new Set(['check_result', 'hl7_metadata', 'heartbeat', 'update_event']),
};

function deviceFromCert(req, reply) {
  const cert = req.socket.getPeerCertificate();
  if (!req.socket.authorized || !cert?.subject?.CN) {
    reply.code(401).send({ error: 'valid client certificate required' });
    return null;
  }
  const device = getDevice(cert.subject.CN);
  if (!device) {
    reply.code(403).send({ error: 'certificate valid but device not registered' });
    return null;
  }
  if (device.state === 'revoked') {
    reply.code(403).send({ error: 'device revoked' });
    return null;
  }
  // Record the presented certificate's identity — the quarantine-release
  // confirmation (routes/devices.js) requires proof a valid cert was presented.
  if (device.cert_serial !== cert.serialNumber) {
    recordCertPresentation(device.device_id, cert.serialNumber, cert.valid_to ?? null);
  }
  return device;
}

export default async function eventRoutes(app) {
  app.post('/api/heartbeat', async (req, reply) => {
    const device = deviceFromCert(req, reply);
    if (!device) return;
    touchDevice(device.device_id);
    return { device_id: device.device_id, state: device.state, server_time: new Date().toISOString() };
  });

  app.post('/api/events', async (req, reply) => {
    const device = deviceFromCert(req, reply);
    if (!device) return;

    const ev = req.body;
    if (!validate(ev)) {
      return reply.code(400).send({ error: 'schema validation failed', details: validate.errors });
    }
    if (ev.device_id !== device.device_id) {
      // Cert identity is authoritative; a device cannot report as another device.
      return reply.code(403).send({ error: 'device_id does not match certificate identity' });
    }
    if (!ALLOWED_BY_STATE[device.state]?.has(ev.kind)) {
      return reply.code(403).send({ error: `device in ${device.state}: event kind '${ev.kind}' not permitted` });
    }

    insertEvent(ev);
    touchDevice(device.device_id);
    return reply.code(202).send({ accepted: true, event_id: ev.event_id });
  });
}
