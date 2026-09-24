// control-plane/src/routes/enroll.js
// Responsibility: enrollment-token lifecycle.
//   POST /api/enroll/tokens   (operator side — localhost-only until real operator
//                             auth lands) creates a one-time token for a device_id/site_id pair.
//   POST /api/enroll/redeem   (device side) exchanges the one-time token for a
//                             short-lived step-ca JWK + CA bootstrap material.
//
// Why this split: the raw token travels exactly once (device -> redeem) and is
// stored only as a SHA-256 hash server-side. The step-ca JWK we hand back is
// valid for 5 minutes, so a stolen JWK has a tiny abuse window, and a stolen
// raw token is useless after redemption (used_at gate in db.js).
import crypto from 'node:crypto';
import forge from 'node-forge';
import { createEnrollmentToken, consumeEnrollmentToken, upsertDevice, setDeviceKeyFp, upsertSite, getDevice } from '../db.js';
import { mintStepCaToken, caBootstrap } from '../ca.js';
import { publicKeyFingerprint } from './retrust.js';
import { requirePerm } from '../rbac.js';
import { appendAudit } from '../db.js';

// enrollmentTokenPolicy — the C2 safety rules for creating an enrollment token.
// Exported so the unit test can pin the behavior independently of HTTP transport.
export function enrollmentTokenPolicy(deviceId, existingDevice, reEnroll) {
  if (!existingDevice) {
    // New device: quarantine-by-default until an operator confirms it.
    return { ok: true, state: 'quarantine', deviceKeyFp: null };
  }
  if (!reEnroll) {
    return { ok: false, code: 409, error: 'device already enrolled; use re_enroll=true for audited re-enrollment' };
  }
  if (existingDevice.state === 'active') {
    return { ok: false, code: 409, error: 'active device cannot be re-enrolled via token; use the replace workflow' };
  }
  // Re-enroll of a quarantined/retired-but-not-revoked device: keep the
  // existing state and NEVER touch the pinned key fingerprint. The cert fields
  // are left untouched here; redemption or a future cert presentation updates
  // them through their own paths.
  return { ok: true, state: existingDevice.state, deviceKeyFp: existingDevice.device_key_fp };
}

export default async function enrollRoutes(app) {
  // Operator endpoint. Requires an operator role that can mint enrollment tokens
  // (C2). The current stub still uses query-string roles, but the gate is structural so
  // a real auth layer only has to supply the principal's role.
  app.post('/api/enroll/tokens', {
    preHandler: requirePerm('enroll:tokens', appendAudit),
    config: { auth: 'operator:enroll:tokens' },
  }, async (req, reply) => {
    const { device_id, site_id, ttl_minutes = 60, name, lat, lng, re_enroll = false } = req.body ?? {};
    if (!device_id || !site_id) {
      return reply.code(400).send({ error: 'device_id and site_id required' });
    }

    const existingDevice = await getDevice(device_id);
    const policy = enrollmentTokenPolicy(device_id, existingDevice, re_enroll === true);
    if (!policy.ok) {
      await appendAudit({
        auditId: crypto.randomUUID(),
        actor: req.user?.role ?? 'unknown',
        action: 'enroll.token_denied',
        target: device_id,
        detail: policy.error,
      });
      return reply.code(policy.code).send({ error: policy.error });
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + ttl_minutes * 60_000).toISOString();
    await createEnrollmentToken({ tokenHash, deviceId: device_id, siteId: site_id, expiresAt });
    // Register the device in quarantine NOW — before any cert exists. A device
    // that shows up with a valid cert but no registry row is refused later;
    // quarantine-by-default is the safety property (docs/specs/BEACON_RELAY_BUILD_SPEC.md §2). For re-enroll of
    // an existing non-active device the policy preserves the prior state.
    await upsertDevice({ deviceId: device_id, siteId: site_id, state: policy.state });
    // Optional site metadata for the geographic fleet map (TOPOLOGY_…_MEMORY §1).
    // Lat/lng are optional at enrollment time; the console can update them later.
    if (name != null || lat != null || lng != null) {
      await upsertSite({ siteId: site_id, name, lat, lng });
    }
    await appendAudit({
      auditId: crypto.randomUUID(),
      actor: req.user?.role ?? 'operations-manager',
      action: existingDevice ? 'enroll.token_reenroll' : 'enroll.token_created',
      target: device_id,
      detail: `site=${site_id} re_enroll=${re_enroll === true}`,
    });
    return { device_id, site_id, enrollment_token: token, expires_at: expiresAt };
  });

  // Device endpoint — the only unauthenticated-by-cert device call in the system.
  // Accepts an optional public_key_pem; first redemption PINS sha256(der(pubkey))
  // as the device_key_fp used by key-continuity retrust (routes/retrust.js).
  app.post('/api/enroll/redeem', {
    config: { auth: 'public' },
  }, async (req, reply) => {
    const { enrollment_token, public_key_pem } = req.body ?? {};
    if (!enrollment_token) return reply.code(400).send({ error: 'enrollment_token required' });

    const tokenHash = crypto.createHash('sha256').update(enrollment_token).digest('hex');
    const row = await consumeEnrollmentToken(tokenHash);
    if (!row) {
      // Deliberately vague: don't let an oracle distinguish expired vs never-existed.
      return reply.code(403).send({ error: 'invalid enrollment token' });
    }

    if (public_key_pem) {
      try {
        const fp = publicKeyFingerprint(public_key_pem);
        await setDeviceKeyFp(row.device_id, fp);
      } catch {
        return reply.code(400).send({ error: 'malformed public_key_pem' });
      }
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
