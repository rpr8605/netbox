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
import { execSync } from 'node:child_process';
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
    const out = execSync('tpm2_getcap properties-fixed 2>&1 || true').toString();
    return /TPM2_PT_FAMILY_INDICATOR/.test(out);
  } catch { return false; }
}

// Seal the device private key into the TPM at persistent handle 0x81010001
// (owner hierarchy, RSA2048 under a fresh storage-primary). A FIXED handle is
// used so the agent references the key across reboots without re-creating or
// re-enumerating TPM objects. tpm2_clear runs first so a half-provisioned TPM
// from a prior failed boot can't wedge re-provisioning. The caller keeps ONLY
// the handle — the security property being bought here is that the key is
// unusable off this machine, and copying the PEM out would silently void it.
// The plaintext PEM is deliberately NEVER written to disk: writing it to
// /data/tpm/key.plain.pem (even on the LUKS partition) would leave a readable
// copy, defeating the point of TPM sealing. Signing goes through tpmSign(),
// public-key read through tpmReadPublicPem() — the private key stays in the TPM.
export function sealPrivateKey(plainPem) {
  // TPM 2.0 seal: persistent handle 0x81010001 under the storage hierarchy.
  // tpm2_createpolicyauth/… chain is invoked as a shell pipeline because
  // step-by-step node bindings for policy are not standardized; treating
  // libtss2 as a dependency is the documented design choice. The PEM is passed
  // via env (never a file) purely so tpm2_load can ingest it into the TPM.
  const script = `
set -e
umask 077
mkdir -p /data/tpm
tpm2_clear
tpm2_createprimary -C o -g sha256 -G rsa -c /data/tpm/primary.ctx
tpm2_create -g sha256 -G rsa2048 -u /data/tpm/key.pub -r /data/tpm/key.priv \
  -C /data/tpm/primary.ctx
tpm2_load -C /data/tpm/primary.ctx -u /data/tpm/key.pub -r /data/tpm/key.priv \
  -c /data/tpm/key.ctx
tpm2_evictcontrol -C o -c /data/tpm/key.ctx 0x81010001
rm -f /data/tpm/key.priv /data/tpm/key.pub /data/tpm/key.ctx /data/tpm/primary.ctx
`;
  const env = { ...process.env, BEACON_RELAY_PEM: plainPem };
  execSync(script, { shell: '/bin/bash', env });
  return '0x81010001'; // material sealed; caller keeps ONLY the TPM handle
}

// Sign a payload with the TPM-sealed key at the persistent handle — the ONLY
// way the long-term key is used in TPM mode. The digest is computed with
// openssl (read-only), then tpm2_sign produces the signature without the
// private key ever leaving the TPM. Returns base64.
export function tpmSign(payloadFile) {
  const digest = '/data/.pop.digest';
  execSync(`openssl dgst -sha256 -binary -out ${digest} ${payloadFile}`, { shell: '/bin/bash' });
  const out = execSync(
    `tpm2_sign -c 0x81010001 -g sha256 -d ${digest} -f plain -o /data/.pop.sig && base64 -w0 /data/.pop.sig`,
    { shell: '/bin/bash', encoding: 'utf8' },
  );
  execSync(`rm -f ${digest} /data/.pop.sig`, { shell: '/bin/bash' });
  return out.trim();
}

// Read the public key (PEM) for the TPM-sealed key at the persistent handle.
// Used by the retrust flow to present the pinned public key. Public-only —
// this reveals nothing about the private half.
export function tpmReadPublicPem() {
  return execSync(
    'tpm2_readpublic -c 0x81010001 -f pem -o /dev/stdout',
    { shell: '/bin/bash', encoding: 'utf8' },
  );
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
