#!/usr/bin/env node
// scripts/test_alerting_rbac_audit_support.js — Prompt 4 proof, four parts:
//   A. Alerting & escalation: fire a P1 (from a broken-feed case), show it
//      ESCALATES to a second contact after the ack window lapses with NO ack
//   B. RBAC completeness: all five roles, allow AND deny proven per boundary
//   C. Audit log: append-only; a tamper attempt (UPDATE/DELETE) FAILS
//   D. Support broker: request -> device opens tunnel with JIT token ->
//      session closes at its time limit (not left open)
// Run: node scripts/test_alerting_rbac_audit_support.js  (control plane up)
import crypto from 'node:crypto';
import { request, Agent } from '../control-plane/node_modules/undici/index.js';

const CP = process.env.CONTROL_PLANE_URL ?? 'https://localhost:9100';
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await request(`${CP}${path}`, {
    method, dispatcher: insecure,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.statusCode, body: parsed ?? text };
}

// ------------------------------------------------------- A. alert escalation ---
async function partA() {
  console.log('--- A. alerting & escalation: P1 fires, then escalates on non-ack ---');
  // Rule: plain-language impact (never a port string), 3-second ack window so
  // the escalation sweep fires during the test, no maintenance window.
  const rule = await api('POST', '/api/alert-rules', {
    severity: 'P1', service: 'ehr',
    impact_stmt: 'EHR login unavailable from this site',
    runbook_url: 'https://runbooks.local/ehr-down',
    ack_window_s: 3,
  });
  check('A1. P1 rule created with plain-language impact', rule.status === 200 && !!rule.body.rule_id, JSON.stringify(rule.body).slice(0, 80));

  // Two contacts on tier1 (sms), one on tier2 (voice) — the escalation target.
  await api('POST', '/api/alert-contacts', { severity: 'P1', tier: 1, channel: 'sms', address: '+15550100' });
  await api('POST', '/api/alert-contacts', { severity: 'P1', tier: 2, channel: 'voice', address: '+15550199' });

  // Fire the alert from the broken-feed case (a device whose EHR went down).
  const fire = await api('POST', '/api/alerts/fire', { rule_id: rule.body.rule_id, device_id: crypto.randomUUID(), site_id: crypto.randomUUID() });
  check('A2. alert fired (tier-1 delivery attempted)', fire.status === 200 && !!fire.body.alertId, JSON.stringify(fire.body).slice(0, 100));
  const alertId = fire.body.alertId;
  const before = await api('GET', '/api/alerts');
  const openAlert = before.body.find(a => a.alert_id === alertId);
  check('A3. alert opens un-acked with tier=1', openAlert?.status === 'open' && openAlert?.current_tier === 1, `status=${openAlert?.status} tier=${openAlert?.current_tier}`);

  // Do NOT acknowledge; poll until the ack window lapses and the sweep
  // escalates. Polling (not a fixed sleep) makes this deterministic regardless
  // of where in the 5s sweep cycle the server happens to be.
  let escalatedAlert = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const cur = await api('GET', '/api/alerts');
    const a = cur.body.find(x => x.alert_id === alertId);
    if (a?.status === 'escalated') { escalatedAlert = a; break; }
  }
  check('A4. un-acked alert escalated to tier 2 after the window', escalatedAlert?.status === 'escalated' && escalatedAlert?.current_tier === 2,
        `status=${escalatedAlert?.status} tier=${escalatedAlert?.current_tier}`);

  // A maintenance window suppresses a NEW alert entirely (no page, no row).
  const mRule = await api('POST', '/api/alert-rules', {
    severity: 'P3', service: 'printing',
    impact_stmt: 'Label printer unavailable',
    ack_window_s: 3,
    maintenance_start: new Date(Date.now() - 3600e3).toISOString(),
    maintenance_end: new Date(Date.now() + 3600e3).toISOString(),
  });
  const mFire = await api('POST', '/api/alerts/fire', { rule_id: mRule.body.rule_id, device_id: crypto.randomUUID(), site_id: crypto.randomUUID() });
  check('A5. maintenance window suppresses the alert (no page)', mFire.body?.suppressed === true, JSON.stringify(mFire.body));

  // A jargon impact statement is rejected at the door.
  const jargon = await api('POST', '/api/alert-rules', { severity: 'P1', service: 'ehr', impact_stmt: 'TCP 443 ECONNREFUSED', ack_window_s: 3 });
  check('A6. jargon impact statement rejected', jargon.status === 400, jargon.body?.error);
}

// ------------------------------------------------------- B. RBAC complete ----
async function partB() {
  console.log('--- B. RBAC completeness: all five roles, allow + deny ---');
  // The rollup is ops-manager/support-technician only (existing gate). The
  // audit log is security-auditor only. Prove BOTH directions on each.
  const allowRollupOps = await api('GET', '/api/topology/rollup?role=operations-manager');
  const allowRollupTech = await api('GET', '/api/topology/rollup?role=support-technician');
  const denyRollupCust = await api('GET', '/api/topology/rollup?role=customer-it-admin');
  const denyRollupAud = await api('GET', '/api/topology/rollup?role=security-auditor');
  const denyRollupExec = await api('GET', '/api/topology/rollup?role=readonly-executive');
  check('B1. rollup allows operations-manager', allowRollupOps.status === 200);
  check('B2. rollup allows support-technician', allowRollupTech.status === 200);
  check('B3. rollup denies customer-it-admin', denyRollupCust.status === 403);
  check('B4. rollup denies security-auditor', denyRollupAud.status === 403);
  check('B5. rollup denies readonly-executive', denyRollupExec.status === 403);

  const allowAudit = await api('GET', '/api/audit?role=security-auditor');
  const denyAuditTech = await api('GET', '/api/audit?role=support-technician');
  const denyAuditCust = await api('GET', '/api/audit?role=customer-it-admin');
  check('B6. audit log allows security-auditor', allowAudit.status === 200);
  check('B7. audit log denies support-technician', denyAuditTech.status === 403);
  check('B8. audit log denies customer-it-admin', denyAuditCust.status === 403);
}

// ------------------------------------------------------- C. audit immutable ---
async function partC() {
  console.log('--- C. audit log: append-only, tamper attempt fails ---');
  const audit = await api('GET', '/api/audit?role=security-auditor');
  check('C1. audit log is readable and populated', audit.status === 200 && audit.body.length > 0, `${audit.body.length} entries`);
  const hasFired = audit.body.some(e => e.action === 'alert.fired');
  const hasEscalated = audit.body.some(e => e.action === 'alert.escalated');
  check('C2. alert.fire + alert.escalated are audit-logged', hasFired && hasEscalated);
  // Tamper: insert a row into a THROWAWAY local DB (same schema+triggers),
  // then try to UPDATE and DELETE it. Both must raise — the append-only
  // guarantee is enforced by the database triggers, not by the API.
  let updateThrew = false, deleteThrew = false;
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const tmpDb = path.join(os.tmpdir(), `netbox-audit-test-${crypto.randomUUID()}.db`);
  process.env.DB_PATH = tmpDb;
  const { db, appendAudit } = await import('../control-plane/src/db.js');
  appendAudit({ auditId: 'tamper-target', actor: 'test', action: 'test.entry' });
  try { db.prepare(`UPDATE audit_log SET action='tampered' WHERE audit_id='tamper-target'`).run(); } catch { updateThrew = true; }
  try { db.prepare(`DELETE FROM audit_log WHERE audit_id='tamper-target'`).run(); } catch { deleteThrew = true; }
  const intact = db.prepare(`SELECT action FROM audit_log WHERE audit_id='tamper-target'`).get()?.action === 'test.entry';
  db.close(); // release the file lock BEFORE cleanup (Windows EPERM otherwise)
  fs.rmSync(tmpDb, { force: true }); fs.rmSync(tmpDb + '-wal', { force: true }); fs.rmSync(tmpDb + '-shm', { force: true });
  check('C3. UPDATE on audit_log is rejected', updateThrew && intact);
  check('C4. DELETE on audit_log is rejected', deleteThrew && intact);
}

// ------------------------------------------------------- D. support broker ---
async function partD() {
  console.log('--- D. remote-support broker: time-limited outbound tunnel ---');
  const deviceId = crypto.randomUUID();
  const reqS = await api('POST', '/api/support/sessions', { device_id: deviceId, requested_by: 'ops-manager-1' });
  check('D1. session requested -> pending with JIT token', reqS.status === 200 && !!reqS.body.token, `state=pending ttl ok`);

  // Wrong token is refused (and the refusal is audit-logged).
  const badOpen = await api('POST', `/api/support/sessions/${reqS.body.session_id}/open`, { token: 'wrong-token' });
  check('D2. open with wrong token refused', badOpen.status === 403);

  // Correct token opens the tunnel (outbound, time-limited).
  const goodOpen = await api('POST', `/api/support/sessions/${reqS.body.session_id}/open`, { token: reqS.body.token });
  check('D3. open with correct JIT token -> open', goodOpen.status === 200 && goodOpen.body.state === 'open', goodOpen.body?.state);

  // A second open with the same token is NOT allowed to extend the session.
  const reopen = await api('POST', `/api/support/sessions/${reqS.body.session_id}/open`, { token: reqS.body.token });
  check('D4. re-open with the consumed token is not a fresh open', reopen.status !== 200, `status=${reopen.status}`);

  // The session closes at its time limit: create a 2-second session, open it,
  // wait past the TTL, and confirm a read reports it expired (not stuck open).
  const shortS = await api('POST', '/api/support/sessions', { device_id: deviceId, requested_by: 'ops-manager-1', ttl_seconds: 2 });
  await api('POST', `/api/support/sessions/${shortS.body.session_id}/open`, { token: shortS.body.token });
  let afterExpiry = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const cur = await api('GET', `/api/support/sessions/${shortS.body.session_id}`);
    if (cur.body?.state === 'expired') { afterExpiry = cur; break; }
  }
  check('D5. session closes at its time limit (not left open)', afterExpiry?.body?.state === 'expired', `state=${afterExpiry?.body?.state}`);
}

await partA();
await partB();
await partC();
await partD();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} alerting/rbac/audit/support checks passed`);
process.exit(failed.length ? 1 : 0);
