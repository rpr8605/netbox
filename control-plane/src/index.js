// control-plane/src/index.js
// Responsibility: control-plane entrypoint (docs/specs/BEACON_RELAY_BUILD_SPEC.md §1, right side of the line).
//   - obtains the step-ca root (retry loop; CA may still be initialising)
//   - enrols ITSELF as a step-ca client to get its TLS server cert — the
//     control plane is just another short-lived-cert client of the CA, same
//     as devices; no long-lived server keys on disk
//   - serves: enrollment routes (token auth), device registry + console
//     (localhost-only until real operator auth lands), and mTLS-gated device endpoints
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
import releaseRoutes from './routes/releases.js';
import actionRegistryRoutes from './routes/action_registry.js';
import { sweepEscalations } from './alerting.js';
import { deliver } from './deliver.js';
import { appendAudit, listAudit } from './db.js';
import { requirePerm, can } from './rbac.js';
import { devAuthPreHandler } from './auth/dev_auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 9100);
const BIND_HOST = process.env.BIND_HOST ?? '127.0.0.1';
const CA_URL = process.env.CA_URL ?? 'https://localhost:9000';
const DEMO_MODE = process.env.DEMO_MODE === '1';

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

// Dev auth stub runs first on every request so req.user is available to
// requirePerm. In production or without CONSOLE_DEV_AUTH=1 it is a no-op and
// RBAC-gated routes deny until C1 auth is wired.
app.addHook('preHandler', devAuthPreHandler);

// Console pages should not be reachable without at least a declared role. The
// legacy Fleet Map page is protected here; the data endpoint enforces the same
// RBAC as the rollup gate. After the React console reaches parity this route
// is retired. We check the explicit role source (header or query) so anonymous
// requests are denied even though the dev-auth stub defaults other routes to
// operations-manager for local development.
app.get('/fleet.html', {
  preHandler: async (req, reply) => {
    // Role comes from the auth preHandler (dev-auth stub or future Cognito).
    // Do not read X-Dev-Role or ?role= directly here; that bypasses the
    // CONSOLE_DEV_AUTH=1 + NODE_ENV !== production guard.
    const role = req.user?.role ?? null;
    if (!can(role, 'topology:rollup')) {
      await appendAudit({ auditId: crypto.randomUUID(), actor: role ?? 'anonymous', action: 'rbac.denied', target: 'topology:rollup', detail: req.url });
      return reply.code(403).send({ error: `role '${role ?? 'none'}' lacks topology:rollup` });
    }
  },
  config: { auth: 'operator:topology:rollup' },
}, async (req, reply) => {
  return reply.sendFile('fleet.html');
});

await app.register(fastifyStatic, { root: path.join(__dirname, '..', 'public') });

// React console static files + SPA fallback. Served under an encapsulated
// prefix so an onRoute hook can tag every console route with the same auth
// policy. The dev-auth/Cognito preHandler runs before this and sets req.user.
await app.register(async function consoleStatic(consoleApp) {
  consoleApp.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.config) routeOptions.config = {};
    if (!routeOptions.config.auth) {
      routeOptions.config.auth = 'operator:devices:read';
    }
  });
  await consoleApp.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'console', 'dist'),
    prefix: '/',
    wildcard: false,
  });
  // SPA fallback: any non-asset /console/* path returns index.html.
  consoleApp.get('/*', async (req, reply) => {
    return reply.sendFile('index.html', path.join(__dirname, '..', 'console', 'dist'));
  });
}, { prefix: '/console' });

await app.register(enrollRoutes);
await app.register(deviceRoutes);
await app.register(eventRoutes);
await app.register(retrustRoutes);
await app.register(channelRoutes);
await app.register(alertRoutes);
await app.register(supportRoutes);
await app.register(topologyViewRoutes);
await app.register(releaseRoutes);
await app.register(actionRegistryRoutes);

// Audit log read — security-auditor and operations-manager only. Read-only by
// design: there is no route that mutates audit_log, and the db triggers make
// UPDATE/DELETE raise.
app.get('/api/audit', {
  preHandler: requirePerm('audit:read', appendAudit),
  config: { auth: 'operator:audit:read' },
}, async (req) => {
  return await listAudit(Number(req.query?.limit ?? 100));
});

app.get('/api/health', { config: { auth: 'public' } }, async () => ({ ok: true, ca_fingerprint: root.fingerprint }));

// Demo mode flag so the static console can show a prominent DEMO banner and
// avoid any ambiguity that the data on screen is synthetic. The banner is
// rendered client-side so this endpoint is the single source of truth.
app.get('/api/demo', { config: { auth: 'public' } }, async () => ({ demo: DEMO_MODE }));

// Escalation sweep: any open alert past its ack window escalates to the next
// tier. Support-session sweep: any session past its expires_at is closed.
// Both run on a short timer so a missed ack / expired tunnel is enforced by
// the system, not by someone watching a dashboard.
const SWEEP_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 5000);
setInterval(() => {
  sweepEscalations({ deliver: (c, a) => deliver(c, a, app.config ?? {}) }).catch(() => {});
  sweepSupportSessions().catch(() => {});
}, SWEEP_MS);

await app.listen({ port: PORT, host: BIND_HOST });
app.log.info(`control plane listening on ${BIND_HOST}:${PORT}; CA fingerprint ${root.fingerprint}`);
