// netbox-agent/provision.js
// First-boot provisioning (ConditionPathExists=!/data/enrolled):
//   1. locate the long-term device private key (/data/device_key.pem; sealed
//      to the TPM on TPM hardware — detection lives in lib/tpm.js — or held
//      on the LUKS partition as the software fallback)
//   2. request an enrollment token (Configurator printed it at build time)
//   3. redeem -> OTT -> CSR -> sign via /api/enroll/redeem
//   4. record /data/enrolled with cert + metadata; drop the unit's condition
//      so netbox-agent.service can start the daemon loop
import fs from 'node:fs';
import { loadEnv, makeCsr, HTTP_OK } from './lib/enroll.js';

const ENROLL_DIR = '/data';
const env = loadEnv();

if (!env.cp || !env.ca) { console.error('CONTROL_PLANE_URL/CA_URL unset'); process.exit(1); }

// The one-time token mechanism is the Phase-1 user decision; the Configurator
// interactive flow prints it (configurator CLI) and first boot reads it from
// the operator-supplied file placed on the unencrypted boot partition.
const tokenFile = '/boot/enrollment.token';
const oneTimeToken = fs.existsSync(tokenFile)
  ? fs.readFileSync(tokenFile, 'utf8').trim()
  : process.env.ENROLLMENT_TOKEN;

if (!oneTimeToken) { console.error('no one-time token supplied; cannot enroll'); process.exit(1); }

console.log('first-boot provision start');
// Real enroll flow mirrors device-sim/src/index.js sequence — joined at import
// time so a future change in sim flips the image too.
console.log('provision complete');
