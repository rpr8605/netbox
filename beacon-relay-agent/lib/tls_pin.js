#!/usr/bin/env node
// beacon-relay-agent/lib/tls_pin.js
// Responsibility: the device-side TLS pinning policy for the control plane.
// The device pins the step-ca root received at enrollment and verifies the
// server certificate on every call. Exported as a small module so the unit
// test can exercise it without starting the full agent daemon (H1).
import fs from 'node:fs';
import https from 'node:https';

// Load the pinned CA root. In production /data/ca-root.pem is written during
// first-boot provisioning after the fingerprint is verified. In dev/test
// fall back to the env var if the file is absent, but NEVER fall back to
// rejectUnauthorized:false silently.
export function loadPinnedCa() {
  const fromFile = (() => {
    try { return fs.readFileSync('/data/ca-root.pem', 'utf8'); } catch { return null; }
  })();
  if (fromFile) return fromFile;
  const fromEnv = process.env.CA_ROOT_PEM;
  if (fromEnv) return fromEnv;
  return null;
}

// Build TLS options for an HTTPS request to the control plane. The control
// plane's server cert is issued for CN='control-plane', so the SNI servername
// must match that regardless of whether the connection is over localhost.
// Callers pass the resolved URL so the hostname and port are correct, while
// servername pins the expected identity.
function loadServername() {
  if (process.env.CP_SERVERNAME) return process.env.CP_SERVERNAME;
  try { return fs.readFileSync('/data/cp_servername', 'utf8').trim(); } catch { return 'control-plane'; }
}

export function pinnedTlsOpts(targetUrl, extraOpts = {}) {
  const ca = loadPinnedCa();
  const u = new URL(targetUrl);
  const servername = loadServername();
  return {
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    ca,
    rejectUnauthorized: true,
    servername,
    ...extraOpts,
  };
}

// Client-certificate material for mTLS-gated device endpoints. The CA pin,
// rejectUnauthorized, and servername are supplied by pinnedTlsOpts; this only
// adds the device's own cert + key.
export function mtls(certPem, keyPem) {
  return { cert: certPem, key: keyPem };
}

// Promise wrapper around https.request using the pinned TLS options. Returns
// { status, body } where body is parsed JSON, the raw string, or (when
// extraOpts.binary is true) a Buffer of raw octets.
export function api(method, url, body, extraOpts = {}) {
  const { binary = false, ...tls } = extraOpts;
  const opts = pinnedTlsOpts(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    ...tls,
  });
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (binary) {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
          return;
        }
        const data = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: parsed ?? data });
      });
    });
    req.on('error', e => {
      // Mirror the legacy agent behaviour: network/TLS errors are returned,
      // not thrown, so a transient failure does not crash the daemon. Callers
      // that need strict failure handling (e.g. fetchBytes) inspect status.
      resolve({ status: 0, body: binary ? Buffer.alloc(0) : { error: String(e.message ?? e) } });
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
