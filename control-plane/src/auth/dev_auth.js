// control-plane/src/auth/dev_auth.js
// Dev-only authentication stub for the React console and API development.
// NEVER use in production. This is replaced by real Cognito/OIDC auth in C1.
//
// When CONSOLE_DEV_AUTH=1 and NODE_ENV !== 'production', it reads a role from
// the X-Dev-Role header (preferred) or the ?role= query string (legacy compat)
// and sets req.user. The requirePerm gate in rbac.js then reads req.user.role.
//
// The control-plane is still localhost-only in compose (host port bound to
// 127.0.0.1), covered by control-plane/test/compose.security.test.js.

import { can } from '../rbac.js';

const ENABLED = process.env.CONSOLE_DEV_AUTH === '1';
const IS_PROD = process.env.NODE_ENV === 'production';

if (ENABLED && IS_PROD) {
  throw new Error('CONSOLE_DEV_AUTH=1 is not allowed in production');
}

if (ENABLED) {
  console.warn('[dev-auth] Console running in dev-auth mode. Not for production.');
}

export const devAuth = {
  name: 'devAuth',
};

export async function devAuthPreHandler(req, reply) {
  if (!ENABLED) return;

  // Header is preferred; query string is supported only during the Step 1
  // transition and will be removed once all callers pass the header.
  const role = req.headers['x-dev-role'] ?? req.query?.role ?? null;

  if (role && !can(role, 'devices:read')) {
    // can() returns false for unknown roles; deny early so tests catch bad roles.
    return reply.code(403).send({ error: `dev-auth: unknown role '${role}'` });
  }

  req.user = {
    id: 'dev',
    role: role ?? 'operations-manager',
    mfaVerified: false,
  };
}
