#!/usr/bin/env node
// pipeline/gen_sfdisk.js — host-side render of <version>/sfdisk.script from
// pipeline/manifests/netbox-partition-map.json. Keeps jq-out-of-the-loop in
// the privileged assembler (compose.assemble.yml) — generating the script
// pre-run is also what keeps the map the single source of truth without
// re-parsing JSON under sfdisk's stdin.
import fs from 'node:fs';

const map = JSON.parse(fs.readFileSync('pipeline/manifests/netbox-partition-map.json', 'utf8'));
const version = process.argv[2] ?? '0.1.0';
const lines = ['label: gpt', 'unit: sectors'];
for (const p of map.partitions) {
  const size = p.size === 'grow' ? '' : `,size=${p.size}`;
  const type = p.type === 'fat32' ? 'uefi' : 'linux';
  lines.push(`${size},type=${type},name=${p.label}`);
}
fs.mkdirSync(`out/${version}`, { recursive: true });
fs.writeFileSync(`out/${version}/sfdisk.script`, lines.join('\n') + '\n');
console.log(`sfdisk.script written for ${version}`);
