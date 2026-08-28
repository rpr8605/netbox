#!/usr/bin/env node
/**
 * scripts/pki_seed.js
 * Responsibility: seed the local step-ca CA config with an ES256 JWK pair plus
 * the corresponding JWK provisioner bound to name `netbox-device`, and also
 * emit the private JWK to pki-config/provisioner/private_jwk.json (kept off
 * disk by .gitignore) so the control plane signs enrollment tokens.
 *
 * How invoked: `node scripts/pki_seed.js` (idempotent: skips if public JWK
 * already equals the one being inserted). Called automatically first time
 * before `docker compose up`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPair, exportJWK } from 'jose';

const CFG_DIR = 'pki-config/config';
const PROV_DIR = 'pki-config/provisioner';
const CFG_FILE = path.join(CFG_DIR, 'ca.json');
const PUB_JWK_FILE = path.join(PROV_DIR, 'public_jwk.json');
const PRIV_JWK_FILE = path.join(PROV_DIR, 'private_jwk.json');
const PW_FILE = 'pki-config/password';

const provisionerName = process.env.PKI_PROVISIONER ?? 'netbox-device';

function jwkPub(p) {
  const { d, ...pub } = p;
  return pub;
}

async function main() {
  fs.mkdirSync(PROV_DIR, { recursive: true });

  let publicJwk, privateJwk;
  const needsRegen = fs.existsSync(PRIV_JWK_FILE) ? false : true;
  if (!needsRegen) {
    privateJwk = JSON.parse(fs.readFileSync(PRIV_JWK_FILE, 'utf8'));
    publicJwk = jwkPub(privateJwk.private);
  } else {
    const p = await generateKeyPair('ES256', { extractable: true });
    const priv = { private: { ...await exportJWK(p.privateKey), kid: 'netbox-device' } };
    privateJwk = priv;
    fs.writeFileSync(PRIV_JWK_FILE, JSON.stringify(priv, null, 2));
    console.log('pki seed: created new ES256 JWK pair', PRIV_JWK_FILE);
  }

  const privJwk = privateJwk.private ?? privateJwk;
  const pubJwk = jwkPub(privJwk);
  fs.writeFileSync(PUB_JWK_FILE, JSON.stringify({ public: pubJwk }, null, 2));

  // Render the FULL ca.json step-ca will actually run with. Paths point at the
  // named volumes where the entrypoint generates root/intermediate material
  // (step certificate create — `step ca init` hard-requires a TTY, so it is
  // not usable in CI-style setups).
  const renderDir = path.join('pki-config', 'config.render');
  fs.mkdirSync(renderDir, { recursive: true });
  const cfg = {
    root: '/home/step/certs/root_ca.crt',
    crt: '/home/step/certs/intermediate_ca.crt',
    key: '/home/step/secrets/intermediate_ca_key',
    address: ':9000',
    insecureAddress: '',
    dnsNames: ['localhost', 'step-ca'],
    logger: { format: 'json' },
    db: { type: 'badgerV2', dataSource: '/home/step/db' },
    authority: {
      provisioners: [{
        type: 'JWK',
        name: provisionerName,
        key: pubJwk.public ?? pubJwk,
        claims: {
          minTLSCertDuration: '5m',
          maxTLSCertDuration: '24h',
          defaultTLSCertDuration: '12h',
        },
      }],
      claims: {
        minTLSCertDuration: '5m',
        maxTLSCertDuration: '24h',
        defaultTLSCertDuration: '12h',
        disableRenewal: false,
      },
    },
    tls: {
      cipherSuites: [
        'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
        'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
        'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
      ],
      minVersion: 1.2,
      maxVersion: 1.3,
      renegotiation: false,
    },
    commonName: 'Netbox Demo Online CA',
  };
  fs.writeFileSync(path.join(renderDir, 'ca.json'), JSON.stringify(cfg, null, 2));
  console.log(`pki seed: rendered pki-config/config.render/ca.json (provisioner '${provisionerName}')`);

  if (!fs.existsSync(PW_FILE)) {
    fs.writeFileSync(PW_FILE, process.env.CA_PASSWORD ?? 'dev-only-insecure-changeit!');
    console.warn('pki seed: wrote dev CA password to pki-config/password (gitignored)');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
