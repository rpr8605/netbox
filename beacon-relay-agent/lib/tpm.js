// beacon-relay-agent/lib/tpm.js
// Responsibility: detect whether this machine has a usable TPM 2.0 and, when
// it does, seal the device's long-term private key into it. When it does not,
// fall back to the LUKS-sealed software keyfile — the keyfile itself lives on
// the LUKS DATA partition, never on unencrypted /boot.
//
// Callers/usage:
//   - beacon-relay-agent/provision.js (first boot): tpmPresent() decides which of
//     the two device-key strategies runs.
//   - beacon-relay-agent/agent.js (daemon): tpmPresent() informs self-health and the
//     TPM-vs-LUKS label attached to check_result events.
//
// Safety note: sealing policy here is machine-local (RSA storage-primary +
// authPolicy under the standard EK hierarchy via libtss2). The VM harness
// exercises this through swtpm; nothing in this file assumes hardware vs
// software TPM.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// Probe for a usable TPM 2.0 (hardware TPM and the harness's swtpm answer
// identically). This is the branch point for the whole device-key strategy:
// true -> key sealed into the TPM; false -> LUKS software-keyfile fallback.
// Probe failure deliberately returns false, never throws — first boot must
// degrade to the still-encrypted-at-rest LUKS path rather than die. Never
// invert that failure direction: reporting a TPM that isn't there would seal
// nothing while claiming hardware backing.
export function tpmPresent() {
  try {
    const out = execFileSync('tpm2_getcap', ['properties-fixed'], { encoding: 'utf8' });
    return /TPM2_PT_FAMILY_INDICATOR/.test(out);
  } catch { return false; }
}

// Seal the device private key into the TPM at persistent handle 0x81010001
// (owner hierarchy, RSA2048 under a fresh storage-primary). A FIXED handle is
// used so the agent references the key across reboots without re-creating or
// re-enumerating TPM objects. A stale object at that handle from a prior
// failed provisioning is evicted first so it can't wedge re-provisioning —
// but NEVER wipe the whole TPM here: tpm2_clear rotates the storage-hierarchy
// seed, and every sealed object / primary derived from the old seed becomes
// permanently unloadable (tpm2_load 0x1DF "integrity check failed" on the
// next boot). decrypt-data.service seals the LUKS unlock blob under the same
// hierarchy EARLIER in this same boot, so a clear here bricks /data at the
// device's first reboot — verified in the QEMU harness. The caller keeps ONLY
// the handle — the security property being bought here is that the key is
// unusable off this machine, and copying the PEM out would silently void it.
// The plaintext PEM is deliberately NEVER written to disk: writing it to
// /data/tpm/key.plain.pem (even on the LUKS partition) would leave a readable
// copy, defeating the point of TPM sealing. Signing goes through tpmSign(),
// public-key read through tpmReadPublicPem() — the private key stays in the TPM.
export function sealPrivateKey(plainPem) {
  // TPM 2.0 seal: persistent handle 0x81010001 under the storage hierarchy.
  // The key is generated INSIDE the TPM via tpm2_create, so the private key
  // never exists in software (M4). Each command is invoked with an argv array
  // via execFileSync — no shell, no template strings, no argument injection
  // (C4).
  //
  // Evict ONLY this function's own stale handle (re-provisioning after a prior
  // failed attempt). Do NOT substitute tpm2_clear: TPM2_Clear rotates the
  // storage seed and orphans the LUKS sealed blob decrypt-data.service created
  // under the same hierarchy minutes earlier — the device then bricks on its
  // first reboot (0x1DF integrity failure, proven in vm-harness).
  fs.mkdirSync('/data/tpm', { recursive: true, mode: 0o700 });
  try {
    execFileSync('tpm2_evictcontrol', ['-C', 'o', '-c', '0x81010001'], { stdio: 'pipe' });
  } catch { /* stale handle may not exist; ignore */ }
  execFileSync('tpm2_createprimary', ['-C', 'o', '-g', 'sha256', '-G', 'rsa', '-c', '/data/tpm/primary.ctx'], { stdio: 'pipe' });
  execFileSync('tpm2_create', ['-g', 'sha256', '-G', 'rsa2048', '-u', '/data/tpm/key.pub', '-r', '/data/tpm/key.priv', '-C', '/data/tpm/primary.ctx'], { stdio: 'pipe' });
  execFileSync('tpm2_load', ['-C', '/data/tpm/primary.ctx', '-u', '/data/tpm/key.pub', '-r', '/data/tpm/key.priv', '-c', '/data/tpm/key.ctx'], { stdio: 'pipe' });
  execFileSync('tpm2_evictcontrol', ['-C', 'o', '-c', '/data/tpm/key.ctx', '0x81010001'], { stdio: 'pipe' });
  for (const f of ['key.priv', 'key.pub', 'key.ctx', 'primary.ctx']) {
    fs.rmSync(`/data/tpm/${f}`, { force: true });
  }
  return '0x81010001'; // material sealed; caller keeps ONLY the TPM handle
}

// Sign a payload with the TPM-sealed key at the persistent handle — the ONLY
// way the long-term key is used in TPM mode. The digest is computed with
// openssl (read-only), then tpm2_sign produces the signature without the
// private key ever leaving the TPM. Returns base64.
export function tpmSign(payloadFile) {
  const digest = '/data/.pop.digest';
  // argv arrays, no shell: the payload/digest paths cannot be reinterpreted
  // as shell syntax (C4).
  execFileSync('openssl', ['dgst', '-sha256', '-binary', '-out', digest, payloadFile]);
  execFileSync('tpm2_sign', ['-c', '0x81010001', '-g', 'sha256', '-d', digest, '-f', 'plain', '-o', '/data/.pop.sig']);
  const out = execFileSync('base64', ['-w0', '/data/.pop.sig'], { encoding: 'utf8' });
  for (const f of [digest, '/data/.pop.sig']) {
    fs.rmSync(f, { force: true });
  }
  return out.trim();
}

// Read the public key (PEM) for the TPM-sealed key at the persistent handle.
// Used by the retrust flow to present the pinned public key. Public-only —
// this reveals nothing about the private half.
export function tpmReadPublicPem() {
  return execFileSync('tpm2_readpublic', ['-c', '0x81010001', '-f', 'pem', '-o', '/dev/stdout'], { encoding: 'utf8' });
}

// Software-key fallback for machines with no TPM (tpmPresent() === false):
// write the keyfile onto /data — the LUKS-encrypted partition — mode 0400.
// The at-rest protection here is dm-crypt's guarantee, not anything this
// function adds, which is exactly why targetPath must never point at
// unencrypted /boot. Weaker than TPM sealing only against an attacker who can
// unlock the disk; that caveat lives in the decrypt-data.service unit comment.
export function luksSealPrivateKey(plainPem, targetPath) {
  // Software fallback: keyfile written onto /data (LUKS-encrypted partition).
  // Nothing additional to do — the data partition is already ciphertext when
  // the disk is removed; sealing-at-rest is the dm-crypt guarantee. The
  // strong caveat lives in the decrypt-data.service unit comment.
  fs.writeFileSync(targetPath, plainPem, { mode: 0o400 });
  return targetPath;
}
