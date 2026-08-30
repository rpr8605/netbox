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
    const version = args[0] ?? manifest().version;
    execFileSync('node', ['pipeline/build.js'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: version } });
    console.log(`standalone install file written under out/${version}`);
    return;
  }

  if (cmd === 'flash') {
    const target = args.find(a => a.startsWith('--target='))?.slice(9);
    if (!target) { console.error('flash requires --target=DEVICE'); process.exit(1); }
    const ps = execSync('wmic diskdrive get DeviceId,Model,Size --format:csv', { shell: 'cmd.exe' }).toString();
    console.log(ps);
    const ok = await confirmHard(target);
    if (!ok) { console.error('target not confirmed; aborting'); process.exit(1); }
    const version = args.find(a => /^v?\d/.test(a)) ?? manifest().version;
    execFileSync('bash', ['configurator/flash_wrapper.sh', version, target], { stdio: 'inherit' });
    return;
  }

  console.log('usage: configurator [releases|save <version>|flash <version> --target=DEV]');
}

main().catch(e => { console.error(e.message); process.exit(1); });
