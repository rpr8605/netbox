// control-plane/src/routes/releases.js
// Responsibility: serve the signed RAUC bundle + latest-version pointer to
// enrolled devices' OTA update clients. Read-only over the build's out/ tree;
// the device verifies the bundle signature itself before installing.
import fs from 'node:fs';
import path from 'node:path';
import { getDevice } from '../db.js';

const OUT_ROOT = process.env.RELEASES_DIR ?? 'out';

export default async function releaseRoutes(app) {
  // Latest release version — read from out/manifest.json written by the build.
  app.get('/api/releases/latest', async (req, reply) => {
    const p = path.join(OUT_ROOT, 'manifest.json');
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'no release published' });
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { version: m.version, built_at: m.built_at };
  });

  // The signed bundle bytes. mTLS-gated: only an enrolled device may pull it.
  app.get('/api/releases/:version/bundle', async (req, reply) => {
    const cert = req.socket.getPeerCertificate?.();
    if (!req.socket.authorized || !cert?.subject?.CN || !getDevice(cert.subject.CN)) {
      return reply.code(403).send({ error: 'enrolled device cert required' });
    }
    const p = path.join(OUT_ROOT, req.params.version, 'beacon-relay.raucb');
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'no bundle for that version' });
    reply.header('content-type', 'application/octet-stream');
    return reply.send(fs.createReadStream(p));
  });
}
