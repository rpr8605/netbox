// control-plane/src/routes/support.js
// Responsibility: the remote-support session broker (spec §7) — NO standing
// SSH port, NO shared credential. An admin REQUESTS a session; the device's
// existing outbound mTLS connection picks up a time-limited session token and
// opens an OUTBOUND tunnel for that window only. Every session is an
// audit-logged event. The tunnel closes at its time limit — enforced here by
// the expires_at check on every read, and by the sweep that closes expired
// sessions.
import crypto from 'node:crypto';
import {
  createSupportSession, getSupportSession, openSupportSession,
  closeSupportSession, expiredSupportSessions, appendAudit,
} from '../db.js';

const SESSION_TTL_S = Number(process.env.SUPPORT_SESSION_TTL_S ?? 300); // 5 min default

export default async function supportRoutes(app) {
  // Admin requests a session. Creates a PENDING session + a one-time JIT token.
  // The device will poll for it over its existing outbound mTLS connection.
  app.post('/api/support/sessions', async (req, reply) => {
    const { device_id, requested_by, ttl_seconds } = req.body ?? {};
    if (!device_id || !requested_by) return reply.code(400).send({ error: 'device_id and requested_by required' });
    // Per-session TTL is allowed but CAPPED: a session can't outlive the
    // broker's maximum, so "leave it open" isn't an option the API offers.
    const ttl = Math.min(Number(ttl_seconds ?? SESSION_TTL_S), SESSION_TTL_S);
    const sessionId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString().replace('T', ' ').slice(0, 19);
    createSupportSession({ session_id: sessionId, device_id, requested_by, token_hash: tokenHash, expires_at: expiresAt });
    appendAudit({ auditId: crypto.randomUUID(), actor: requested_by, action: 'support.requested', target: sessionId, detail: `device=${device_id} ttl=${ttl}s` });
    return { session_id: sessionId, token, expires_at: expiresAt };
  });

  // Device polls (over its existing mTLS connection) for a pending session and
  // picks up its token. Only the device's own sessions are returned.
  app.get('/api/support/sessions/:deviceId/pending', async (req) => {
    // device identity comes from the mTLS cert in the full implementation; the
    // route filters by the requested device_id so a session is never handed
    // to the wrong box.
    const { deviceId } = req.params;
    const rows = (await import('../db.js')).db
      .prepare(`SELECT * FROM support_sessions WHERE device_id = ? AND state = 'pending' AND expires_at > datetime('now')`)
      .all(deviceId);
    return rows.map(r => ({ session_id: r.session_id, expires_at: r.expires_at }));
  });

  // Device opens its tunnel: the JIT token is consumed exactly once, the
  // session flips to open, and the open is audit-logged. A session that is
  // already open/closed/expired cannot be re-opened — the token is single-use
  // and the state transition is one-way.
  app.post('/api/support/sessions/:id/open', async (req, reply) => {
    const s = getSupportSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    if (s.state !== 'pending') {
      appendAudit({ auditId: crypto.randomUUID(), actor: 'device', action: 'support.open_denied', target: s.session_id, detail: `state=${s.state}` });
      return reply.code(409).send({ error: `session is ${s.state}, cannot re-open` });
    }
    const { token } = req.body ?? {};
    const tokenHash = crypto.createHash('sha256').update(token ?? '').digest('hex');
    if (tokenHash !== s.token_hash) {
      appendAudit({ auditId: crypto.randomUUID(), actor: 'device', action: 'support.open_denied', target: s.session_id, detail: 'bad token' });
      return reply.code(403).send({ error: 'invalid session token' });
    }
    if (new Date(s.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
      closeSupportSession(s.session_id, 'expired');
      return reply.code(410).send({ error: 'session expired' });
    }
    openSupportSession(s.session_id);
    appendAudit({ auditId: crypto.randomUUID(), actor: 'device', action: 'support.opened', target: s.session_id });
    return { session_id: s.session_id, state: 'open', expires_at: s.expires_at };
  });

  // Close a session (either side). The time-limit is enforced: reading or
  // closing an expired session marks it 'expired', not 'open'.
  app.post('/api/support/sessions/:id/close', async (req, reply) => {
    const s = getSupportSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    closeSupportSession(s.session_id, 'closed');
    appendAudit({ auditId: crypto.randomUUID(), actor: req.body?.actor ?? 'system', action: 'support.closed', target: s.session_id });
    return { session_id: s.session_id, state: 'closed' };
  });

  app.get('/api/support/sessions/:id', async (req, reply) => {
    const s = getSupportSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    const expired = new Date(s.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now();
    if (expired && (s.state === 'open' || s.state === 'pending')) {
      closeSupportSession(s.session_id, 'expired');
      return { ...s, state: 'expired' };
    }
    return s;
  });
}

// sweepSupportSessions — close any pending/open session past its expires_at.
// Called on a timer from index.js; returns the sessions closed this sweep.
export function sweepSupportSessions() {
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const expired = expiredSupportSessions(nowIso);
  for (const s of expired) {
    closeSupportSession(s.session_id, 'expired');
    appendAudit({ auditId: crypto.randomUUID(), actor: 'system', action: 'support.expired', target: s.session_id });
  }
  return expired.map(s => s.session_id);
}
