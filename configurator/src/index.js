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

function confirmHard(targetText) {
  console.log('!!! WRITE TARGET CONFIRMATION REQUIRED');
  console.log(`Target device: ${targetText}`);
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
    // copies out/<version>/netbox-disk.img and verifies the copy's SHA256
    // against the source so the standalone file is provably the same artifact.
    const version = args[0] ?? manifest().version;
    const src = `out/${version}/netbox-disk.img`;
    if (!fs.existsSync(src)) { console.error(`no built image at ${src} — run the pipeline first`); process.exit(1); }
    const dest = `out/${version}/netbox-install-${version}.img`;
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
    // Device listing is for real drives; a file target (QEMU/dev path) skips
    // the wmic enumeration but keeps the unmissable confirm gate below.
    const isFile = /\.(raw|img)$/.test(target) || fs.existsSync(target);
    if (!isFile) {
      const ps = execSync('wmic diskdrive get DeviceId,Model,Size --format:csv', { shell: 'cmd.exe' }).toString();
      console.log(ps);
    } else {
      console.log(`file target (QEMU/dev path): ${target}`);
    }
    const ok = await confirmHard(target);
    if (!ok) { console.error('target not confirmed; aborting'); process.exit(1); }
    const version = args.find(a => /^v?\d/.test(a)) ?? manifest().version;
    execFileSync('bash', ['configurator/flash_wrapper.sh', version, target], { stdio: 'inherit' });
    return;
  }

  console.log('usage: configurator [releases|save <version>|flash <version> --target=DEV]');
}

main().catch(e => { console.error(e.message); process.exit(1); });
