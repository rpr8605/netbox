// netbox-agent/lib/enroll.js
// Shared enrollment/renewal/retrust client used by provision.js (first boot)
// and agent.js (daemon loop). Lives under /opt/netbox-agent on the image; the
// device-sim container also sources this via a filtered copy so the real
// image and the test harness run the same enrollment code path.
import forge from 'node-forge';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const RENEW_FRACTION = 0.55; // renew at ~55% of TTL; must hold <1 and >~0.5
export const HTTP_OK = [200, 201];

export function loadEnv() {
  return {
    cp: process.env.CONTROL_PLANE_URL,
    ca: process.env.CA_URL,
    deviceId: process.env.DEVICE_ID || null,
    siteId: process.env.SITE_ID || null,
  };
}

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
