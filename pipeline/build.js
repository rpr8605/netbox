#!/usr/bin/env node
// pipeline/build.js — orchestrates the image build via compose.build.yml and
// writes out/manifest.json (the Configurator CLI's list-releases input).
// Manifest fields are the CLI contract; keep additive-only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const version = process.env.RELEASE_VERSION ?? '0.1.0';
execFileSync('docker', ['compose',
  '-f', 'pipeline/compose.build.yml',
  '--project-name', 'netbox-image',
  'up', '--build', '--abort-on-container-exit', 'image-build'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: version } });

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
