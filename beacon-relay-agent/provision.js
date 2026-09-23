// beacon-relay-agent/provision.js
// First-boot provisioning (ConditionPathExists=!/data/enrolled):
//   1. read config from /etc/beacon-relay.env (baked into rootfs by stage 10)
//   2. choose TPM-vs-LUKS software key (lib/tpm.js) once
//   3. read the Configurator-printed one-time token from /boot/enrollment.token
//   4. redeem the token with our public key attached — the control plane PINS
//      sha256(public-key DER) into device_key_fp at this moment, set-once
//   5. CSR -> step-ca sign with the OTT; save cert + key under /data
//   6. heartbeat with the new cert to prove quarantine gate, then mark enrolled
import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { tpmPresent, sealPrivateKey, luksSealPrivateKey } from './lib/tpm.js';
import { issueCert } from './lib/issue_cert.js';

function dbg(msg) {
  try { fs.appendFileSync('/dev/console', `provision: ${msg}\n`); } catch {}
  try { console.log(`provision: ${msg}`); } catch {}
}

const env = { ...process.env };
const CFG_PATH = '/etc/beacon-relay.env';

dbg('starting first-boot provisioning');
if (fs.existsSync(CFG_PATH)) {
  const content = fs.readFileSync(CFG_PATH, 'utf8');
  dbg(`config contents: ${content.trim()}`);
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) { env[m[1]] = m[2].trim(); dbg(`set ${m[1]}=${m[2]}`); }
  }
} else {
  dbg(`${CFG_PATH} NOT FOUND`);
}

const CP = env.CONTROL_PLANE_URL;
const CA = env.CA_URL;
const BOOT_TOKEN = '/boot/enrollment.token';

function api(method, url, body, tlsOpts = {}) {
  const u = new URL(url);
  const opts = {
    method,
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    rejectUnauthorized: false,
    ...tlsOpts,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: parsed ?? data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  if (!CP || !CA) { dbg('CONTROL_PLANE_URL/CA_URL unset'); process.exit(1); }
  dbg(`CP=${CP} CA=${CA}`);

  // RSA keypair via openssl (image has openssl; no forge dependency inside).
  const { execSync } = await import('node:child_process');
  const privPem = execSync('openssl genrsa 2048', { encoding: 'utf8' });
  const pubPem = execSync('openssl rsa -pubout', { input: privPem, encoding: 'utf8' });

  // TPM sealing: on TPM hardware the plain PEM never lands on disk; libtss2
  // seals it into a persistent handle. On non-TPM hardware the PEM goes ONLY
  // to /data (LUKS), never /boot.
  const isTpm = tpmPresent();
  const keyPath = isTpm
    ? sealPrivateKey(privPem)
    : luksSealPrivateKey(privPem, '/data/device_key.pem');
  fs.writeFileSync('/data/device_key.mode', isTpm ? 'tpm' : 'luks', { mode: 0o400 });
  dbg(`long-term key sealed via ${isTpm ? 'TPM' : 'LUKS software key'}`);

  const token = env.ENROLLMENT_TOKEN
    ?? (fs.existsSync(BOOT_TOKEN) ? fs.readFileSync(BOOT_TOKEN, 'utf8').trim() : null);
  if (!token) { dbg('no enrollment token on boot partition'); process.exit(1); }

  const redeem = await api('POST', `${CP}/api/enroll/redeem`, {
    enrollment_token: token,
    public_key_pem: pubPem,
  });
  if (redeem.status !== 200) { dbg(`redeem failed: ${JSON.stringify(redeem.body)}`); process.exit(1); }
  const { ott, fingerprint } = redeem.body.step_ca;
  const deviceId = redeem.body.device_id;
  const siteId = redeem.body.site_id;

  // CA fingerprint pin: fetched root must match what CP told us. Persist the
  // pinned root so the daemon can verify the control-plane server cert on
  // every subsequent call (H1).
  const rootsRes = await api('GET', `${CA}/roots.pem`);
  const rootsPem = rootsRes.body;
  const der = Buffer.from(
    rootsPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, ''),
    'base64',
  );
  const pinned = crypto.createHash('sha256').update(der).digest('hex');
  if (pinned !== fingerprint) {
    dbg('CA fingerprint mismatch (pinned != fetched)');
    process.exit(1);
  }
  fs.writeFileSync('/data/ca-root.pem', rootsPem, { mode: 0o444 });
  // The step-ca-issued server cert CN is always 'control-plane'; SNI must send
  // that name even when connecting over localhost.
  fs.writeFileSync('/data/cp_servername', 'control-plane', { mode: 0o444 });
  process.env.CP_SERVERNAME = 'control-plane';
  process.env.CA_ROOT_PEM = rootsPem;

  // TLS identity: the keypair the daemon's mTLS client auth actually uses.
  // In TPM mode the long-term key is TPM-sealed (its plain PEM never lands on
  // disk, by design above), so a SEPARATE on-disk TLS identity is established
  // here — the same shape the renewal flow writes (/data/tls_key.pem +
  // /data/device.crt; see agent.js renewViaRetrust). Without this file the
  // daemon's mtls() has no client key on first boot and every heartbeat 401s
  // ("valid client certificate required") until renewal — which itself needs
  // a working heartbeat, so the device never recovers (proven in vm-harness).
  // In LUKS mode the on-disk device_key.pem already serves both roles, so no
  // separate file is needed (agent.js tlsKeyPem falls back to it).
  const tlsPrivPem = isTpm
    ? execSync('openssl genrsa 2048', { encoding: 'utf8' })
    : privPem;
  const certPem = await issueCert({ caUrl: CA, ott, commonName: deviceId, keys: { privateKeyPem: tlsPrivPem } });
  fs.writeFileSync('/data/device.crt', certPem, { mode: 0o444 });
  if (isTpm) fs.writeFileSync('/data/tls_key.pem', tlsPrivPem, { mode: 0o400 });
  fs.writeFileSync('/data/site_id', siteId, { mode: 0o444 });
  fs.writeFileSync('/data/device_id', deviceId, { mode: 0o444 });

  // Heartbeat with the new cert proves quarantine gate before marking enrolled.
  // Use the pinned CA module so this first call also verifies the server cert
  // (H1); the root was written to /data/ca-root.pem above.
  const { api: pinnedApi } = await import('./lib/tls_pin.js');
  const hb = await pinnedApi('POST', `${CP}/api/heartbeat`, null, {
    cert: certPem,
    key: tlsPrivPem,
  });
  if (hb.status !== 200 || hb.body?.state !== 'quarantine') {
    dbg(`heartbeat after cert issue not quarantine: ${JSON.stringify(hb.body)}`);
    process.exit(1);
  }
  fs.writeFileSync('/data/enrolled', new Date().toISOString(), { mode: 0o444 });
  dbg('done; enrolled and quarantined');
}

main().catch(e => { dbg(`crashed: ${e.message}`); process.exit(1); });
