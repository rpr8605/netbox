// control-plane/src/routes/retrust.js
// Key-continuity re-enroll (approved Phase 3 input): a device whose cert
// expired proves possession of the SAME long-term private key pinned at
// enrollment, and receives a fresh step-ca OTT. No new one-time token.
//
// Trust argument (deliberate — do not weaken silently):
//   - Expired cert fails TLS, so possession is proven by signing
//     `netbox-retrust-v1\0device_id\0challenge` and sending the public key PEM
//     alongside. The server (a) hashes the public key's DER and compares to
//     the pinned fingerprint (set once at enrollment redeem), and (b) verifies
//     the signature with that exact public key.
//   - Revocation short-circuits everything: a revoked device never re-trusts.
//   - Attacker must hold the TPM/LUKS-sealed private key itself; "hardening"
//     this into fresh-token-only would trade downtime-unavailability for no
//     real gain, which is why the tradeoff is documented inline per user input.
import crypto from 'node:crypto';
import forge from 'node-forge';
import { getDevice, createRetrustChallenge, consumeRetrustChallenge } from '../db.js';
import { mintStepCaToken, caBootstrap } from '../ca.js';

export function publicKeyFingerprint(publicKeyPem) {
  const cert = forge.pki.publicKeyFromPem(publicKeyPem);
  const der = forge.pki.publicKeyToAsn1(cert).getBytes();
  return crypto.createHash('sha256').update(der, 'binary').digest('hex');
}

export default async function retrustRoutes(app) {
  app.post('/api/enroll/retrust/challenge', async (req, reply) => {
    const { device_id } = req.body ?? {};
    if (!device_id) return reply.code(400).send({ error: 'device_id required' });
    const d = getDevice(device_id);
    if (!d) return reply.code(404).send({ error: 'unknown device' });
    if (d.state === 'revoked') return reply.code(403).send({ error: 'device revoked' });

    const challenge = crypto.randomBytes(32).toString('base64url');
    const challengeHash = crypto.createHash('sha256').update(challenge).digest('hex');
    createRetrustChallenge({ challengeHash, deviceId: device_id });
    return { device_id, challenge, expires_in_s: 60 };
  });

  app.post('/api/enroll/retrust', async (req, reply) => {
    const { device_id, challenge, signature_b64, public_key_pem } = req.body ?? {};
    if (!device_id || !challenge || !signature_b64 || !public_key_pem) {
      return reply.code(400).send({ error: 'device_id, challenge, signature_b64, public_key_pem required' });
    }
    const d = getDevice(device_id);
    if (!d || !['active', 'quarantine'].includes(d.state)) {
      return reply.code(403).send({ error: 'unknown, revoked, or not-yet-enrolled device' });
    }

    const challengeHash = crypto.createHash('sha256').update(challenge).digest('hex');
    if (!consumeRetrustChallenge(challengeHash, device_id)) {
      return reply.code(403).send({ error: 'challenge missing, used, or expired' });
    }

    if (!d.device_key_fp) {
      return reply.code(409).send({ error: 'no device key pinned at enrollment; re-enroll via token' });
    }

    // (a) bind embedded public key to the pinned fingerprint
    let fp;
    try { fp = publicKeyFingerprint(public_key_pem); } catch { fp = null; }
    if (!fp || fp !== d.device_key_fp) {
      return reply.code(403).send({ error: 'public key does not match enrollment pin' });
    }

    // (b) verify the signature over device_id + challenge with that key
    const payload = `netbox-retrust-v1\0${device_id}\0${challenge}`;
    if (!verifySignature(public_key_pem, payload, signature_b64)) {
      return reply.code(403).send({ error: 'proof-of-possession failed' });
    }

    const ott = await mintStepCaToken(device_id);
    const bootstrap = await caBootstrap();
    return { device_id, step_ca: { ott, fingerprint: bootstrap.fingerprint } };
  });
}

export function verifySignature(publicKeyPem, payload, signatureB64) {
  try {
    const pub = forge.pki.publicKeyFromPem(publicKeyPem);
    const md = forge.md.sha256.create();
    md.update(payload, 'utf8');
    return pub.verify(md.digest().bytes(), Buffer.from(signatureB64, 'base64').toString('binary'));
  } catch { return false; }
}
