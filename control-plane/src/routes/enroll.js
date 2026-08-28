// control-plane/src/routes/enroll.js
// Responsibility: enrollment-token lifecycle.
//   POST /api/enroll/tokens   (operator side — Phase 1: localhost-only) creates
//                             a one-time token for a device_id/site_id pair.
//   POST /api/enroll/redeem   (device side) exchanges the one-time token for a
//                             short-lived step-ca JWK + CA bootstrap material.
//
// Why this split: the raw token travels exactly once (device -> redeem) and is
// stored only as a SHA-256 hash server-side. The step-ca JWK we hand back is
// valid for 5 minutes, so a stolen JWK has a tiny abuse window, and a stolen
// raw token is useless after redemption (used_at gate in db.js).
import crypto from 'node:crypto';
import { createEnrollmentToken, consumeEnrollmentToken, upsertDevice } from '../db.js';
import { mintStepCaToken, caBootstrap } from '../ca.js';

export default async function enrollRoutes(app) {
  // Operator endpoint. Phase 1: bound to localhost by the server config; Phase 8
  // puts real RBAC in front of this (spec §5) — do not expose before then.
  app.post('/api/enroll/tokens', async (req, reply) => {
    const { device_id, site_id, ttl_minutes = 60 } = req.body ?? {};
    if (!device_id || !site_id) {
      return reply.code(400).send({ error: 'device_id and site_id required' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + ttl_minutes * 60_000)
      .toISOString().replace('T', ' ').slice(0, 19);
    createEnrollmentToken({ tokenHash, deviceId: device_id, siteId: site_id, expiresAt });
    // Register the device in quarantine NOW — before any cert exists. A device
    // that shows up with a valid cert but no registry row is refused later;
    // quarantine-by-default is the safety property (spec §2).
    upsertDevice({ deviceId: device_id, siteId: site_id, state: 'quarantine' });
    return { device_id, site_id, enrollment_token: token, expires_at: expiresAt };
  });

  // Device endpoint — the only unauthenticated-by-cert device call in the system.
  app.post('/api/enroll/redeem', async (req, reply) => {
    const { enrollment_token } = req.body ?? {};
    if (!enrollment_token) return reply.code(400).send({ error: 'enrollment_token required' });

    const tokenHash = crypto.createHash('sha256').update(enrollment_token).digest('hex');
    const row = consumeEnrollmentToken(tokenHash);
    if (!row) {
      // Deliberately vague: don't let an oracle distinguish expired vs never-existed.
      return reply.code(403).send({ error: 'invalid enrollment token' });
    }

    const ott = await mintStepCaToken(row.device_id);
    const bootstrap = await caBootstrap();
    return {
      device_id: row.device_id,
      site_id: row.site_id,
      step_ca: {
        ott,                                  // one-time token for POST {ca}/1.0/sign
        fingerprint: bootstrap.fingerprint,   // device pins this before trusting the CA
        ca_url: process.env.CA_URL ?? 'https://localhost:9000',
      },
    };
  });
}
