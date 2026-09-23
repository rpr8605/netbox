// control-plane/src/routes/alerts.js
// Responsibility: alert rule/contact management, alert firing, and the
// required acknowledgment endpoint. The escalation ENGINE lives in
// alerting.js; this file is the HTTP surface + the RBAC stub for who may fire
// vs ack vs view. Delivery config is injected via app.config by index.js.
import crypto from 'node:crypto';
import {
  listAlertRules, listAlerts, getAlert, getAlertRule, createAlertRule, createAlertContact,
  listChannels,
} from '../db.js';
import { fireAlert, acknowledgeAlert, validateImpactStatement } from '../alerting.js';
import { deliver, sendSendGrid } from '../deliver.js';
import { requirePerm } from '../rbac.js';
import { appendAudit } from '../db.js';

export default async function alertRoutes(app) {
  const cfg = app.config ?? {};

  app.get('/api/alerts', async () => listAlerts());
  app.get('/api/alert-rules', async () => listAlertRules());

  // Register a rule. The plain-language gate runs here: a rule whose impact
  // statement reads like a transport error is rejected before it can ever page.
  app.post('/api/alert-rules', async (req, reply) => {
    const { severity, service, impact_stmt, runbook_url = null, ack_window_s = 300,
            maintenance_start = null, maintenance_end = null } = req.body ?? {};
    if (!severity || !service) return reply.code(400).send({ error: 'severity and service required' });
    const v = validateImpactStatement(impact_stmt);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const rule_id = crypto.randomUUID();
    createAlertRule({ rule_id, severity, service, impact_stmt, runbook_url, ack_window_s, maintenance_start, maintenance_end });
    return { rule_id, severity, service };
  });

  // Register an escalation contact (tier = order paged).
  app.post('/api/alert-contacts', async (req, reply) => {
    const { severity, tier, channel, address } = req.body ?? {};
    if (!severity || tier == null || !channel || !address) {
      return reply.code(400).send({ error: 'severity, tier, channel, address required' });
    }
    const contact_id = crypto.randomUUID();
    createAlertContact({ contact_id, severity, tier, channel, address });
    return { contact_id };
  });

  // Fire an alert for a rule+device. In production this is called by the
  // ingestion path when a confirmed outage lands; here it's the demo/test
  // surface that proves the engine end to end.
  app.post('/api/alerts/fire', { preHandler: requirePerm('alerts:fire', appendAudit) }, async (req, reply) => {
    const { rule_id, device_id, site_id } = req.body ?? {};
    if (!rule_id || !device_id || !site_id) return reply.code(400).send({ error: 'rule_id, device_id, site_id required' });
    try {
      const out = await fireAlert({ ruleId: rule_id, deviceId: device_id, siteId: site_id, deliver: (c, a) => deliver(c, a, cfg) });
      return out;
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // The required ack. Stops the escalation sweep.
  app.post('/api/alerts/:id/ack', { preHandler: requirePerm('alerts:ack', appendAudit) }, async (req, reply) => {
    const out = await acknowledgeAlert({ alertId: req.params.id, actor: req.body?.actor ?? 'unknown' });
    if (!out.ok) return reply.code(400).send(out);
    return out;
  });

  // --- Ticketing Tier 0 (TOPOLOGY_AND_TROUBLESHOOTING_MEMORY.md §3) ------------
  // Copy-paste-ready incident block. No vendor API, no credentials — works with
  // any ticketing system or plain inbox that accepts text/Markdown.
  app.get('/api/alerts/:id/ticket', { preHandler: requirePerm('alerts:read', appendAudit) }, async (req, reply) => {
    const alert = getAlert(req.params.id);
    if (!alert) return reply.code(404).send({ error: 'alert not found' });
    const rule = getAlertRule(alert.rule_id);
    return formatTicketBlock(alert, rule);
  });

  // Send the same block as email via the existing SendGrid pipe. If SendGrid is
  // not configured, returns {sent:false, reason:'sendgrid not configured'} rather
  // than throwing, so a missing integration does not crash the console.
  app.post('/api/alerts/:id/ticket/email', { preHandler: requirePerm('alerts:ack', appendAudit) }, async (req, reply) => {
    const alert = getAlert(req.params.id);
    if (!alert) return reply.code(404).send({ error: 'alert not found' });
    const to = req.body?.to;
    if (!to || typeof to !== 'string') return reply.code(400).send({ error: 'to address required' });
    const rule = getAlertRule(alert.rule_id);
    const block = formatTicketBlock(alert, rule);
    const apiKey = cfg.sendgrid?.apiKey ?? process.env.SENDGRID_API_KEY;
    const from = cfg.sendgrid?.from ?? process.env.SENDGRID_FROM ?? 'alerts@beacon-relay.local';
    const result = await sendSendGrid({ apiKey, from, to, subject: block.title, text: block.plain_text });
    appendAudit({ auditId: crypto.randomUUID(), actor: req.body?.actor ?? 'unknown', action: 'alert.ticket.email', target: alert.alert_id, detail: `to=${to} sent=${!(result.skipped || result.status >= 400)}` });
    if (result.skipped) return { sent: false, reason: result.reason };
    return { sent: result.status >= 200 && result.status < 300, result };
  });
}

// formatTicketBlock — deterministic, metadata-only text/markdown rendering of an
// alert for any ticketing system. Excludes raw events, payload, keys, or cert
// contents; includes only the severity, service, site, impact, runbook, status,
// and timestamps the alert already carries.
function formatTicketBlock(alert, rule) {
  const title = `[${alert.severity}] ${rule?.service ?? alert.service} alert at site ${alert.site_id}`;
  const lines = [
    `TITLE: ${title}`,
    `SEVERITY: ${alert.severity}`,
    `SERVICE: ${rule?.service ?? alert.service}`,
    `SITE: ${alert.site_id}`,
    `DEVICE: ${alert.device_id}`,
    `STATUS: ${alert.status}`,
    `TIER: ${alert.current_tier ?? 1}`,
    `IMPACT: ${alert.impact_stmt ?? rule?.impact_stmt ?? '(no impact statement)'}`,
    `RUNBOOK: ${rule?.runbook_url ?? '(none attached)'}`,
    `OPENED: ${alert.created_at}`,
  ];
  if (alert.escalated_at) lines.push(`ESCALATED: ${alert.escalated_at}`);
  if (alert.acked_at) lines.push(`ACKED: ${alert.acked_at} by ${alert.acked_by ?? 'unknown'}`);
  const plainText = lines.join('\n');
  const markdown = [
    `# ${title}`,
    '',
    '| Field | Value |',
    '|---|---|',
    ...lines.slice(1).map(l => {
      const [k, ...rest] = l.split(': ');
      return `| ${k} | ${rest.join(': ')} |`;
    }),
  ].join('\n');
  return { title, plain_text: plainText, markdown };
}
