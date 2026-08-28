// control-plane/src/ca.js
// Responsibility: the control plane's only coupling to step-ca — fetch the CA
// fingerprint/root (for device bootstrap material), and sign one-time
// enrollment JWK tokens with the provisioner key so a device can redeem them
// at step-ca for a short-lived client certificate.
// Called by: routes/enroll.js (token minting), routes/bootstrap.js (fingerprint).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { SignJWT, importJWK } from 'jose';
import { Agent, fetch as undiciFetch } from 'undici';

const CA_URL = process.env.CA_URL ?? 'https://localhost:9000';
const PROV_NAME = process.env.PROVISIONER_NAME ?? 'netbox-device';
const PRIV_PATH = process.env.PROVISIONER_PRIVATE_JWK_PATH ?? '../pki-config/provisioner/private_jwk.json';

let _privKey = null;
async function provisionerKey() {
  if (_privKey) return _privKey;
  const raw = JSON.parse(fs.readFileSync(PRIV_PATH, 'utf8'));
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
    .setProtectedHeader({ alg: 'ES256', kid: 'netbox-device', typ: 'JWT' })
    .setIssuer(provName())
    .setAudience(`${CA_URL}/1.0/sign`)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime('5m')
    .sign(key);
}

export function provName() { return PROV_NAME; }

// Fetch CA root PEM + fingerprint. step-ca serves HTTPS with a cert we cannot
// yet verify (that IS the bootstrap problem), so verification is skipped here
// and trust is established by comparing the SHA-256 fingerprint out-of-band —
// which is exactly what the device simulator asserts in its pin check.
export const bootstrapAgent = new Agent({ connect: { rejectUnauthorized: false } });

export async function caBootstrap() {
  const res = await undiciFetch(`${CA_URL}/roots.pem`, { dispatcher: bootstrapAgent });
  if (!res.ok) throw new Error(`CA roots fetch failed: ${res.status}`);
  const pem = await res.text();
  const der = Buffer.from(
    pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, ''),
    'base64'
  );
  const fingerprint = crypto.createHash('sha256').update(der).digest('hex');
  return { pem, fingerprint };
}
