// netbox-agent/lib/issue_cert.js
// Shared cert-issuance helper: CSR -> step-ca OTT sign -> return PEM cert.
// Called by both first-boot enrollment (provision.js) and by the daemon's
// renewal/retrust flows (agent.js) so all three paths converge on exactly one
// CSR/sign code path; drift here is the single biggest renewal-lockout risk.
import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

// THE single CSR -> OTT-sign -> PEM path for every issuance flow (first-boot
// enrollment, daemon renewal, re-trust). The convergence is deliberate, per
// the header: drift between issuance paths is the biggest renewal-lockout
// risk, so there is exactly one. rejectUnauthorized:false is intentional at
// this layer, not an oversight — at first boot the device has no CA root to
// verify against yet (that IS the bootstrap problem), and the one-time token,
// not TLS, is what authorizes this exact CSR. Returns cert + chain PEM so the
// caller can persist a complete bundle in one write.
export async function issueCert({ caUrl, ott, commonName, keys }) {
  // openssl CANNOT read the key from /dev/stdin in the minimal image (fopen on
  // /dev/stdin fails with ENXIO when stdin is an execSync pipe). Write to a
  // mode-0600 temp file instead. /tmp is NOT usable: the image root is
  // read-only (spec §2), so the temp key lives on the writable /data LUKS
  // partition and is removed immediately after the CSR is built.
  const keyPem = keys.privateKeyPem ?? keys.privateKey;
  const tmpKey = `/data/.csr-key-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpKey, keyPem, { mode: 0o600 });
  let csrPem;
  try {
    csrPem = execSync(
      `openssl req -new -key ${tmpKey} -subj "/CN=${commonName}" -outform PEM`,
      { encoding: 'utf8' },
    );
  } finally {
    fs.rmSync(tmpKey, { force: true });
  }

  const u = new URL(caUrl + '/1.0/sign');
  const body = JSON.stringify({ csr: csrPem, ott });
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      rejectUnauthorized: false,
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  if (![200, 201].includes(res.status)) {
    throw new Error(`step-ca sign failed ${res.status}: ${res.body}`);
  }
  const parsed = JSON.parse(res.body);
  return `${parsed.crt}\n${parsed.ca ?? ''}`;
}
