// netbox-agent/lib/enroll.js
// Shared enrollment/renewal/retrust client used by provision.js (first boot)
// and agent.js (daemon loop). Lives under /opt/netbox-agent on the image; the
// device-sim container also sources this via a filtered copy so the real
// image and the test harness run the same enrollment code path.
import forge from 'node-forge';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Renew at ~55% of cert TTL: >~0.5 so a failed attempt leaves real time to
// retry, <1 so we never ride the expiry edge. Both bounds must hold.
export const RENEW_FRACTION = 0.55;
// Success statuses across step-ca and control-plane endpoints (both are used).
export const HTTP_OK = [200, 201];

// Read deployment identity from env. Returns nulls rather than throwing so
// first boot can distinguish "not yet provisioned" from a crash.
export function loadEnv() {
  return {
    cp: process.env.CONTROL_PLANE_URL,
    ca: process.env.CA_URL,
    deviceId: process.env.DEVICE_ID || null,
    siteId: process.env.SITE_ID || null,
  };
}

// Minimal JSON request helper; the agent/dispatcher is injected so the mTLS
// path and test fakes share one call shape.
export async function http(agent, method, url, body) {
  return agent({ method, url, body: body ? JSON.stringify(body) : undefined,
                 headers: body ? { 'content-type':'application/json' } : undefined });
}

// forge CSR helper — same shape as device-sim's, but provisioned into /opt.
export function makeCsr(commonName, keys) {
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

// Timed schedule helper (agent loop): computes ms until next renew attempt.
export function nextRenewInMs(notAfterIso) {
  const notAfter = new Date(notAfterIso).getTime();
  const now = Date.now();
  const target = notAfter - (notAfter - now) * (1 - RENEW_FRACTION);
  return Math.max(5_000, target - now);
}
