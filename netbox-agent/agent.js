// netbox-agent/agent.js
// Device agent daemon. Runs AFTER first-boot provisioning
// (netbox-firstboot.service gates on !/data/enrolled; this unit gates on it
// existing). Responsibilities:
//   1. heartbeat on a cadence (default 10s; tunable via /etc/netbox-runtime.json)
//   2. cert renewal at ~55% of TTL via the key-continuity retrust flow
//      (challenge -> signed PoP -> fresh OTT -> CSR/sign), sharing
//      lib/issue_cert.js with first-boot provisioning so every cert path
//      converges on one CSR/sign implementation
//   3. self-health visibility (TPM-vs-LUKS mode tag on startup log)
//   4. the continuous monitoring loop (lib/monitor_loop.js) when a site profile
//      is configured — checks run on a schedule, not just on demand
//   5. the downtime-mode local UI (lib/downtime.js) — always on, because its
//      entire job is to be reachable when the WAN and cloud dashboard are not
// Image constraint: node:crypto + node:https + openssl CLI only — no npm
// packages exist in the image, so this file must never import them.
import fs from 'node:fs';
import https from 'node:https';
import { execSync } from 'node:child_process';
import { tpmPresent } from './lib/tpm.js';
import { issueCert } from './lib/issue_cert.js';
import { startMonitorLoop } from './lib/monitor_loop.js';
import { startDowntimeServer, refreshDowntimeCache } from './lib/downtime.js';
import { loadProfile } from './lib/ehr_check.js';
import { runNetCheck } from './lib/net_checks.js';
import { runFhirCheck } from './lib/fhir_r4.js';
import { runMirthCheck } from './lib/mirth_admin.js';

const DEFAULTS = { renew_fraction: 0.55, heartbeat_ms: 10_000 };

function loadConfig() {
  // Baked at /etc/netbox-runtime.json by pipeline stage 10 from config/.
  try {
    const cfg = JSON.parse(fs.readFileSync('/etc/netbox-runtime.json', 'utf8'));
    return { ...DEFAULTS, ...cfg };
  } catch { return { ...DEFAULTS }; }
}
const CFG = loadConfig();

const env = { ...process.env };
try {
  for (const line of fs.readFileSync('/etc/netbox.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch { /* config optional in dev */ }
const CP = env.CONTROL_PLANE_URL;
const CA = env.CA_URL;

const deviceId = fs.readFileSync('/data/device_id', 'utf8').trim();
// The long-term key's location depends on the sealing mode chosen at first
// boot (provision.js writes /data/device_key.mode as 'tpm'|'luks'). TPM mode
// seals into the TPM and leaves the plain copy at /data/tpm/key.plain.pem
// (LUKS-encrypted partition); LUKS mode writes /data/device_key.pem. Reading
// the wrong path crashes the daemon with ENOENT — exactly what happened before
// this branch existed.
const isTpm = fs.existsSync('/data/device_key.mode')
  ? fs.readFileSync('/data/device_key.mode', 'utf8').trim() === 'tpm'
  : tpmPresent();
const keyPem = fs.readFileSync(
  isTpm ? '/data/tpm/key.plain.pem' : '/data/device_key.pem', 'utf8');

let certPem = fs.readFileSync('/data/device.crt', 'utf8');

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
  return new Promise(resolve => {
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: parsed ?? data });
      });
    });
    req.on('error', e => resolve({ status: 0, body: { error: String(e.message ?? e) } }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// TLS identity key is separate from the pinned retrust key: renewal re-keys
// the TLS identity into /data/tls_key.pem and the enrollment-pinned
// device_key.pem is never touched after provisioning.
function tlsKeyPem() {
  return fs.existsSync('/data/tls_key.pem')
    ? fs.readFileSync('/data/tls_key.pem', 'utf8')
    : keyPem;
}
const mtls = () => ({ cert: certPem, key: tlsKeyPem() });

function signPop(payload) {
  // PoP signature over `netbox-retrust-v1\0device_id\0challenge` with the
  // pinned long-term key — same scheme the control plane verifies. Temp files
  // avoid PEM/newline mangling through any shell layer. They live on /data,
  // NOT /tmp: the image root is read-only (spec §2), so /tmp writes EROFS.
  fs.writeFileSync('/data/.pop.payload', payload);
  fs.writeFileSync('/data/.pop.key', keyPem, { mode: 0o600 });
  return execSync(
    'openssl dgst -sha256 -sign /data/.pop.key /data/.pop.payload | base64 -w0',
    { encoding: 'utf8' },
  ).trim();
}

function certDates(pem) {
  const end = execSync('openssl x509 -enddate -noout', { input: pem, encoding: 'utf8' })
    .replace('notAfter=', '').trim();
  const start = execSync('openssl x509 -startdate -noout', { input: pem, encoding: 'utf8' })
    .replace('notBefore=', '').trim();
  return { start: new Date(start).getTime(), end: new Date(end).getTime() };
}

async function heartbeat() {
  const hb = await api('POST', `${CP}/api/heartbeat`, null, mtls());
  if (hb.status === 200) {
    lastHeartbeatOkAt = Date.now(); // feed the self-monitor's silence detector
    console.log(`agent: heartbeat ok (state=${hb.body.state})`);
    return hb.body.state;
  }
  console.log(`agent: heartbeat failed status=${hb.status} body=${JSON.stringify(hb.body)}`);
  return null;
}

async function renewViaRetrust() {
  console.log('agent: renewal cycle (retrust challenge -> PoP -> OTT -> sign)');
  const ch = await api('POST', `${CP}/api/enroll/retrust/challenge`, { device_id: deviceId });
  if (ch.status !== 200) { console.log('agent: challenge failed', ch.body); return false; }

  const payload = `netbox-retrust-v1\0${deviceId}\0${ch.body.challenge}`;
  const sig = signPop(payload);
  const pubPem = execSync('openssl rsa -pubout', { input: keyPem, encoding: 'utf8' });

  const rt = await api('POST', `${CP}/api/enroll/retrust`, {
    device_id: deviceId,
    challenge: ch.body.challenge,
    signature_b64: sig,
    public_key_pem: pubPem,
  });
  if (rt.status !== 200) { console.log('agent: retrust refused', rt.body); return false; }

  // Renewal re-keys the TLS identity only (fresh RSA pair per renewal) and
  // stores it at /data/tls_key.pem. The long-term retrust key
  // (/data/device_key.pem) is deliberately NOT modified — overwriting it
  // would silently move the enrollment pin and break every future retrust.
  const newPriv = execSync('openssl genrsa 2048', { encoding: 'utf8' });
  const newCert = await issueCert({
    caUrl: CA, ott: rt.body.step_ca.ott, commonName: deviceId,
    keys: { privateKeyPem: newPriv },
  });
  certPem = newCert;
  fs.writeFileSync('/data/device.crt', certPem, { mode: 0o444 });
  fs.writeFileSync('/data/tls_key.pem', newPriv, { mode: 0o400 });
  console.log('agent: cert renewed (new TLS identity; retrust key untouched)');
  return true;
}

async function tick() {
  const state = await heartbeat();
  if (state === null) return;
  const { start, end } = certDates(certPem);
  const renewAt = start + CFG.renew_fraction * (end - start);
  if (Date.now() >= renewAt) await renewViaRetrust();
}

// Track the last successful heartbeat so the self-monitor can detect a silent
// heartbeat emitter (the "monitor that stopped working" failure mode).
// Declared before the loop starts so tick()'s first beat never hits a TDZ.
let lastHeartbeatOkAt = Date.now();

setInterval(tick, CFG.heartbeat_ms);
tick();

// --- downtime mode: always-on local UI --------------------------------------
// Started unconditionally: its whole purpose is availability when the WAN is
// down. Cache refresh is attempted opportunistically; failure is non-fatal.
const siteId = fs.existsSync('/data/site_id') ? fs.readFileSync('/data/site_id', 'utf8').trim() : null;
startDowntimeServer({ port: 8081, host: '0.0.0.0' }).then(() =>
  console.log('agent: downtime-mode UI on :8081'));

// --- continuous monitoring loop ---------------------------------------------
// Started only when a site profile is configured — a device with no profile
// is a heartbeat+renewal box, and inventing checks would be worse than none.
const PROFILE_PATH = process.env.NETBOX_SITE_PROFILE
  ?? (fs.existsSync('/etc/netbox-profile.json') ? '/etc/netbox-profile.json' : null);
if (PROFILE_PATH) {
  const profile = loadProfile(PROFILE_PATH);
  const ADAPTERS = { net: runNetCheck, fhir: runFhirCheck, mirth: runMirthCheck };
  const cpUrl = new URL(CP);
  startMonitorLoop(
    { deviceId, siteId, cpHost: cpUrl.hostname, cpPort: Number(cpUrl.port || 9100),
      cpHostName: cpUrl.hostname, lastHeartbeatOkAt, lteTarget: null },
    {
      intervalMs: CFG.check_interval_ms ?? 15_000,
      post: async (ev) => api('POST', `${CP}/api/events`, ev, mtls()),
      runAdapter: (check) => ADAPTERS[check.adapter](check.params),
      profile,
      log: (m) => console.log(m),
    },
  );
  console.log(`agent: monitor loop running (profile=${profile.profile_id}, interval=${CFG.check_interval_ms ?? 15000}ms)`);
}

console.log(`agent: daemon running; heartbeat=${CFG.heartbeat_ms}ms; tpm=${isTpm}; renew@${CFG.renew_fraction}`);
