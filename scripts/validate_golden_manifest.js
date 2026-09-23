#!/usr/bin/env node
// scripts/validate_golden_manifest.js
// Responsibility: software-side validation that a built image manifest matches the
// golden-image requirements in hardware/golden_manifest.json. This is the no-hardware
// portion of the hardware-lifecycle tooling (BUILD_SPEC §8.9). It checks artifact
// presence, checksum coverage, and the bundle manifest — it does NOT power on a device.
//
// Usage:
//   node scripts/validate_golden_manifest.js [path/to/built/manifest.json]
// Defaults to out/manifest.json.
import fs from 'node:fs';
import path from 'node:path';

const golden = JSON.parse(fs.readFileSync('hardware/golden_manifest.json', 'utf8'));
const manifestPath = process.argv[2] ?? 'out/manifest.json';

function fail(msg) {
  console.error('VALIDATION FAILED:', msg);
  process.exit(1);
}

function ok(msg) {
  console.log('OK:', msg);
}

if (!fs.existsSync(manifestPath)) {
  fail(`built manifest not found: ${manifestPath} (run pipeline/build.js first)`);
}

const built = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const baseDir = path.dirname(manifestPath);

if (!built.version) fail('built manifest missing version');
ok(`manifest version ${built.version}`);

const required = new Set(golden.validation.required_artifacts);
for (const rel of golden.validation.required_artifacts) {
  const full = path.join(baseDir, rel);
  if (!fs.existsSync(full)) fail(`missing required artifact: ${rel}`);
  ok(`required artifact present: ${rel}`);
}

if (!Array.isArray(built.artifacts) || built.artifacts.length === 0) {
  fail('built manifest has no artifacts array');
}

const checksumArtifacts = new Set(built.artifacts.map(a => path.basename(a.path)));
for (const req of required) {
  if (!checksumArtifacts.has(req)) fail(`SHA256SUMS does not cover ${req}`);
}
ok('all required artifacts covered by SHA256SUMS');

// Optional deeper bundle manifest check when the bundle exists.
const bundleRel = built.artifacts.find(a => a.path.endsWith('.raucb'));
if (bundleRel) {
  const bundlePath = path.join(baseDir, path.basename(bundleRel.path));
  if (!fs.existsSync(bundlePath)) {
    console.log('SKIP: bundle present in manifest but not on disk (acceptable for manifest-only validation)');
  } else {
    ok(`bundle artifact on disk: ${path.basename(bundlePath)}`);
  }
}

// Validate BOM JSON shape (no hardware required).
const bom = JSON.parse(fs.readFileSync('hardware/bom.json', 'utf8'));
if (!Array.isArray(bom.components) || bom.components.length === 0) {
  fail('hardware/bom.json has no components');
}
for (const c of bom.components) {
  if (!c.role || !c.primary?.mpn || !Array.isArray(c.required_features)) {
    fail(`BOM component ${c.role ?? '?'} missing required fields`);
  }
}
ok(`BOM valid: ${bom.components.length} component role(s)`);

console.log('\nGolden manifest validation passed (software-side only).');
console.log('Physical boot/TPM/LUKS tests require real hardware or QEMU+KVM.');
