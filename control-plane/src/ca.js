// control-plane/src/ca.js
// Responsibility: the control plane's only coupling to step-ca — fetch the CA
// fingerprint/root (for device bootstrap material), and sign one-time
// enrollment JWK tokens with the provisioner key so a device can redeem them
// at step-ca for a short-lived client certificate.
// Called by: routes/enroll.js (token minting), routes/bootstrap.js (fingerprint).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, importJWK } from 'jose';
import { Agent, fetch as undiciFetch } from 'undici';

const CA_URL = process.env.CA_URL ?? 'https://localhost:9000';
const PROV_NAME = process.env.PROVISIONER_NAME ?? 'beacon-relay-device';

// Resolve the provisioner private key path lazily so tests can set the env var
// after importing modules that transitively depend on ca.js.
function privPath() {
  return process.env.PROVISIONER_PRIVATE_JWK_PATH ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../pki-config/provisioner/private_jwk.json');
}

// Cached CA root material. We need both the PEM (for device bootstrap) and the
// SHA-256 fingerprint (as the `sha` root claim in step-ca revocation tokens).
let _rootPem = null;
let _rootFingerprint = null;

export function setCaRootMaterial(pem, fingerprint) {
  _rootPem = pem;
  _rootFingerprint = fingerprint;
}

export function caRootFingerprint() {
  return _rootFingerprint;
}

// Normalize any serial number representation to a base-10 decimal string.
// Node's `getPeerCertificate()` returns the serial as hex; step-ca's revoke
// API expects a decimal string. We convert once and store the canonical form.
export function canonicalSerial(serial) {
  if (serial == null) return '';
  const s = String(serial).trim();
  if (/^[0-9]+$/.test(s)) return s.replace(/^0+/, '') || '0';
  const hex = s.replace(/[^0-9a-fA-F]/g, '');
  if (!hex) return '';
  return BigInt(`0x${hex}`).toString(10);
}

let _privKey = null;
async function provisionerKey() {
  if (_privKey) return _privKey;
  const raw = JSON.parse(fs.readFileSync(privPath(), 'utf8'));
  _privKey = await importJWK(raw.private ?? raw, 'ES256');
  return _privKey;
}

// step-ca JWK provisioner expects a JWT whose 'sub' is the CSR subject (device id)
// and whose audience is the CA sign endpoint. One-time use is enforced by OUR
// enrollment_tokens table (the JWK itself is valid briefly; step-ca also tracks jti
// reuse when configured — here the DB gate is the authority).
export async function mintStepCaToken(deviceId) {
  const key = await provisionerKey();
  return await new SignJWT({ sub: deviceId })
    .setProtectedHeader({ alg: 'ES256', kid: 'beacon-relay-device', typ: 'JWT' })
    .setIssuer(provName())
    .setAudience(`${CA_URL}/1.0/sign`)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime('5m')
    .sign(key);
}

// The step-ca JWK provisioner name that mintStepCaToken stamps as the JWT
// issuer. Exposed as a function (rather than each caller re-reading env) so
// the issuer string can never drift from the provisioner key we actually sign
// with — a mismatched iss makes step-ca reject every token with no other symptom.
export function provName() { return PROV_NAME; }

// Fetch CA root PEM + fingerprint. step-ca serves HTTPS with a cert we cannot
// yet verify (that IS the bootstrap problem), so verification is skipped here
// and trust is established by comparing the SHA-256 fingerprint out-of-band —
// which is exactly what the device simulator asserts in its pin check.
export const bootstrapAgent = new Agent({ connect: { rejectUnauthorized: false } });

// Fetch the CA root PEM + its SHA-256 fingerprint — the trust anchor a device
// pins at bootstrap. Uses the verification-skipping agent above ON PURPOSE
// (see its comment): trust is established by comparing `fingerprint`
// out-of-band, and the device simulator's pin check is what actually asserts
// it. "Fixing" the skipped TLS verification here without replacing that
// fingerprint comparison would break first-boot enrollment, not harden it.
export async function caBootstrap() {
  const res = await undiciFetch(`${CA_URL}/roots.pem`, { dispatcher: bootstrapAgent });
  if (!res.ok) throw new Error(`CA roots fetch failed: ${res.status}`);
  const pem = await res.text();
  const der = Buffer.from(
    pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, ''),
    'base64'
  );
  const fingerprint = crypto.createHash('sha256').update(der).digest('hex');
  setCaRootMaterial(pem, fingerprint);
  return { pem, fingerprint };
}

// Mint a one-time JWK provisioner token that authorizes step-ca to revoke a
// certificate by serial number. This is the same signing key and issuer used
// for enrollment tokens; the audience is the revoke endpoint and the `sha`
// claim binds the token to the root CA fingerprint we pinned at bootstrap.
export async function mintStepCaRevokeToken(serial) {
  const decimalSerial = canonicalSerial(serial);
  if (!decimalSerial) throw new Error('invalid certificate serial');
  if (!_rootFingerprint) throw new Error('CA root material not initialized');
  const key = await provisionerKey();
  return await new SignJWT({ sub: decimalSerial, sha: _rootFingerprint })
    .setProtectedHeader({ alg: 'ES256', kid: 'beacon-relay-device', typ: 'JWT' })
    .setIssuer(provName())
    .setAudience(`${CA_URL}/1.0/revoke`)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime('5m')
    .sign(key);
}

// Revoke a certificate in step-ca by serial number. step-ca v0.30.2 only
// supports passive revocation, but recording the revocation in the CA blocks
// future renewal and is the authoritative record that the device identity is
// retired. `reasonCode: 4` is RFC 5280 "Superseded", the correct semantics
// for a hardware swap.
export async function revokeStepCaCertificate(serial) {
  const decimalSerial = canonicalSerial(serial);
  if (!decimalSerial) throw new Error('invalid certificate serial');
  const ott = await mintStepCaRevokeToken(decimalSerial);
  const res = await undiciFetch(`${CA_URL}/1.0/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serial: decimalSerial,
      ott,
      reasonCode: 4,
      reason: 'Superseded',
      passive: true,
    }),
    dispatcher: bootstrapAgent,
  });
  if (res.ok) return { revoked: true };
  const text = await res.text();
  // Idempotent: if step-ca already considers this serial revoked, treat it as
  // success so retries and duplicate swap calls remain safe.
  if (/already been revoked|revoked/i.test(text)) {
    return { revoked: true, already: true };
  }
  throw new Error(`step-ca revoke failed (${res.status}): ${text}`);
}
