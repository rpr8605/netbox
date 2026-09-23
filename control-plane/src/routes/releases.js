// control-plane/src/routes/releases.js
// Responsibility: serve the signed RAUC bundle + latest-version pointer to
// enrolled devices' OTA update clients, AND manage the staged rollout policy
// that decides which devices are allowed to see a new version (BUILD_SPEC §8.7).
// The device verifies the bundle signature itself before installing; the control
// plane only ever serves a bundle that was signed at build time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  getDevice, getActiveRollout, createRollout, listRollouts, activateRollout,
  offeredVersion, appendAudit,
} from '../db.js';
import { requirePerm } from '../rbac.js';

const OUT_ROOT = process.env.RELEASES_DIR ?? 'out';

function readManifest() {
  const p = path.join(OUT_ROOT, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export default async function releaseRoutes(app) {
  // Latest release version — gated by the active staged rollout when one exists.
  // Devices pass their device_id so the policy can deterministically decide
  // whether this device is in the current rollout percentage.
  app.get('/api/releases/latest', async (req, reply) => {
    const m = readManifest();
    if (!m) return reply.code(404).send({ error: 'no release published' });
    const deviceId = req.query?.device_id ?? null;
    const version = deviceId ? await offeredVersion(deviceId, m.version) : m.version;
    if (!version) {
      const active = await getActiveRollout();
      await appendAudit({
        auditId: crypto.randomUUID(), actor: deviceId ?? 'unknown-device',
        action: 'rollout.rejected', target: m.version,
        detail: `device not in active rollout ${active?.rollout_id ?? 'none'}`,
      });
      return reply.code(204).send();
    }
    return { version, built_at: m.built_at };
  });

  // The signed bundle bytes. mTLS-gated: only an enrolled device may pull it.
  app.get('/api/releases/:version/bundle', async (req, reply) => {
    const cert = req.socket.getPeerCertificate?.();
    if (!req.socket.authorized || !cert?.subject?.CN || !(await getDevice(cert.subject.CN))) {
      return reply.code(403).send({ error: 'enrolled device cert required' });
    }
    const p = path.join(OUT_ROOT, req.params.version, 'beacon-relay.raucb');
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'no bundle for that version' });
    reply.header('content-type', 'application/octet-stream');
    return reply.send(fs.createReadStream(p));
  });

  // -------------------------------------------------------------------------
  // Staged rollout management (operations-manager only). Each action is
  // audit-logged. The rollout engine itself is intentionally small: a version,
  // a stage, and a percentage, with deterministic device assignment.
  // -------------------------------------------------------------------------
  app.post('/api/releases/rollouts', { preHandler: requirePerm('releases:manage', appendAudit) }, async (req, reply) => {
    const { version, stage, percentage = 100 } = req.body ?? {};
    if (!version || !stage || !['dev', 'test', 'pilot', 'broad'].includes(stage)) {
      return reply.code(400).send({ error: 'version and stage (dev|test|pilot|broad) required' });
    }
    if (percentage < 0 || percentage > 100) {
      return reply.code(400).send({ error: 'percentage must be 0-100' });
    }
    const rolloutId = await createRollout({ version, stage, percentage });
    await appendAudit({
      auditId: crypto.randomUUID(), actor: req.query?.role ?? req.body?.role ?? 'operations-manager',
      action: 'rollout.created', target: rolloutId, detail: `${version} ${stage} ${percentage}%`,
    });
    return { rollout_id: rolloutId, version, stage, percentage, active: false };
  });

  app.get('/api/releases/rollouts', { preHandler: requirePerm('releases:manage', appendAudit) }, async () => {
    return listRollouts();
  });

  app.post('/api/releases/rollouts/:id/activate', { preHandler: requirePerm('releases:manage', appendAudit) }, async (req, reply) => {
    const changes = await activateRollout(req.params.id);
    if (!changes) return reply.code(404).send({ error: 'rollout not found' });
    const active = await getActiveRollout();
    await appendAudit({
      auditId: crypto.randomUUID(), actor: req.query?.role ?? req.body?.role ?? 'operations-manager',
      action: 'rollout.activated', target: req.params.id,
      detail: `${active.version} ${active.stage} ${active.percentage}%`,
    });
    return active;
  });
}
