// control-plane/src/routes/alerts.js
// Responsibility: alert rule/contact management, alert firing, and the
// required acknowledgment endpoint. The escalation ENGINE lives in
// alerting.js; this file is the HTTP surface + the RBAC stub for who may fire
// vs ack vs view. Delivery config is injected via app.config by index.js.
import crypto from 'node:crypto';
import {
  listAlertRules, listAlerts, getAlert, createAlertRule, createAlertContact,
  listChannels,
} from '../db.js';
import { fireAlert, acknowledgeAlert, validateImpactStatement } from '../alerting.js';
import { deliver } from '../deliver.js';

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
  app.post('/api/alerts/fire', async (req, reply) => {
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
  app.post('/api/alerts/:id/ack', async (req, reply) => {
    const out = await acknowledgeAlert({ alertId: req.params.id, actor: req.body?.actor ?? 'unknown' });
    if (!out.ok) return reply.code(400).send(out);
    return out;
  });
}
