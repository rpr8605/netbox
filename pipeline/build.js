#!/usr/bin/env node
// pipeline/build.js — orchestrates the image build via compose.build.yml and
// writes out/manifest.json (the Configurator CLI's list-releases input).
// Manifest fields are the CLI contract; keep additive-only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const version = process.env.RELEASE_VERSION ?? '0.1.0';

// --- Stage agent source BEFORE any container step reads it -------------------
// The repo-root netbox-agent/ is the SINGLE source of truth for the device
// agent. pipeline/rootfs_files/opt/netbox-agent/ is a GENERATED artifact, not
// hand-maintained source — it was previously a manually-committed duplicate,
// and it drifted: the rootfs tree was missing graph.js, post_event.js,
// signal_emit.js, and backup_risk.js, so a built device image silently shipped
// none of Step 1's security-signal code. 30-agent.sh stages FROM rootfs_files,
// so the copy must happen here, on the host, before `docker compose ... up`
// mounts /work. Plain recursive copy — never a symlink: this repo is developed
// from Windows (PowerShell/WSL), and NTFS symlinks need elevation/Developer
// Mode and break under docker bind mounts and cross-OS git checkouts.
const AGENT_SRC = 'netbox-agent';
const AGENT_DST = 'pipeline/rootfs_files/opt/netbox-agent';
fs.rmSync(AGENT_DST, { recursive: true, force: true });      // drop any stale tree
fs.cpSync(AGENT_SRC, AGENT_DST, { recursive: true });        // full clean copy

// Hard gate, not a log line: the failure mode being prevented is a rootfs that
// builds "successfully" while missing the signal code — exactly the bug above.
const REQUIRED_AGENT_FILES = [
  'agent.js', 'provision.js',
  'lib/graph.js', 'lib/post_event.js', 'lib/signal_emit.js', 'lib/backup_risk.js',
  'lib/enroll.js', 'lib/issue_cert.js', 'lib/tpm.js',
  // EHR/EMR integration layer (EHR spec §2 adapters + orchestrator)
  'lib/http_json.js', 'lib/net_checks.js', 'lib/fhir_r4.js', 'lib/mirth_admin.js', 'lib/ehr_check.js',
];
const missing = REQUIRED_AGENT_FILES.filter(f => !fs.existsSync(path.join(AGENT_DST, f)));
if (missing.length) {
  console.error('agent staging incomplete; missing from ' + AGENT_DST + ': ' + missing.join(', '));
  process.exit(1);
}
console.log(`staged ${REQUIRED_AGENT_FILES.length} agent files into ${AGENT_DST}`);

// 1) Emit the release-signing root first (in-worker openssl; emits into /out
//    release-sign/build/ via the out mount). The private key is REUSED at pack
//    time by 40-rauc.sh (RAUC packs signed bundles only) and verified with the
//    same public cert at verify_bundle; it never enters the image itself.
execFileSync('docker', ['compose',
  '-f', 'pipeline/compose.assemble.yml',
  '--project-name', 'netbox-image',
  'run', '--rm',
  '--entrypoint', 'bash',
  'assemble', '/work/pipeline/emit_release_root.sh'], { stdio: 'inherit' });

// 2) Image build: 00→40, where 40 packs an UNSIGNED .raucb (under /out/<v>/).
// --force-recreate is REQUIRED, not cosmetic: the worker keeps /target inside
// its container FS, and `compose up` will happily reuse a previous exited
// container whose half-built rootfs makes debootstrap die with "file already
// exists". Every build must start from a fresh container.
execFileSync('docker', ['compose',
  '-f', 'pipeline/compose.build.yml',
  '--project-name', 'netbox-image',
  'up', '--build', '--force-recreate', '--abort-on-container-exit', 'image-build'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: version } });

// 3) Signing happens inside 40-rauc.sh at pack time (RAUC embeds CMS over the
//    manifest while packing; without key material RAUC won't produce a bundle).

// 4) Verify the signed bundle against the release root (pre-assemble, so a bad
//    signature fails before any disk.img is laid down). Runs in the image-build
//    container: rauc(1.8) mmap's the bundle, and the assemble container's
//    bind-mounted /out is DrvFS from Windows, which RAUC rejects ("unknown
//    filesystem type=1021997"). verify_bundle.sh copies to container-local
//    storage; it needs rauc installed, which only image-build has.
execFileSync('docker', ['compose',
  '-f', 'pipeline/compose.build.yml',
  '--project-name', 'netbox-image',
  'run', '--rm', '--no-deps',
  '--entrypoint', 'bash',
  'image-build', `/work/pipeline/verify_bundle.sh`, version], { stdio: 'inherit' });

// 5) Partition map → flashable disk assembly (privileged; full-rootfs embed).
execFileSync('node', ['pipeline/gen_sfdisk.js', version], { stdio: 'inherit' });
execFileSync('docker', ['compose',
  '-f', 'pipeline/compose.assemble.yml',
  '--project-name', 'netbox-image',
  'up', '--build', '--abort-on-container-exit', 'assemble'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: version } });

const sha = fs.readFileSync(`out/${version}/SHA256SUMS`, 'utf8').trim().split('\n');
const manifest = {
  version,
  built_at: new Date().toISOString(),
  artifacts: sha.map(l => {
    const [digest, path] = l.split(/\s+/, 2);
    return { path, sha256: digest };
  }),
  flash_path: `out/${version}/netbox-disk.img`,
  bundle_path: `out/${version}`,
};
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/manifest.json', JSON.stringify(manifest, null, 2));
console.log('manifest written: out/manifest.json');
