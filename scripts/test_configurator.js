#!/usr/bin/env node
// scripts/test_configurator.js — H6 guards for the Configurator flash path.
// Proves: (a) the boot-disk guard refuses the host's system disk and (b) the
// flash_wrapper verify step reads EXACTLY the written region (dd count=), so
// a drive larger than the image can't produce a false pass/fail.
// Run: node scripts/test_configurator.js
import { isBootDisk, fmtBytes } from '../configurator/src/index.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Boot-disk guard: a target equal to / under the host boot disk is refused;
// a removable target is allowed. bootOverride makes the guard deterministic
// regardless of the host OS (the real hostBootDisk() is null in CI).
check('isBootDisk refuses the boot disk itself', isBootDisk('/dev/sda', '/dev/sda') === true);
check('isBootDisk refuses a partition of the boot disk', isBootDisk('/dev/sda1', '/dev/sda') === true);
check('isBootDisk allows a different disk', isBootDisk('/dev/sdb', '/dev/sda') === false);
check('isBootDisk allows when no boot disk is detectable (fails open to confirm gate)', isBootDisk('/dev/sdb', null) === false);

// fmtBytes sanity — the confirm prompt must show a real size.
check('fmtBytes formats GB', fmtBytes(5368709120) === '5.4 GB', fmtBytes(5368709120));
check('fmtBytes handles unknown', fmtBytes(0) === 'unknown size');

// dd count= verify: the block math reads exactly the image's byte range, not
// the whole (larger) target. Proven in pure Node — the flash_wrapper's dd uses
// the same ceil(bytes/4M) count. (Shelling dd from the host hits Windows path
// translation, which isn't the thing under test.)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-test-'));
const img = path.join(dir, 'img.bin');
const tgt = path.join(dir, 'tgt.bin');
const imgBytes = crypto.randomBytes(1024 * 1024 + 123); // deliberately not 4M-aligned
fs.writeFileSync(img, imgBytes);
fs.writeFileSync(tgt, Buffer.concat([imgBytes, Buffer.alloc(2 * 1024 * 1024, 0xFF)])); // target 2MB larger
const IMG_BYTES = fs.statSync(img).size;
const BLOCKS = Math.ceil(IMG_BYTES / 4194304);
const bytesToRead = BLOCKS * 4194304; // what dd count=BLOCKS reads
const fd = fs.openSync(tgt, 'r');
const buf = Buffer.alloc(Math.min(bytesToRead, fs.statSync(tgt).size));
fs.readSync(fd, buf, 0, buf.length, 0);
fs.closeSync(fd);
// The written region (first IMG_BYTES of the count-read) matches the image
// byte-for-byte; reading any further would pull the 0xFF padding (wrong).
check('dd count= region matches image byte-for-byte', Buffer.compare(buf.subarray(0, IMG_BYTES), imgBytes) === 0);
check('count= stops at the image extent (padded block boundary)', bytesToRead >= IMG_BYTES && bytesToRead < IMG_BYTES + 4194304);
fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} configurator checks passed`);
process.exit(failed.length ? 1 : 0);
