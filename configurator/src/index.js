#!/usr/bin/env node
// configurator/src/index.js — the Configurator CLI (replaces "CLI if faster"
// ambiguity from §2). Commands:
//   releases        list index/manifest.json entries + artifact SHA256s
//   flash <version> detect removable drives, require --target=DEVNAME with an
//                   unmissable confirm prompt, write the disk image with
//                   progress, then verify the written image against SHA256
//   save <version>  write the same disk image to a standalone file (same
//                   artifact, second path — the "install file" form)
// The CLI calls into API-safe shell wrappers; it does not itself flash qemus.
import fs from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import readline from 'node:readline';

const [,, cmd, ...args] = process.argv;

function manifest() {
  const m = JSON.parse(fs.readFileSync('out/manifest.json', 'utf8'));
  return m;
}

// --- drive detection + boot-disk guard --------------------------------------
// The flash command's #1 job is to never destroy the wrong disk. Detection is
// cross-platform: wmic on Windows, lsblk on Linux, diskutil on macOS. The
// boot-disk exclusion is enforced BEFORE the confirm prompt — a target that is
// (or contains) the host's own boot/system disk is refused outright, not
// merely warned about.

// Return an array of { id, model, sizeBytes } for physical disks, per-OS.
// Detection failures return an empty array (the confirm gate still runs).
function detectDrives() {
  const p = process.platform;
  try {
    if (p === 'win32') {
      const out = execSync('wmic diskdrive get DeviceId,Model,Size --format:csv', { shell: 'cmd.exe' }).toString();
      return out.split('\n').slice(1).map(l => l.trim()).filter(Boolean).map(l => {
        const parts = l.split(',');
        return { id: parts[1], model: parts[2] ?? '', sizeBytes: Number(parts[3] ?? 0) };
      }).filter(d => d.id);
    }
    if (p === 'linux') {
      const out = execSync("lsblk -b -d -n -o NAME,MODEL,SIZE", { shell: '/bin/bash' }).toString();
      return out.split('\n').filter(Boolean).map(l => {
        const m = l.trim().split(/\s+/);
        return { id: `/dev/${m[0]}`, model: m.slice(1, -1).join(' ') || '', sizeBytes: Number(m[m.length - 1] ?? 0) };
      });
    }
    if (p === 'darwin') {
      const out = execSync('diskutil list -physical', { shell: '/bin/sh' }).toString();
      return out.split('\n').map(l => l.trim()).filter(l => l.startsWith('/dev/disk')).map(l => {
        const m = l.match(/^(\/dev\/disk\d+)/);
        return m ? { id: m[1], model: '', sizeBytes: 0 } : null;
      }).filter(Boolean);
    }
  } catch { /* detection is best-effort; the guard below is the hard gate */ }
  return [];
}

// The host's own boot/system root device. We must NEVER flash it. On Windows
// that's the disk holding C:\; on Linux/macOS it's the root / mount's source.
// Best-effort: if we can't determine it, we still run the confirm gate — but
// where we CAN determine it, a match is a hard refusal.
function hostBootDisk() {
  const p = process.platform;
  try {
    if (p === 'win32') {
      // The disk index of the system drive via partition->disk mapping.
      const out = execSync('wmic partition where "BootPartition=true" get DiskIndex --format:csv', { shell: 'cmd.exe' }).toString();
      const idx = out.split('\n').map(s => s.trim()).filter(Boolean).pop()?.split(',').pop();
      return idx != null ? `\\\\.\\PHYSICALDRIVE${idx}` : null;
    }
    if (p === 'linux') {
      const src = execSync("findmnt -n -o SOURCE /", { shell: '/bin/bash' }).toString().trim(); // e.g. /dev/sda1
      const m = src.match(/^(\/dev\/[a-z]+)/);
      return m ? m[1] : src;
    }
    if (p === 'darwin') {
      const out = execSync("diskutil info / | grep 'Device Node'", { shell: '/bin/sh' }).toString();
      const m = out.match(/\/dev\/(disk\d+)/);
      return m ? `/dev/${m[1]}` : null;
    }
  } catch { /* can't determine boot disk; confirm gate still runs */ }
  return null;
}

// Hard refusal: is the target the host's boot disk (or a partition of it)?
// bootOverride is test-only: lets a test inject the boot path so the guard's
// prefix logic is exercised deterministically regardless of the host OS.
function isBootDisk(target, bootOverride = undefined) {
  const boot = bootOverride !== undefined ? bootOverride : hostBootDisk();
  if (!boot) return false;
  return target === boot || target.startsWith(boot);
}

function fmtBytes(n) {
  if (!n) return 'unknown size';
  return `${(n / 1e9).toFixed(1)} GB`;
}

function confirmHard(targetText, drive) {
  console.log('!!! WRITE TARGET CONFIRMATION REQUIRED');
  console.log(`Target device: ${targetText}`);
  if (drive) console.log(`Drive model:    ${drive.model || 'unknown'}\nDrive size:     ${fmtBytes(drive.sizeBytes)}`);
  console.log('Type the full device path exactly to proceed.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question('Confirm target (exact string): ', ans => {
    rl.close(); res(ans === targetText);
  }));
}

async function main() {
  if (cmd === 'releases') {
    const m = manifest();
    console.log(`releases → version ${m.version} (built ${m.built_at})`);
    for (const a of m.artifacts) console.log(`  ${a.sha256.slice(0, 12)}… ${a.path}`);
    console.log(`flash image: ${m.flash_path ?? '(unassembled)'}`);
    console.log(`bundle path: ${m.bundle_path}`);
    return;
  }

  if (cmd === 'save') {
    // "Save as standalone install file": export the ALREADY-BUILT artifact —
    // same image, second path (spec Phase 3 step 5). Does NOT rebuild; it
    // copies out/<version>/beacon-relay-disk.img and verifies the copy's SHA256
    // against the source so the standalone file is provably the same artifact.
    const version = args[0] ?? manifest().version;
    const src = `out/${version}/beacon-relay-disk.img`;
    if (!fs.existsSync(src)) { console.error(`no built image at ${src} — run the pipeline first`); process.exit(1); }
    const dest = `out/${version}/beacon-relay-install-${version}.img`;
    fs.copyFileSync(src, dest);
    // Stream the SHA256 — the image is multi-GB; readFileSync throws >2 GiB.
    const { createHash } = await import('node:crypto');
    const sum = p => new Promise((res, rej) => {
      const h = createHash('sha256');
      fs.createReadStream(p).on('data', c => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
    });
    if (await sum(src) !== await sum(dest)) { console.error('save: sha256 mismatch after copy'); process.exit(1); }
    console.log(`standalone install file: ${dest}`);
    console.log(`sha256 verified identical to ${src}`);
    return;
  }

  if (cmd === 'flash') {
    const target = args.find(a => a.startsWith('--target='))?.slice(9);
    if (!target) { console.error('flash requires --target=DEVICE'); process.exit(1); }
    // Boot-disk exclusion is a HARD REFUSAL, enforced before any confirm prompt
    // (spec §12 step 5: "refuse to proceed on a drive that looks like the
    // machine's own boot disk"). A file target (QEMU/dev path) is exempt — it
    // is not a physical drive and can never be the boot disk.
    const isFile = /\.(raw|img)$/.test(target) || (fs.existsSync(target) && fs.statSync(target).isFile());
    if (!isFile) {
      if (isBootDisk(target)) {
        console.error(`REFUSED: ${target} is (or contains) this machine's boot/system disk.`);
        process.exit(1);
      }
      const drives = detectDrives();
      const drive = drives.find(d => d.id === target || target.startsWith(d.id));
      console.log('Detected drives:');
      for (const d of drives) console.log(`  ${d.id}  ${d.model}  ${fmtBytes(d.sizeBytes)}`);
      if (drive) console.log(`-> target ${target} resolves to: ${drive.model} (${fmtBytes(drive.sizeBytes)})`);
      const ok = await confirmHard(target, drive);
      if (!ok) { console.error('target not confirmed; aborting'); process.exit(1); }
    } else {
      console.log(`file target (QEMU/dev path): ${target}`);
      const ok = await confirmHard(target, null);
      if (!ok) { console.error('target not confirmed; aborting'); process.exit(1); }
    }
    const version = args.find(a => /^v?\d/.test(a)) ?? manifest().version;
    execFileSync('bash', ['configurator/flash_wrapper.sh', version, target], { stdio: 'inherit' });
    return;
  }

  console.log('usage: configurator [releases|save <version>|flash <version> --target=DEV]');
}

import { fileURLToPath } from 'node:url';

// Exported for tests (scripts/test_configurator.js) — these are pure
// functions of (platform, target); main() only runs when invoked directly.
export { detectDrives, hostBootDisk, isBootDisk, fmtBytes };

// Only run the CLI when invoked directly, not when imported by a test.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
