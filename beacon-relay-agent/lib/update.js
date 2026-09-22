// beacon-relay-agent/lib/update.js
// Responsibility: the OTA update client (spec §3). Polls the control plane for
// a new signed RAUC bundle, verifies the signature BEFORE anything touches
// disk, applies it to the INACTIVE slot, and only marks it good after a
// successful boot + local health check — automatic rollback otherwise.
// Called by: agent.js daemon on a slow cadence (default 5 min).
//
// SAFETY (do not weaken): the signature check via `rauc info --keyring` runs
// on the downloaded bundle BEFORE `rauc install`. A bundle that fails
// verification is never installed — that is the entire trust boundary between
// "a release Ryan signed" and "arbitrary code on the device". The rollback
// guarantee comes from RAUC's A/B slots: the new slot is only marked good after
// a post-update boot + health check; a failed boot leaves the previous slot
// active.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

// checkForUpdate — ask the control plane for the latest release version and
// compare to the running one. Returns { updateAvailable, latestVersion }.
// A CP that is unreachable or answers non-JSON means "no update", never throw.
export async function checkForUpdate(ctx, fetchJson) {
  try {
    const r = await fetchJson(`${ctx.cpBase}/api/releases/latest`);
    const latest = r?.version;
    return { updateAvailable: Boolean(latest && latest !== ctx.currentVersion), latestVersion: latest ?? null };
  } catch {
    return { updateAvailable: false, latestVersion: null };
  }
}

// downloadBundle — fetch the signed bundle to a temp path on /data (the
// writable partition). Returns the path. No signature check here — that is a
// separate, mandatory step (verifyBundle) so a bad bundle can't be installed.
export async function downloadBundle(ctx, version, fetchBytes) {
  const url = `${ctx.cpBase}/api/releases/${version}/bundle`;
  const bytes = await fetchBytes(url);
  const tmp = `/data/.update-${version}.raucb`;
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
  try {
    const out = execSync(`rauc info --keyring ${keyringPath} ${bundlePath} 2>&1`, { encoding: 'utf8', env: { ...process.env, TMPDIR: '/run' } });
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
    const out = execSync(`rauc install ${bundlePath} 2>&1`, { encoding: 'utf8', env: { ...process.env, TMPDIR: '/run' } });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? e.message ?? e) };
  }
}

// markGood — called after a successful boot into the new slot + passing the
// local health check. Until this runs, RAUC will roll back to the previous
// known-good slot on the next boot failure. This is the rollback guarantee.
export function markGood() {
  try { execSync('rauc status mark-good', { stdio: 'pipe' }); return true; }
  catch { return false; }
}

// runUpdateCycle — one full pass: check -> download -> VERIFY -> apply. The
// ordering is load-bearing: verify is a hard gate, not a log line. Returns a
// result object the caller can log/emit. Never throws.
export async function runUpdateCycle(ctx, { fetchJson, fetchBytes } = {}) {
  const { updateAvailable, latestVersion } = await checkForUpdate(ctx, fetchJson);
  if (!updateAvailable) return { action: 'none', reason: 'up to date', currentVersion: ctx.currentVersion };
  const bundlePath = await downloadBundle(ctx, latestVersion, fetchBytes);
  if (!verifyBundle(bundlePath)) {
    fs.rmSync(bundlePath, { force: true });
    return { action: 'rejected', reason: 'signature verification failed', version: latestVersion };
  }
  const applied = applyBundle(bundlePath);
  fs.rmSync(bundlePath, { force: true });
  return applied.ok
    ? { action: 'installed', version: latestVersion, note: 'mark-good pending post-boot health check' }
    : { action: 'install-failed', version: latestVersion, reason: (applied.out ?? '').trim().slice(-400) };
}
