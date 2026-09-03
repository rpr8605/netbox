// control-plane/src/rbac.js
// Responsibility: the complete RBAC role map (spec §5) as ONE source of truth,
// plus the gate the routes share. Five roles, each with an explicit boundary:
//   support-technician  — per-site ops + support sessions; can ack alerts
//   customer-it-admin   — site-scoped config + reads; no cross-site rollup
//   operations-manager  — fleet-wide view incl. cross-site rollup + alerting
//   security-auditor    — read-only, PLUS the audit log (the auditor's lane)
//   readonly-executive  — read-only dashboards only; no audit log, no actions
// Phase 2 has no auth yet, so `role` arrives as a request attribute and is
// validated against this map. The gate is structural (route -> role), so a
// real Phase-8 auth layer only has to supply the principal's role.
import crypto from 'node:crypto';

// The complete role -> permission map. This is the single source of truth the
// route gates read; adding a permission means editing THIS map, not a route.
export const ROLE_PERMISSIONS = {
  'support-technician': new Set([
    'devices:read', 'events:read', 'topology:read', 'topology:rollup',
    'alerts:read', 'alerts:ack', 'support:request', 'support:open',
  ]),
  'customer-it-admin': new Set([
    'devices:read', 'events:read', 'topology:read',
    'alerts:read', 'downtime:manage',
  ]),
  'operations-manager': new Set([
    'devices:read', 'events:read', 'topology:read', 'topology:rollup',
    'alerts:read', 'alerts:fire', 'alerts:ack', 'alerts:rules:write',
  ]),
  'security-auditor': new Set([
    'devices:read', 'events:read', 'topology:read', 'audit:read',
  ]),
  'readonly-executive': new Set([
    'devices:read', 'topology:read', 'alerts:read',
  ]),
};

// can — is `role` allowed `perm`? Deny-by-default: an unknown role or an
// unknown permission is a no. This is the single check every gated route calls.
export function can(role, perm) {
  return ROLE_PERMISSIONS[role]?.has(perm) === true;
}

// requirePerm — a Fastify preHandler. Reads role from req (query.role here in
// Phase 2; a bearer principal in Phase 8) and 403s on deny. Audits every DENY
// so attempted privilege use is itself a logged event.
export function requirePerm(perm, appendAuditFn) {
  return async (req, reply) => {
    const role = req.query?.role ?? req.body?.role ?? null;
    if (!can(role, perm)) {
      if (appendAuditFn) {
        appendAuditFn({
          auditId: crypto.randomUUID(), actor: role ?? 'anonymous',
          action: 'rbac.denied', target: perm, detail: req.url,
        });
      }
      return reply.code(403).send({ error: `role '${role ?? 'none'}' lacks ${perm}` });
    }
  };
}
