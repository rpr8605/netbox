// beacon-relay-agent/agent.js
// Device agent daemon. Runs AFTER first-boot provisioning
// (beacon-relay-firstboot.service gates on !/data/enrolled; this unit gates on it
// existing). Responsibilities:
//   1. heartbeat on a cadence (default 10s; tunable via /etc/beacon-relay-runtime.json)
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
import { execSync } from 'node:child_process';
import { tpmPresent, tpmSign, tpmReadPublicPem } from './lib/tpm.js';
import { api, mtls } from './lib/tls_pin.js';
import { issueCert } from './lib/issue_cert.js';
import { startMonitorLoop } from './lib/monitor_loop.js';
import { startDowntimeServer, refreshDowntimeCache } from './lib/downtime.js';
import { loadProfile } from './lib/ehr_check.js';
import { runNetCheck } from './lib/net_checks.js';
import { runFhirCheck } from './lib/fhir_r4.js';
import { runMirthCheck } from './lib/mirth_admin.js';
import { runUpdateCycle, finishUpdateBoot, markGood } from './lib/update.js';

const DEFAULTS = { renew_fraction: 0.55, heartbeat_ms: 10_000 };

function loadConfig() {
  // Baked at /etc/beacon-relay-runtime.json by pipeline stage 10 from config/.
  try {
    const cfg = JSON.parse(fs.readFileSync('/etc/beacon-relay-runtime.json', 'utf8'));
    return { ...DEFAULTS, ...cfg };
  } catch { return { ...DEFAULTS }; }
}
const CFG = loadConfig();

const env = { ...process.env };
try {
  for (const line of fs.readFileSync('/etc/beacon-relay.env', 'utf8').split('\n')) {
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
// In TPM mode the long-term key never exists on disk — signing goes through
// the TPM (tpmSign) and the public key is read back with tpmReadPublicPem.
// In LUKS mode the software keyfile lives at /data/device_key.pem.
const keyPem = isTpm ? null : fs.readFileSync('/data/device_key.pem', 'utf8');

let certPem = fs.readFileSync('/data/device.crt', 'utf8');

// TLS identity key is separate from the pinned retrust key: renewal re-keys
// the TLS identity into /data/tls_key.pem and the enrollment-pinned
// device_key.pem is never touched after provisioning. In TPM mode the
// long-term key has no on-disk PEM (PoP signing uses the TPM, see signPop);
// the TLS identity is always an on-disk file — first written by provision.js
// from a separate keypair (the sealed long-term key never touches disk), then
// re-keyed each renewal.
function tlsKeyPem() {
  return fs.existsSync('/data/tls_key.pem')
    ? fs.readFileSync('/data/tls_key.pem', 'utf8')
    : keyPem;
}
const mTlsOpts = () => mtls(certPem, tlsKeyPem());

function signPop(payload) {
  // PoP signature over `beacon-relay-retrust-v1\0device_id\0challenge` with the
  // pinned long-term key — same scheme the control plane verifies. TPM mode
  // signs inside the TPM (key never leaves the chip); LUKS mode uses the
  // software keyfile via openssl. Temp files live on /data, NOT /tmp: the image
  // root is read-only (spec §2), so /tmp writes EROFS.
  fs.writeFileSync('/data/.pop.payload', payload);
  if (isTpm) return tpmSign('/data/.pop.payload');
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
  const hb = await api('POST', `${CP}/api/heartbeat`, null, mTlsOpts());
  if (hb.status === 200) {
    lastHeartbeatOkAt = Date.now(); // feed the self-monitor's silence detector
    console.log(`agent: heartbeat ok (state=${hb.body.state})`);
    // Post-boot slot confirmation (RAUC A/B): the first successful heartbeat
    // of a boot is the health signal that clears this slot's TRY flag in
    // grubenv and keeps it as the boot default. Until markGood runs, grub
    // treats this slot as a one-shot attempt and falls back to the previous
    // known-good slot on the next boot (see ESP grub.cfg's TRY accounting).
    // Once per boot; idempotent on RAUC's side.
    if (!slotMarkedGood) {
      slotMarkedGood = true;
      const ok = markGood();
      console.log(`agent: rauc mark-good after healthy boot: ${ok ? 'ok' : 'FAILED (non-fatal)'}`);
    }
    return hb.body.state;
  }
  console.log(`agent: heartbeat failed status=${hb.status} body=${JSON.stringify(hb.body)}`);
  return null;
}

async function renewViaRetrust() {
  console.log('agent: renewal cycle (retrust challenge -> PoP -> OTT -> sign)');
  const ch = await api('POST', `${CP}/api/enroll/retrust/challenge`, { device_id: deviceId });
  if (ch.status !== 200) { console.log('agent: challenge failed', ch.body); return false; }

  const payload = `beacon-relay-retrust-v1\0${deviceId}\0${ch.body.challenge}`;
  const sig = signPop(payload);
  // Public key presented for the fingerprint pin: TPM mode reads it from the
  // TPM (public half only), LUKS mode derives it from the on-disk keyfile.
  const pubPem = isTpm
    ? tpmReadPublicPem()
    : execSync('openssl rsa -pubout', { input: keyPem, encoding: 'utf8' });

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
// One-shot-per-boot flag for the RAUC mark-good call in heartbeat().
let slotMarkedGood = false;

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
const PROFILE_PATH = process.env.BEACON_RELAY_SITE_PROFILE
  ?? (fs.existsSync('/etc/beacon-relay-profile.json') ? '/etc/beacon-relay-profile.json' : null);
if (PROFILE_PATH) {
  const profile = loadProfile(PROFILE_PATH);
  const ADAPTERS = { net: runNetCheck, fhir: runFhirCheck, mirth: runMirthCheck };
  const cpUrl = new URL(CP);
  startMonitorLoop(
    { deviceId, siteId, cpHost: cpUrl.hostname, cpPort: Number(cpUrl.port || 9100),
      cpHostName: cpUrl.hostname, lteTarget: null,
      // Live getter, NOT a by-value snapshot: checkHeartbeat must read the
      // current value on every self-check or it permanently reports
      // "heartbeat down" ~30s after boot while real heartbeats keep landing.
      getLastHeartbeatOkAt: () => lastHeartbeatOkAt },
    {
      intervalMs: CFG.check_interval_ms ?? 15_000,
      post: async (ev) => api('POST', `${CP}/api/events`, ev, mTlsOpts()),
      runAdapter: (check) => ADAPTERS[check.adapter](check.params),
      profile,
      log: (m) => console.log(m),
    },
  );
  console.log(`agent: monitor loop running (profile=${profile.profile_id}, interval=${CFG.check_interval_ms ?? 15000}ms)`);
}

// --- OTA update client (spec §3) --------------------------------------------
// Polls the control plane for a new signed RAUC bundle on a slow cadence. The
// signature verify is a hard gate inside runUpdateCycle; a failed verify never
// touches disk. mark-good/mark-bad run AFTER the reboot, against the booted
// slot, so a failed new slot falls back to the previous one (H2).
const CURRENT_VERSION = (() => { try { return fs.readFileSync('/etc/beacon-relay-version', 'utf8').trim(); } catch { return '0.1.0'; } })();
const UPDATE_PENDING_FLAG = '/data/.update-pending';
async function updateTick() {
  try {
    const r = await runUpdateCycle(
      { cpBase: CP, currentVersion: CURRENT_VERSION, deviceId },
      {
        fetchJson: async (url) => (await api('GET', url, null, mTlsOpts())).body,
        // binary mode: the bundle is raw octet-stream bytes, not JSON —
        // the previous JSON.stringify(utf8-body) path corrupted every byte
        // stream and could never have produced an installable bundle.
        // A non-200 response is treated as a failure: an empty or 404 body
        // must never be written to disk as a bundle (C4).
        fetchBytes: async (url) => {
          const r = await api('GET', url, null, { ...mTlsOpts(), binary: true });
          if (r.status !== 200) throw new Error(`bundle download failed: ${r.status}`);
          return r.body;
        },
      },
    );
    if (r.action !== 'none') console.log(`agent: update ${r.action} ${r.version ?? ''} ${r.reason ?? ''}`.trim());
    if (r.action === 'installed-pending-reboot') {
      // The verified bundle is in the inactive slot and RAUC has pointed
      // grubenv at it — the only way to test the new slot is to boot it.
      // Mark-good/mark-bad are intentionally NOT called here; they act on the
      // currently booted slot, which is still the old slot (H2).
      fs.writeFileSync(UPDATE_PENDING_FLAG, new Date().toISOString(), { mode: 0o600 });
      console.log('agent: update installed; rebooting into new slot');
      try { execSync('systemctl reboot', { stdio: 'pipe' }); }
      catch (e) { console.log(`agent: reboot request failed (non-fatal): ${e.message}`); }
    }
  } catch (e) { console.log(`agent: update check failed (non-fatal): ${e.message}`); }
}
setInterval(updateTick, CFG.update_interval_ms ?? 300_000);
updateTick();

// If the daemon started after an update-triggered reboot, run the post-boot
// health check on the NEW slot and either mark it good or roll back to the
// previous known-good slot (H2).
if (fs.existsSync(UPDATE_PENDING_FLAG)) {
  finishUpdateBoot(
    { cpBase: CP, deviceId },
    {
      fetchJson: async (url) => (await api('GET', url, null, mTlsOpts())).body,
    },
  ).then(r => {
    console.log(`agent: post-update boot ${r.action}: ${r.reason}`);
    fs.rmSync(UPDATE_PENDING_FLAG, { force: true });
  }).catch(e => {
    console.log(`agent: post-update boot check failed (non-fatal): ${e.message}`);
    fs.rmSync(UPDATE_PENDING_FLAG, { force: true });
  });
}

console.log(`agent: daemon running; version=${CURRENT_VERSION}; heartbeat=${CFG.heartbeat_ms}ms; tpm=${isTpm}; renew@${CFG.renew_fraction}`);
