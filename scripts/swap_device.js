#!/usr/bin/env node
// scripts/swap_device.js
// Responsibility: operator CLI for the field device-swap workflow
// (hardware/swap_procedure.md). It calls the control-plane API to retire the old
// device, assign the replacement to the same site in quarantine, and audit the
// action. No physical hardware is touched by this script.
//
// Usage:
//   node scripts/swap_device.js \
//     --old-device-id <uuid> \
//     --new-device-id <uuid> \
//     [--reason <text>] \
//     [--role operations-manager] \
//     [--control-plane-url https://127.0.0.1:10443]
import { httpJson } from '../beacon-relay-agent/lib/http_json.js';

function getArg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const oldDeviceId = getArg('--old-device-id');
const newDeviceId = getArg('--new-device-id');
const reason = getArg('--reason', '');
const role = getArg('--role', 'operations-manager');
const base = getArg('--control-plane-url', process.env.CONTROL_PLANE_URL || 'https://127.0.0.1:10443');

if (!oldDeviceId || !newDeviceId) {
  console.error('Usage: node scripts/swap_device.js --old-device-id <uuid> --new-device-id <uuid> [--reason <text>] [--role <role>]');
  process.exit(1);
}

const url = `${base.replace(/\/$/, '')}/api/devices/${oldDeviceId}/replace`;
const res = await httpJson('POST', url, {
  body: { new_device_id: newDeviceId, reason, role },
  timeoutMs: 10000,
});

if (res.status >= 400 || !res.json) {
  console.error('Swap failed:', res.status, res.text ?? res.json ?? 'no response');
  process.exit(1);
}

console.log('Swap recorded:', JSON.stringify(res.json, null, 2));
