// beacon-relay-agent/lib/update.js
// Responsibility: the OTA update client. Polls the control plane for a new
// signed RAUC bundle, writes it to /data, verifies the signature BEFORE
// `rauc install`, applies it to the INACTIVE slot, reboots, and only marks the
// new slot good after a successful post-reboot health check — automatic
// rollback to the previous slot otherwise. The staged-rollout path obeys the
// control plane's percentage-based assignment.
// Called by: agent.js daemon on a slow cadence (default 5 min).
//
// SAFETY (do not weaken): the signature check via `rauc info --keyring` runs
// on the downloaded bundle BEFORE `rauc install`. A bundle that fails
// verification is never installed — that is the entire trust boundary between
// "a release Ryan signed" and "arbitrary code on the device". The bundle file
// is written before verification, then deleted if verification fails. The
// rollback guarantee comes from RAUC's A/B slots: the new slot is only marked
// good after a post-reboot health check; a failed boot leaves the previous slot
// active.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Writable data directory. On the device this is /data; tests override it with
// a temp directory so a real /data folder is never required.
const DATA_DIR = process.env.BEACON_DATA_DIR ?? '/data';

// Strict version format: major.minor.patch with an optional pre-release label.
// This is the only shape the update client will write to disk or pass to rauc.
// Anything else (shell metacharacters, path traversal, whitespace) is rejected
// before it can reach the filesystem or any command invocation (C4).
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

export function validateVersion(v) {
  return typeof v === 'string' && VERSION_RE.test(v);
}

// checkForUpdate — ask the control plane for the latest release version and
// compare to the running one. The device_id is included so the staged rollout
// policy can decide whether this device is in the rollout group. Returns
// { updateAvailable, latestVersion }. A CP that is unreachable or answers
// non-JSON means "no update", never throw.
export async function checkForUpdate(ctx, fetchJson) {
  try {
    const q = ctx.deviceId ? `?device_id=${encodeURIComponent(ctx.deviceId)}` : '';
    const r = await fetchJson(`${ctx.cpBase}/api/releases/latest${q}`);
    const latest = r?.version;
    return { updateAvailable: Boolean(latest && latest !== ctx.currentVersion), latestVersion: latest ?? null };
  } catch {
    return { updateAvailable: false, latestVersion: null };
  }
}

// downloadBundle — fetch the signed bundle to a temp path on /data (the
// writable partition). Returns the path. No signature check here — that is a
// separate, mandatory step (verifyBundle) so a bad bundle can't be installed.
// The version is validated before it is embedded in a URL or filesystem path
// (C4): a malformed version never reaches the network or disk.
export async function downloadBundle(ctx, version, fetchBytes) {
  if (!validateVersion(version)) {
    throw new Error(`invalid version string: ${String(version).slice(0, 80)}`);
  }
  const url = `${ctx.cpBase}/api/releases/${version}/bundle`;
  const bytes = await fetchBytes(url);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = path.join(DATA_DIR, `.update-${version}.raucb`);
  fs.writeFileSync(tmp, bytes);
  return tmp;
}

// verifyBundle — the signature gate. `rauc info --keyring` against the
// release-signing root. Returns true only if the CMS chain verifies. This MUST
// run before install; it is the whole point of signing the bundle.
export function verifyBundle(bundlePath, keyringPath = '/etc/beacon-relay-release-root.crt') {
  // TMPDIR=/run: rauc extracts the bundle manifest into a g_get_tmp_dir()
  // scratch dir; the image root (incl. /tmp) is read-only, and /run is the
  // writable tmpfs already used for RAUC's mountprefix. Without this, rauc
  // exits 1 AFTER the signature verifies ("Failed to create tmp dir ...
  // Read-only file system") and every good bundle is rejected.
  //
  // execFileSync with an arg array avoids a shell entirely: the bundle path
  // is passed as a single argv element and cannot be reinterpreted as shell
  // syntax, even if the version string were somehow malformed (C4).
  try {
    const out = execFileSync('rauc', ['info', '--keyring', keyringPath, bundlePath], {
      encoding: 'utf8', env: { ...process.env, TMPDIR: '/run' },
    });
    const verified = /Verified/.test(out);
    // A rejected gate with no captured reason is undebuggable on a headless
    // appliance — log rauc's own words, not just the generic label.
    if (!verified) console.log(`agent: verifyBundle: no 'Verified' line in rauc output: ${out.trim()}`);
    return verified;
  } catch (e) {
    console.log(`agent: verifyBundle: rauc exited ${e.status ?? '?'}: ${String(e.stdout ?? e.message ?? e).trim()}`);
    return false;
  }
}

// applyBundle — install the verified bundle to the INACTIVE slot. RAUC handles
// slot selection; we only mark the new slot good after a post-update boot +
// health check (markGood). Returns { ok, out } — rauc's own output is kept
// because an install failure with no captured reason is undebuggable on a
// headless appliance.
export function applyBundle(bundlePath) {
  try {
    // TMPDIR=/run: same read-only-/tmp constraint as verifyBundle above.
    // argv array, no shell: the bundle path cannot be split or injected (C4).
    const out = execFileSync('rauc', ['install', bundlePath], {
      encoding: 'utf8', env: { ...process.env, TMPDIR: '/run' },
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? e.message ?? e) };
  }
}

// markGood — called after a successful boot into the new slot + passing the
// local health check. Until this runs, RAUC will roll back to the previous
// known-good slot on the next boot failure. This is the rollback guarantee.
export function markGood() {
  try { execFileSync('rauc', ['status', 'mark-good'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

// rollback — called when the post-update health check fails. RAUC marks the
// current (new) slot bad so the bootloader will revert to the previous
// known-good slot on the next boot.
export function rollback() {
  try { execFileSync('rauc', ['status', 'mark-bad'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

// performHealthCheck — post-update sanity check before marking the new slot
// good. Default implementation checks control-plane reachability via the
// device's existing mTLS path; callers may inject a different check. Returns
// { healthy: boolean, detail: string }.
export async function performHealthCheck(ctx, fetchJson) {
  try {
    const r = await fetchJson(`${ctx.cpBase}/api/health`);
    return { healthy: r?.ok === true, detail: 'control-plane health check' };
  } catch (e) {
    return { healthy: false, detail: String(e.message ?? e) };
  }
}

// runUpdateCycle — one full pass: check -> download -> VERIFY -> apply ->
// reboot. The ordering is load-bearing: verify is a hard gate, not a log line.
// The slot MUST NOT be marked good or bad in this cycle; those commands act on
// the *currently booted* slot, which is still the OLD slot until after reboot
// (H2). Returns a result object the caller can log/emit. Never throws. Hooks
// (verifyBundle, applyBundle) are injectable so tests can prove the policy
// paths without a real RAUC installation.
export async function runUpdateCycle(ctx, deps = {}) {
  const {
    fetchJson, fetchBytes,
    verifyBundleFn = verifyBundle,
    applyBundleFn = applyBundle,
  } = deps;

  const { updateAvailable, latestVersion } = await checkForUpdate(ctx, fetchJson);
  if (!updateAvailable) return { action: 'none', reason: 'up to date', currentVersion: ctx.currentVersion };

  // Defense in depth: validate the version again before it is used as a URL
  // segment, filesystem path, or command argument (C4).
  if (!validateVersion(latestVersion)) {
    return { action: 'rejected', reason: 'invalid version string', version: latestVersion };
  }

  let bundlePath;
  try {
    bundlePath = await downloadBundle(ctx, latestVersion, fetchBytes);
  } catch (e) {
    return { action: 'rejected', reason: `download failed: ${e.message}`, version: latestVersion };
  }

  if (!verifyBundleFn(bundlePath)) {
    fs.rmSync(bundlePath, { force: true });
    return { action: 'rejected', reason: 'signature verification failed', version: latestVersion };
  }

  const applied = applyBundleFn(bundlePath);
  fs.rmSync(bundlePath, { force: true });
  if (!applied.ok) {
    return { action: 'install-failed', version: latestVersion, reason: (applied.out ?? '').trim().slice(-400) };
  }

  // Install succeeded. The only way to test the new slot is to boot it, so the
  // cycle ends here and the caller triggers a reboot. Mark-good/mark-bad run
  // post-boot against the NEW slot (H2).
  return { action: 'installed-pending-reboot', version: latestVersion, reason: 'installed, rebooting into new slot' };
}

// finishUpdateBoot — post-reboot health check for the slot that just booted.
// Must be called once after a reboot that was triggered by runUpdateCycle.
//   - healthy: mark the booted (new) slot good and keep it as the default.
//   - unhealthy: mark the booted (new) slot bad so RAUC falls back to the
//     previous known-good slot on the next reboot, then reboot now.
// Returns a result object the caller can log/emit.
export async function finishUpdateBoot(ctx, deps = {}) {
  const {
    fetchJson,
    healthCheckFn = performHealthCheck,
    markGoodFn = markGood,
    rollbackFn = rollback,
    rebootFn = systemReboot,
  } = deps;

  const health = await healthCheckFn(ctx, fetchJson);
  if (health.healthy) {
    const marked = markGoodFn();
    return {
      action: 'boot-marked-good',
      reason: marked ? 'post-reboot health check passed, slot marked good' : 'health check passed, mark-good failed',
    };
  }

  rollbackFn();
  rebootFn();
  return { action: 'boot-rolled-back', reason: `post-reboot health check failed: ${health.detail}` };
}

function systemReboot() {
  try { execFileSync('systemctl', ['reboot'], { stdio: 'pipe' }); }
  catch { /* non-fatal; log only */ }
}
