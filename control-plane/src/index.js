// control-plane/src/index.js
// Responsibility: control-plane entrypoint (spec §1, right side of the line).
//   - obtains the step-ca root (retry loop; CA may still be initialising)
//   - enrols ITSELF as a step-ca client to get its TLS server cert — the
//     control plane is just another short-lived-cert client of the CA, same
//     as devices; no long-lived server keys on disk
//   - serves: enrollment routes (token auth), device registry + console
//     (Phase 1: localhost-only), and mTLS-gated device endpoints
//
// TLS posture: requestCert + rejectUnauthorized:false at the socket layer, with
// per-route enforcement (routes/events.js requires req.socket.authorized).
// This lets one port serve pre-cert enrollment AND post-cert mTLS ingestion.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';
import { fetch as undiciFetch } from 'undici';
import { caBootstrap, mintStepCaToken, bootstrapAgent } from './ca.js';
import enrollRoutes from './routes/enroll.js';
import deviceRoutes from './routes/devices.js';
import eventRoutes from './routes/events.js';
import retrustRoutes from './routes/retrust.js';
import channelRoutes from './routes/channels.js';
import alertRoutes from './routes/alerts.js';
import supportRoutes, { sweepSupportSessions } from './routes/support.js';
import topologyViewRoutes from './routes/topology_view.js';
import { sweepEscalations } from './alerting.js';
import { deliver } from './deliver.js';
import { appendAudit, listAudit } from './db.js';
import { requirePerm } from './rbac.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 9100);
const CA_URL = process.env.CA_URL ?? 'https://localhost:9000';

async function waitForCa(attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try { return await caBootstrap(); }
    catch { await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('step-ca unreachable after retries');
}

// CSR + sign round-trip against step-ca. Used for the control plane's own
// server identity; the device simulator uses the same shape of call.
async function issueServerCert(commonName) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const csrPem = forge.pki.certificationRequestToPem(csr);

  const ott = await mintStepCaToken(commonName);
  const res = await undiciFetch(`${CA_URL}/1.0/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ csr: csrPem, ott }),
    dispatcher: bootstrapAgent,
  });
  if (!res.ok) throw new Error(`step-ca sign failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return {
    certPem: body.crt ?? body.cert ?? body.certificate,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

const root = await waitForCa();
const serverIdentity = await issueServerCert('control-plane');

const app = Fastify({
  logger: { level: 'info' },
  https: {
    key: serverIdentity.keyPem,
    cert: serverIdentity.certPem,
    ca: [root.pem],
    requestCert: true,
    rejectUnauthorized: false, // per-route enforcement; see header comment
  },
  trustProxy: false,
});

await app.register(fastifyStatic, { root: path.join(__dirname, '..', 'public') });
await app.register(enrollRoutes);
await app.register(deviceRoutes);
await app.register(eventRoutes);
await app.register(retrustRoutes);
await app.register(channelRoutes);
await app.register(alertRoutes);
await app.register(supportRoutes);
await app.register(topologyViewRoutes);

// Audit log read — security-auditor and operations-manager only. Read-only by
// design: there is no route that mutates audit_log, and the db triggers make
// UPDATE/DELETE raise.
app.get('/api/audit', { preHandler: requirePerm('audit:read', appendAudit) }, async (req) => {
  return listAudit(Number(req.query?.limit ?? 100));
});

app.get('/api/health', async () => ({ ok: true, ca_fingerprint: root.fingerprint }));

// Escalation sweep: any open alert past its ack window escalates to the next
// tier. Support-session sweep: any session past its expires_at is closed.
// Both run on a short timer so a missed ack / expired tunnel is enforced by
// the system, not by someone watching a dashboard.
const SWEEP_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 5000);
setInterval(() => {
  sweepEscalations({ deliver: (c, a) => deliver(c, a, app.config ?? {}) }).catch(() => {});
  sweepSupportSessions();
}, SWEEP_MS);

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(`control plane listening on :${PORT}; CA fingerprint ${root.fingerprint}`);
