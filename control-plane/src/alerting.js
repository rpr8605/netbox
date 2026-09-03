// control-plane/src/alerting.js
// Responsibility: the alert escalation ENGINE (spec §6) — severity tiers,
// owner mapping, plain-language impact statements, runbook attachment,
// required acknowledgment with automatic escalation on timeout, and
// suppression/maintenance windows. Delivery rails (Twilio SMS/voice, SES/
// SendGrid email, Slack/Teams webhook) are INJECTED — Netbox owns the
// escalation DECISIONS (who, when, how loud, what's attached) as product IP;
// the senders are proven plumbing.
// Called by: routes/alerts.js (fire/ack), and the sweep timer in index.js.
//
// PLAIN-LANGUAGE RULE: impact statements come from the alert_rule, never from
// a raw port/protocol string. "EHR login unavailable from this site" — not
// "TCP 443 timeout". A rule whose impact_stmt looks like a transport error is
// rejected at creation.
import crypto from 'node:crypto';
import {
  getAlertRule, contactsFor, maxTier, createAlert, getAlert, ackAlert,
  escalateAlert, openUnackedPastDeadline, appendAudit,
} from './db.js';

// Reject transport-jargon impact statements at the door — the console and the
// on-call page are for humans. Spec §6 makes this a product requirement.
const JARGON = /\b(tcp|udp|port \d|icmp|tls handshake|econnrefused|http \d{3})\b/i;

// validateImpactStatement — a rule's impact_stmt must be plain language a
// hospital IT lead can act on ("EHR login unavailable from this site"), never
// a raw port/protocol string. Returns {ok} or {ok:false, error}.
export function validateImpactStatement(stmt) {
  if (!stmt || typeof stmt !== 'string') return { ok: false, error: 'impact statement required' };
  if (JARGON.test(stmt)) return { ok: false, error: 'impact statement must be plain language, not a port/protocol string' };
  return { ok: true };
}

// In a maintenance window an alert is SUPPRESSED, not fired — the window is
// the operator's pre-declared "we know, we're working on it" interval.
export function inMaintenanceWindow(rule, now = new Date()) {
  if (!rule.maintenance_start || !rule.maintenance_end) return false;
  const t = now.getTime();
  return t >= Date.parse(rule.maintenance_start) && t <= Date.parse(rule.maintenance_end);
}

// fireAlert — create an open alert, audit it, and deliver to the tier-1
// contact(s). Suppression in a maintenance window returns {suppressed:true}
// and creates NO alert row (a suppressed alert must not page anyone).
export async function fireAlert({ ruleId, deviceId, siteId, deliver, auditActor = 'system' }) {
  const rule = getAlertRule(ruleId);
  if (!rule) throw new Error(`unknown alert rule ${ruleId}`);
  if (inMaintenanceWindow(rule)) {
    appendAudit({ auditId: crypto.randomUUID(), actor: auditActor, action: 'alert.suppressed', target: ruleId, detail: `maintenance window for ${rule.service}` });
    return { suppressed: true, reason: 'maintenance window' };
  }
  const alertId = crypto.randomUUID();
  const ackDeadline = new Date(Date.now() + rule.ack_window_s * 1000).toISOString().replace('T', ' ').slice(0, 19);
  createAlert({
    alert_id: alertId, rule_id: ruleId, device_id: deviceId, site_id: siteId,
    severity: rule.severity, impact_stmt: rule.impact_stmt, ack_deadline: ackDeadline,
  });
  appendAudit({ auditId: crypto.randomUUID(), actor: auditActor, action: 'alert.fired', target: alertId, detail: `${rule.severity} ${rule.service}` });
  const contacts = contactsFor(rule.severity, 1);
  const deliveries = [];
  for (const c of contacts) {
    deliveries.push(await deliver(c, { alertId, severity: rule.severity, impact: rule.impact_stmt, runbook: rule.runbook_url }));
  }
  return { alertId, severity: rule.severity, delivered: deliveries.length };
}

// acknowledgeAlert — the required ack. Acknowledging stops the escalation
// sweep; it is audit-logged with the actor.
export async function acknowledgeAlert({ alertId, actor }) {
  const a = getAlert(alertId);
  if (!a) return { ok: false, error: 'unknown alert' };
  if (a.status !== 'open') return { ok: false, error: `alert is ${a.status}, not open` };
  ackAlert(alertId, actor);
  appendAudit({ auditId: crypto.randomUUID(), actor, action: 'alert.acked', target: alertId });
  return { ok: true, status: 'acked' };
}

// sweepEscalations — run on a timer: any open alert past its ack_deadline is
// escalated to the next tier and re-delivered. The escalation is audit-logged
// and returns the list of alerts escalated this sweep (for tests + console).
export async function sweepEscalations({ deliver, now = new Date() }) {
  const nowIso = now.toISOString().replace('T', ' ').slice(0, 19);
  const overdue = openUnackedPastDeadline(nowIso);
  const escalated = [];
  for (const a of overdue) {
    const nextTier = a.current_tier + 1;
    if (nextTier > maxTier(a.severity)) continue; // no one left to escalate to
    escalateAlert(a.alert_id, nextTier);
    appendAudit({ auditId: crypto.randomUUID(), actor: 'system', action: 'alert.escalated', target: a.alert_id, detail: `to tier ${nextTier}` });
    const contacts = contactsFor(a.severity, nextTier);
    for (const c of contacts) {
      await deliver(c, { alertId: a.alert_id, severity: a.severity, impact: a.impact_stmt, runbook: null, escalated: true });
    }
    escalated.push(a.alert_id);
  }
  return escalated;
}
