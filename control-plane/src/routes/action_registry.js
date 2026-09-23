// control-plane/src/routes/action_registry.js
// Responsibility: the Action Registry (docs/specs/BEACON_RELAY_CONTROLS_AND_IDENTITY.md §2) — a per-site
// whitelist of approved action types. Each execution requires a live,
// human-initiated session issued through the existing remote-support session
// broker. No action type is callable unless it is explicitly registered for
// that site. Every registration and execution is audit-logged.
import crypto from 'node:crypto';
import {
  createActionRegistryEntry, listActionRegistryEntries, getActionRegistryEntry,
  setActionRegistryEnabled, createSupportSession, appendAudit,
} from '../db.js';
import { requirePerm } from '../rbac.js';

const SESSION_TTL_S = Number(process.env.SUPPORT_SESSION_TTL_S ?? 300);

// Role rank for the "requires_role" gate. Higher number = more privilege.
const ROLE_RANK = {
  'readonly-executive': 0,
  'security-auditor': 1,
  'customer-it-admin': 2,
  'support-technician': 3,
  'operations-manager': 4,
};

function roleMeets(requesterRole, requiredRole) {
  return (ROLE_RANK[requesterRole] ?? -1) >= (ROLE_RANK[requiredRole] ?? 0);
}

export default async function actionRegistryRoutes(app) {
  // Register an approved action type for a site. Adding an action type is a
  // deliberate config change, not something a session can improvise.
  app.post('/api/action-registry', {
    preHandler: requirePerm('action_registry:write', appendAudit),
    config: { auth: 'operator:action_registry:write' },
  }, async (req, reply) => {
    const { action_id, site_id, requires_role, max_scope } = req.body ?? {};
    if (!action_id || !site_id || !requires_role) {
      return reply.code(400).send({ error: 'action_id, site_id, requires_role required' });
    }
    if (!Object.hasOwn(ROLE_RANK, requires_role)) {
      return reply.code(400).send({ error: `unknown role ${requires_role}` });
    }
    await createActionRegistryEntry({ action_id, site_id, requires_role, max_scope });
    await appendAudit({
      auditId: crypto.randomUUID(), actor: req.body?.actor ?? req.query?.role ?? 'operations-manager',
      action: 'action_registry.created', target: `${site_id}:${action_id}`,
      detail: `requires_role=${requires_role} session=true`,
    });
    return { action_id, site_id, requires_role, max_scope: max_scope ?? null };
  });

  // List approved actions for a site.
  app.get('/api/action-registry/:siteId', {
    preHandler: requirePerm('action_registry:read', appendAudit),
    config: { auth: 'operator:action_registry:read' },
  }, async (req) => {
    return { site_id: req.params.siteId, actions: await listActionRegistryEntries(req.params.siteId) };
  });

  // Request execution of an approved action. This creates a remote-support
  // session bound to the action_id; the device opens it with its mTLS cert +
  // the single-use JIT token, exactly like a normal support session. If the
  // action type is not registered for the site, or the requester's role is too
  // low, the request is refused before any session is created.
  app.post('/api/action-registry/execute', {
    preHandler: requirePerm('action_registry:execute', appendAudit),
    config: { auth: 'operator:action_registry:execute' },
  }, async (req, reply) => {
    const { action_id, site_id, device_id, requested_by } = req.body ?? {};
    const requesterRole = req.query?.role ?? req.body?.role ?? 'unknown';
    if (!action_id || !site_id || !device_id || !requested_by) {
      return reply.code(400).send({ error: 'action_id, site_id, device_id, requested_by required' });
    }
    const entry = await getActionRegistryEntry(action_id, site_id);
    if (!entry) {
      await appendAudit({
        auditId: crypto.randomUUID(), actor: requesterRole,
        action: 'action_registry.execute_denied', target: `${site_id}:${action_id}`,
        detail: 'action not registered for site',
      });
      return reply.code(403).send({ error: 'action not registered for this site' });
    }
    if (!entry.enabled) {
      await appendAudit({
        auditId: crypto.randomUUID(), actor: requesterRole,
        action: 'action_registry.execute_denied', target: `${site_id}:${action_id}`,
        detail: 'action disabled',
      });
      return reply.code(403).send({ error: 'action is disabled' });
    }
    if (!roleMeets(requesterRole, entry.requires_role)) {
      await appendAudit({
        auditId: crypto.randomUUID(), actor: requesterRole,
        action: 'action_registry.execute_denied', target: `${site_id}:${action_id}`,
        detail: `requires ${entry.requires_role}`,
      });
      return reply.code(403).send({ error: `action requires ${entry.requires_role}` });
    }

    const sessionId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_S * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await createSupportSession({
      session_id: sessionId, device_id, requested_by, token_hash: tokenHash, expires_at: expiresAt,
      action_id,
    });
    await appendAudit({
      auditId: crypto.randomUUID(), actor: requested_by,
      action: 'action_registry.executed', target: `${site_id}:${action_id}`,
      detail: `device=${device_id} session=${sessionId}`,
    });
    return { session_id: sessionId, token, action_id, device_id, expires_at: expiresAt };
  });
}
