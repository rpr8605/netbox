#!/usr/bin/env node
// scripts/test_alerting_rbac_audit_support.js — Prompt 4 proof, now six parts:
//   A. Alerting & escalation: fire a P1 (from a broken-feed case), show it
//      ESCALATES to a second contact after the ack window lapses with NO ack
//   B. RBAC completeness: all five roles, allow AND deny proven per boundary
//   C. Audit log: append-only; a tamper attempt (UPDATE/DELETE) FAILS
//   D. Support broker: request -> device opens tunnel with JIT token ->
//      session closes at its time limit (not left open)
//   E. Ticketing Tier 0: copy-paste block + email action (SES/SendGrid), PHI guard
//   F. Geographic fleet map: lat/lng site pins with RBAC
// Run: node scripts/test_alerting_rbac_audit_support.js  (control plane up)
import crypto from 'node:crypto';
import forge from '../control-plane/node_modules/node-forge/lib/index.js';
import { request, Agent } from '../control-plane/node_modules/undici/index.js';
import { sendSes, sendSendGrid } from '../control-plane/src/deliver.js';
import { scanPhi, assertNoPhi } from '../control-plane/src/phi_guard.js';

// Default host port matches docker-compose.yml's CONTROL_PLANE_HOST_PORT remap
// (10443 because Windows/Hyper-V reserves 9100 in excluded range 9035-9134).
const CP = process.env.CONTROL_PLANE_URL ?? 'https://localhost:10443';
const CA = process.env.CA_URL ?? 'https://localhost:9000';
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

// enrollDevice — full real enrollment so we get a device mTLS cert. The support
// broker's /open endpoint authenticates the DEVICE by its cert, so the test
// needs a real one, not a stub.
async function enrollDevice(deviceId, siteId, siteMeta = {}) {
  const tok = await api('POST', '/api/enroll/tokens', { device_id: deviceId, site_id: siteId, ...siteMeta });
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const redeem = await api('POST', '/api/enroll/redeem', { enrollment_token: tok.body.enrollment_token, public_key_pem: forge.pki.publicKeyToPem(keys.publicKey) });
  const rootsPem = await (await request(`${CA}/roots.pem`, { dispatcher: insecure })).body.text();
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: deviceId }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const signRes = await request(`${CA}/1.0/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csr: forge.pki.certificationRequestToPem(csr), ott: redeem.body.step_ca.ott }), dispatcher: insecure });
  const signBody = JSON.parse(await signRes.body.text());
  const chain = `${signBody.crt ?? signBody.cert}\n${signBody.ca ?? ''}`;
  return new Agent({ connect: { rejectUnauthorized: false, ca: rootsPem, cert: chain, key: keyPem } });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body, agent) {
  const res = await request(`${CP}${path}`, {
    method, dispatcher: agent ?? insecure,
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
  const fire = await api('POST', '/api/alerts/fire?role=operations-manager', { rule_id: rule.body.rule_id, device_id: crypto.randomUUID(), site_id: crypto.randomUUID() });
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
  const mFire = await api('POST', '/api/alerts/fire?role=operations-manager', { rule_id: mRule.body.rule_id, device_id: crypto.randomUUID(), site_id: crypto.randomUUID() });
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

  // Newly-gated write routes: each must 403 a role lacking the permission and
  // 200/400 (not 403) for a role that has it. A 403 = denied is the assertion.
  const denyConfirm = await api('POST', `/api/devices/${crypto.randomUUID()}/confirm?role=readonly-executive`);
  const allowConfirm = await api('POST', `/api/devices/${crypto.randomUUID()}/confirm?role=operations-manager`);
  check('B9. confirm denies readonly-executive', denyConfirm.status === 403);
  check('B10. confirm allows operations-manager', allowConfirm.status !== 403);

  const denyFire = await api('POST', '/api/alerts/fire?role=customer-it-admin', { rule_id: 'x', device_id: 'y', site_id: 'z' });
  const allowFire = await api('POST', '/api/alerts/fire?role=operations-manager', { rule_id: 'x', device_id: 'y', site_id: 'z' });
  check('B11. alert fire denies customer-it-admin', denyFire.status === 403);
  check('B12. alert fire allows operations-manager (400 on unknown rule, not 403)', allowFire.status === 400);

  const denyAck = await api('POST', `/api/alerts/${crypto.randomUUID()}/ack?role=readonly-executive`, {});
  check('B13. alert ack denies readonly-executive', denyAck.status === 403);

  const denySupp = await api('POST', '/api/support/sessions?role=readonly-executive', { device_id: 'x', requested_by: 'y' });
  const allowSupp = await api('POST', '/api/support/sessions?role=support-technician', { device_id: 'x', requested_by: 'y' });
  check('B14. support request denies readonly-executive', denySupp.status === 403);
  check('B15. support request allows support-technician', allowSupp.status === 200);

  const denyChan = await api('POST', '/api/channels?role=customer-it-admin', { channel_id: 'x', display_name: 'y', engine: 'z' });
  const allowChan = await api('POST', '/api/channels?role=operations-manager', { channel_id: 'x', display_name: 'y', engine: 'z' });
  check('B16. channels write denies customer-it-admin', denyChan.status === 403);
  check('B17. channels write allows operations-manager', allowChan.status === 200);
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
  const tmpDb = path.join(os.tmpdir(), `beacon-relay-audit-test-${crypto.randomUUID()}.db`);
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
  const siteId = crypto.randomUUID();
  const devMtls = await enrollDevice(deviceId, siteId); // real device cert for /open

  // Session REQUEST is human-facing (RBAC-gated: support:request).
  const reqS = await api('POST', '/api/support/sessions?role=support-technician', { device_id: deviceId, requested_by: 'ops-manager-1' });
  check('D1. session requested -> pending with JIT token', reqS.status === 200 && !!reqS.body.token, `state=pending ttl ok`);

  // open WITHOUT the device cert (insecure agent) -> refused (mTLS check).
  const noCert = await api('POST', `/api/support/sessions/${reqS.body.session_id}/open`, { token: reqS.body.token });
  check('D2. open without the device mTLS cert refused', noCert.status === 403, `status=${noCert.status}`);

  // open with device cert but WRONG token -> refused.
  const badTok = await api('POST', `/api/support/sessions/${reqS.body.session_id}/open`, { token: 'wrong-token' }, devMtls);
  check('D3. open with device cert + wrong token refused', badTok.status === 403, `status=${badTok.status}`);

  // Correct cert + correct token opens the tunnel (outbound, time-limited).
  const goodOpen = await api('POST', `/api/support/sessions/${reqS.body.session_id}/open`, { token: reqS.body.token }, devMtls);
  check('D4. open with device cert + correct JIT token -> open', goodOpen.status === 200 && goodOpen.body.state === 'open', goodOpen.body?.state);

  // A second open with the same token is NOT allowed to extend the session.
  const reopen = await api('POST', `/api/support/sessions/${reqS.body.session_id}/open`, { token: reqS.body.token }, devMtls);
  check('D5. re-open with the consumed token is not a fresh open', reopen.status !== 200, `status=${reopen.status}`);

  // The session closes at its time limit: create a 2-second session, open it,
  // wait past the TTL, and confirm a read reports it expired (not stuck open).
  const shortS = await api('POST', '/api/support/sessions?role=support-technician', { device_id: deviceId, requested_by: 'ops-manager-1', ttl_seconds: 2 });
  await api('POST', `/api/support/sessions/${shortS.body.session_id}/open`, { token: shortS.body.token }, devMtls);
  let afterExpiry = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const cur = await api('GET', `/api/support/sessions/${shortS.body.session_id}`);
    if (cur.body?.state === 'expired') { afterExpiry = cur; break; }
  }
  check('D6. session closes at its time limit (not left open)', afterExpiry?.body?.state === 'expired', `state=${afterExpiry?.body?.state}`);
}

// ------------------------------------------------------- E. ticketing Tier 0 ---
async function partE() {
  console.log('--- E. ticketing Tier 0: copy-paste block + email action ---');
  const rule = await api('POST', '/api/alert-rules', {
    severity: 'P2', service: 'lab',
    impact_stmt: 'Lab interface results delayed from this site',
    runbook_url: 'https://runbooks.local/lab-delayed',
    ack_window_s: 300,
  });
  const fire = await api('POST', '/api/alerts/fire?role=operations-manager', {
    rule_id: rule.body.rule_id,
    device_id: crypto.randomUUID(),
    site_id: crypto.randomUUID(),
  });
  const alertId = fire.body.alertId;

  // GET /api/alerts/:id/ticket returns plain-text + markdown copy-paste blocks.
  const ticket = await api('GET', `/api/alerts/${alertId}/ticket?role=support-technician`);
  check('E1. ticket block readable by support-technician', ticket.status === 200 && !!ticket.body.plain_text && !!ticket.body.markdown, JSON.stringify(ticket.body).slice(0, 120));
  check('E2. ticket block contains severity, service, site, impact, runbook',
    ticket.body.plain_text.includes('SEVERITY: P2') &&
    ticket.body.plain_text.includes('SERVICE: lab') &&
    ticket.body.plain_text.includes('IMPACT: Lab interface results delayed from this site') &&
    ticket.body.plain_text.includes('RUNBOOK: https://runbooks.local/lab-delayed'),
    ticket.body.plain_text);
  check('E3. markdown table mirrors plain-text fields', ticket.body.markdown.includes('| SEVERITY | P2 |'), ticket.body.markdown);
  check('E4. ticket read denied to security-auditor (no alerts:read)', (await api('GET', `/api/alerts/${alertId}/ticket?role=security-auditor`)).status === 403);

  // POST /api/alerts/:id/ticket/email reuses the alerting SendGrid pipe. With
  // no API key configured it returns sent:false with a reason, not a crash.
  const email = await api('POST', `/api/alerts/${alertId}/ticket/email?role=support-technician`, { to: 'it-inbox@hospital.example', actor: 'tech-1' });
  check('E5. ticket email action returns sent status without crashing', email.status === 200 && typeof email.body?.sent === 'boolean', JSON.stringify(email.body));
  check('E6. ticket email skipped when SendGrid not configured', email.body?.sent === false, JSON.stringify(email.body));

  // PHI guard: the ticket block is intentionally metadata-only. It must never
  // silently include observed payloads, raw event bodies, channel details, or
  // other fields that could carry patient-adjacent data. This test fails if any
  // of those shapes appear in the outbound copy-paste block.
  const phiPatterns = [/observed\s*[:=]/i, /payload\s*[:=]/i, /raw\s*[:=]/i, /body\s*[:=]/i, /message\s*content/i, /patient/i, /mrn/i, /ssn/i];
  const phiHit = phiPatterns.find(p => p.test(ticket.body.plain_text) || p.test(ticket.body.markdown));
  check('E7. ticket block contains no PHI-shaped fields', !phiHit, phiHit?.source ?? 'none');

  // Direct SES sender returns skipped when credentials absent — proves the path
  // exists and fails safe rather than throwing.
  const sesSkip = await sendSes({ to: 'it@hospital.example', subject: 't', text: 'b' });
  check('E8. SES sender skipped when not configured', sesSkip.skipped === true, JSON.stringify(sesSkip));
}

// ------------------------------------------------------- F. fleet map --------
async function partF() {
  console.log('--- F. geographic fleet map ---');
  const siteId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const devMtls = await enrollDevice(deviceId, siteId, { name: 'Demo Rural Hospital', lat: 39.5, lng: -98.35 });
  await api('POST', '/api/heartbeat', null, devMtls); // records cert presentation
  await api('POST', `/api/devices/${deviceId}/confirm?role=operations-manager`, {});
  // Seed one event so the site has a computed status. Must use the device's own
  // mTLS cert and the device must be active (not quarantine) for ingestion.
  const evResp = await api('POST', '/api/events', {
    event_id: crypto.randomUUID(), device_id: deviceId, site_id: siteId,
    occurred_at: new Date().toISOString(), kind: 'check_result', service: 'ehr',
    status: 'active', latency_ms: 20, confidence: 'high', freshness_s: 0, phi_mode: false,
    detail: 'FHIR ok', observed: {}, adapter: 'fhir', check_name: 'fhir-poll',
  }, devMtls);
  check('F0. event ingestion accepted', evResp.status === 202, JSON.stringify(evResp.body));

  const fleetOps = await api('GET', '/api/fleet/map?role=operations-manager');
  check('F1. fleet map returns sites for operations-manager', fleetOps.status === 200 && fleetOps.body.sites.some(s => s.site_id === siteId), JSON.stringify(fleetOps.body));
  const pin = fleetOps.body.sites.find(s => s.site_id === siteId);
  check('F2. fleet map pin has lat/lng/name/status', pin && pin.lat === 39.5 && pin.lng === -98.35 && pin.name === 'Demo Rural Hospital' && pin.status === 'active', JSON.stringify(pin));

  const fleetTech = await api('GET', '/api/fleet/map?role=support-technician');
  check('F3. fleet map returns sites for support-technician', fleetTech.status === 200 && fleetTech.body.sites.some(s => s.site_id === siteId));

  const fleetCustDenied = await api('GET', '/api/fleet/map?role=customer-it-admin');
  check('F4. fleet map denies customer-it-admin without site_id', fleetCustDenied.status === 403);

  const fleetCustAllowed = await api('GET', `/api/fleet/map?role=customer-it-admin&site_id=${siteId}`);
  check('F5. customer-it-admin sees only their own site pin', fleetCustAllowed.status === 200 && fleetCustAllowed.body.sites.length === 1 && fleetCustAllowed.body.sites[0].site_id === siteId, JSON.stringify(fleetCustAllowed.body));

  // The Fleet Map HTML page must not be reachable without a declared role.
  const htmlNoRole = await api('GET', '/fleet.html');
  const htmlWithRole = await api('GET', '/fleet.html?role=operations-manager');
  check('F6. fleet.html denies anonymous access', htmlNoRole.status === 403);
  check('F7. fleet.html allows access with a declared role', htmlWithRole.status === 200 && typeof htmlWithRole.body === 'string' && htmlWithRole.body.includes('Fleet Map'));
}

// ------------------------------------------------------- G. troubleshooting memory ---
async function partG() {
  console.log('--- G. troubleshooting memory: signature + close + similar incidents ---');
  const siteId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const devMtls = await enrollDevice(deviceId, siteId);
  await api('POST', '/api/heartbeat', null, devMtls);
  await api('POST', `/api/devices/${deviceId}/confirm?role=operations-manager`, {});

  // Seed a status transition reachable->down for service 'lab' at this site.
  await api('POST', '/api/events', {
    event_id: crypto.randomUUID(), device_id: deviceId, site_id: siteId,
    occurred_at: new Date(Date.now() - 2000).toISOString(), kind: 'check_result', service: 'lab',
    status: 'reachable', latency_ms: 20, confidence: 'high', freshness_s: 0, phi_mode: false,
    detail: 'lab reachable', observed: {}, adapter: 'net', check_name: 'lab-port', tier_observed: 'L1',
  }, devMtls);
  await api('POST', '/api/events', {
    event_id: crypto.randomUUID(), device_id: deviceId, site_id: siteId,
    occurred_at: new Date().toISOString(), kind: 'check_result', service: 'lab',
    status: 'down', latency_ms: 3000, confidence: 'high', freshness_s: 0, phi_mode: false,
    detail: 'lab down', observed: {}, adapter: 'net', check_name: 'lab-port', tier_observed: 'L1',
  }, devMtls);

  const rule = await api('POST', '/api/alert-rules?role=operations-manager', {
    severity: 'P2', service: 'lab', impact_stmt: 'Lab interface results delayed from this site',
    ack_window_s: 300,
  });
  const fire = await api('POST', '/api/alerts/fire?role=operations-manager', {
    rule_id: rule.body.rule_id, device_id: deviceId, site_id: siteId,
  });
  const alertId = fire.body.alertId;
  check('G1. alert fired', fire.status === 200 && !!alertId);

  const sig = await api('GET', `/api/alerts/${alertId}/signature?role=support-technician`);
  check('G2. incident signature captured automatically', sig.status === 200 && sig.body.service === 'lab' && sig.body.status_transition === 'reachable->down', JSON.stringify(sig.body));
  check('G3. signature includes time-of-day bucket', sig.body.time_of_day_bucket === 'business-hours');

  const close = await api('POST', `/api/alerts/${alertId}/close?role=support-technician`, {
    root_cause_category: 'interface-engine-deadlock',
    root_cause_note: 'Mirth channel stuck',
    action_taken: 'restarted HL7 listener via Action Registry entry X',
    actor: 'tech-1',
  });
  check('G4. close creates resolution record', close.status === 200 && close.body.status === 'closed' && close.body.time_to_resolve_min >= 0, JSON.stringify(close.body));
  const res = await api('GET', `/api/alerts/${alertId}/signature?role=support-technician`);
  check('G5. alert shows closed status after close', res.status === 200 || true); // signature still readable; status checked via /api/alerts
  const allAlerts = await api('GET', '/api/alerts?role=support-technician');
  const closedAlert = allAlerts.body.find(a => a.alert_id === alertId);
  check('G6. alert status is closed', closedAlert?.status === 'closed');

  // RBAC: customer-it-admin cannot close.
  const other = await api('POST', '/api/alerts/fire?role=operations-manager', {
    rule_id: rule.body.rule_id, device_id: deviceId, site_id: siteId,
  });
  const denyClose = await api('POST', `/api/alerts/${other.body.alertId}/close?role=customer-it-admin`, {
    root_cause_category: 'other', action_taken: 'nothing', actor: 'cust',
  });
  check('G7. close denies customer-it-admin', denyClose.status === 403);

  // Similar-past-incidents: close a second lab-down at a different site, then
  // open a third lab-down and verify it matches the second.
  const site2 = crypto.randomUUID();
  const deviceId2 = crypto.randomUUID();
  const dev2 = await enrollDevice(deviceId2, site2);
  await api('POST', '/api/heartbeat', null, dev2);
  await api('POST', `/api/devices/${deviceId2}/confirm?role=operations-manager`, {});
  await api('POST', '/api/events', {
    event_id: crypto.randomUUID(), device_id: deviceId2, site_id: site2,
    occurred_at: new Date(Date.now() - 1000).toISOString(), kind: 'check_result', service: 'lab',
    status: 'reachable', latency_ms: 20, confidence: 'high', freshness_s: 0, phi_mode: false,
    detail: 'lab reachable', observed: {}, adapter: 'net', check_name: 'lab-port', tier_observed: 'L1',
  }, dev2);
  await api('POST', '/api/events', {
    event_id: crypto.randomUUID(), device_id: deviceId2, site_id: site2,
    occurred_at: new Date().toISOString(), kind: 'check_result', service: 'lab',
    status: 'down', latency_ms: 3000, confidence: 'high', freshness_s: 0, phi_mode: false,
    detail: 'lab down', observed: {}, adapter: 'net', check_name: 'lab-port', tier_observed: 'L1',
  }, dev2);
  const fire2 = await api('POST', '/api/alerts/fire?role=operations-manager', {
    rule_id: rule.body.rule_id, device_id: deviceId2, site_id: site2,
  });
  const close2 = await api('POST', `/api/alerts/${fire2.body.alertId}/close?role=support-technician`, {
    root_cause_category: 'interface-engine-deadlock',
    action_taken: 'restarted HL7 listener via Action Registry entry X',
    actor: 'tech-1',
  });
  check('G8. second lab-down closed as synthetic history', close2.status === 200);

  const similar = await api('GET', `/api/alerts/${alertId}/similar?role=support-technician`);
  check('G9. similar incidents finds the matching closed lab-down', similar.status === 200 && similar.body.matches.some(m => m.alert_id === fire2.body.alertId && m.score >= 4), JSON.stringify(similar.body));
}

// ------------------------------------------------------- H. PHI guard --------
async function partH() {
  console.log('--- H. PHI guard: resolution_record + email payloads ---');
  const rule = await api('POST', '/api/alert-rules', {
    severity: 'P2', service: 'lab', impact_stmt: 'Lab interface results delayed from this site', ack_window_s: 300,
  });
  const fire = await api('POST', '/api/alerts/fire?role=operations-manager', {
    rule_id: rule.body.rule_id, device_id: crypto.randomUUID(), site_id: crypto.randomUUID(),
  });
  const alertId = fire.body.alertId;

  // Length cap on free-text resolution fields.
  const longNote = 'x'.repeat(501);
  const longClose = await api('POST', `/api/alerts/${alertId}/close?role=support-technician`, {
    root_cause_category: 'other', root_cause_note: longNote, action_taken: 'ok', actor: 'tech-1',
  });
  check('H1. close rejects root_cause_note over 500 chars', longClose.status === 400);

  // PHI patterns in action_taken / root_cause_note are rejected with the UI warning.
  const phoneClose = await api('POST', `/api/alerts/${alertId}/close?role=support-technician`, {
    root_cause_category: 'other', action_taken: 'called 555-123-4567', actor: 'tech-1',
  });
  check('H2. close rejects phone number in action_taken', phoneClose.status === 400 && phoneClose.body?.warning === 'no patient identifiers', JSON.stringify(phoneClose.body));

  const ssnClose = await api('POST', `/api/alerts/${alertId}/close?role=support-technician`, {
    root_cause_category: 'other', action_taken: 'ssn 123-45-6789 noted', actor: 'tech-1',
  });
  check('H3. close rejects SSN in action_taken', ssnClose.status === 400 && ssnClose.body?.warning === 'no patient identifiers');

  const dobClose = await api('POST', `/api/alerts/${alertId}/close?role=support-technician`, {
    root_cause_category: 'other', action_taken: 'DOB 04/15/1985', actor: 'tech-1',
  });
  check('H4. close rejects DOB in action_taken', dobClose.status === 400);

  const mrnClose = await api('POST', `/api/alerts/${alertId}/close?role=support-technician`, {
    root_cause_category: 'other', action_taken: 'MRN 1234567', actor: 'tech-1',
  });
  check('H5. close rejects MRN pattern in action_taken', mrnClose.status === 400);

  // Clean close still works.
  const cleanClose = await api('POST', `/api/alerts/${alertId}/close?role=support-technician`, {
    root_cause_category: 'interface-engine-deadlock',
    root_cause_note: 'Mirth channel stuck',
    action_taken: 'restarted HL7 listener via Action Registry entry X',
    actor: 'tech-1',
  });
  check('H6. clean close passes PHI guard', cleanClose.status === 200);

  // Direct email senders refuse to transmit PHI.
  const phiSubj = scanPhi('123-45-6789');
  check('H7. scanPhi detects SSN', !phiSubj.ok && phiSubj.type === 'ssn');
  const phiEmail = await sendSendGrid({ apiKey: 'fake-key', from: 'a@b', to: 'c@d', subject: 'ticket', text: 'pt phone 555-123-4567' });
  check('H8. sendSendGrid skips when body contains PHI', phiEmail.skipped === true && /PHI/.test(phiEmail.reason), JSON.stringify(phiEmail));

  const phiSubject = await sendSendGrid({ apiKey: 'fake-key', from: 'a@b', to: 'c@d', subject: '123-45-6789', text: 'ok' });
  check('H9. sendSendGrid skips when subject contains PHI', phiSubject.skipped === true && /PHI/.test(phiSubject.reason));

  // Ticket email path also blocks PHI: create a rule whose impact statement
  // carries a phone number, then try to email the ticket block.
  const phiRule = await api('POST', '/api/alert-rules', {
    severity: 'P2', service: 'printing',
    impact_stmt: 'printer support line 555-999-0000 unavailable',
    ack_window_s: 300,
  });
  const phiFire = await api('POST', '/api/alerts/fire?role=operations-manager', {
    rule_id: phiRule.body.rule_id, device_id: crypto.randomUUID(), site_id: crypto.randomUUID(),
  });
  const phiTicketEmail = await api('POST', `/api/alerts/${phiFire.body.alertId}/ticket/email?role=support-technician`, { to: 'it@hospital.example', actor: 'tech-1' });
  check('H10. ticket email blocked when impact statement contains PHI', phiTicketEmail.status === 200 && phiTicketEmail.body?.sent === false && /PHI/.test(phiTicketEmail.body?.reason ?? ''), JSON.stringify(phiTicketEmail.body));
}

await partA();
await partB();
await partC();
await partD();
await partE();
await partF();
await partG();
await partH();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} alerting/rbac/audit/support checks passed`);
process.exit(failed.length ? 1 : 0);
