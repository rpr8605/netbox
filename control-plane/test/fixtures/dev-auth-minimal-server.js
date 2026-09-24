// control-plane/test/fixtures/dev-auth-minimal-server.js
// Minimal Fastify server used by dev-auth.security.test.js. It exercises the
// dev-auth preHandler and requirePerm gate without bringing up the full control
// plane (no step-ca, no Postgres).
import Fastify from 'fastify';
import { devAuthPreHandler } from '../../src/auth/dev_auth.js';
import { requirePerm } from '../../src/rbac.js';

const app = Fastify({ logger: false });
app.addHook('preHandler', devAuthPreHandler);

app.get('/api/gated', {
  preHandler: requirePerm('devices:read'),
}, async () => ({ ok: true }));

const address = await app.listen({ port: 0, host: '127.0.0.1' });
console.log(address);
