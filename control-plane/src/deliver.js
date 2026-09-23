// control-plane/src/deliver.js
// Responsibility: the delivery rails for the alerting engine (spec §6) —
// Twilio SMS/voice, SES/SendGrid email, Slack/Teams webhook. Beacon Relay owns the
// escalation DECISIONS (alerting.js); this file is the proven plumbing that
// actually sends. Each channel is a small function over the injected config;
// a channel with no credentials configured returns {skipped:true} so a
// missing integration never crashes an escalation.
// Called by: alerting.js's fireAlert/sweepEscalations via the deliver() below.
import https from 'node:https';
import { scanPhi } from './phi_guard.js';

function postJson(urlStr, body, headers = {}) {
  const u = new URL(urlStr);
  return new Promise(resolve => {
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(body)), ...headers },
      rejectUnauthorized: true, // these are PUBLIC SaaS endpoints — verify TLS
      timeout: 5000,
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, body: String(e.message ?? e) }));
    req.end(JSON.stringify(body));
  });
}

function guardEmailPhi({ subject, text }) {
  const subj = scanPhi(subject);
  if (!subj.ok) return { skipped: true, reason: `PHI detected in subject (${subj.type}); email not sent` };
  const body = scanPhi(text);
  if (!body.ok) return { skipped: true, reason: `PHI detected in body (${body.type}); email not sent` };
  return null;
}

// Twilio SMS/voice. Form-encoded per Twilio's API. Voice uses a TwiML message.
export async function sendTwilio({ accountSid, authToken, from, to, body, voice = false }) {
  if (!accountSid || !authToken) return { skipped: true, reason: 'twilio not configured' };
  const path = `/2010-04-01/Accounts/${accountSid}/${voice ? 'Calls' : 'Messages'}.json`;
  const form = new URLSearchParams(voice
    ? { From: from, To: to, Twiml: `<Response><Say>${body}</Say></Response>` }
    : { From: from, To: to, Body: body });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.twilio.com', port: 443, path, method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(form.toString()),
        authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      },
      rejectUnauthorized: true, timeout: 5000,
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, body: String(e.message ?? e) }));
    req.end(form.toString());
  });
}

// SendGrid email.
export async function sendSendGrid({ apiKey, from, to, subject, text }) {
  if (!apiKey) return { skipped: true, reason: 'sendgrid not configured' };
  const phi = guardEmailPhi({ subject, text });
  if (phi) return phi;
  return postJson('https://api.sendgrid.com/v3/mail/send', {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from }, subject, content: [{ type: 'text/plain', value: text }],
  }, { authorization: `Bearer ${apiKey}` });
}

// AWS SES (v2) email. Spec §6 says SES *or* SendGrid; this gives customers the
// choice. When SES is configured it is tried first; otherwise SendGrid is the
// fallback. Credentials are scoped to SES only — no broader AWS access.
export async function sendSes({ accessKeyId, secretAccessKey, region, from, to, subject, text }) {
  if (!accessKeyId || !secretAccessKey || !region) return { skipped: true, reason: 'ses not configured' };
  const phi = guardEmailPhi({ subject, text });
  if (phi) return phi;
  try {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const client = new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } });
    const res = await client.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
    }));
    return { status: 200, body: { messageId: res.MessageId } };
  } catch (e) {
    return { status: 0, body: String(e.message ?? e) };
  }
}

// Slack/Teams incoming webhook — one JSON POST, both platforms accept it.
export async function sendWebhook({ webhookUrl, text }) {
  if (!webhookUrl) return { skipped: true, reason: 'webhook not configured' };
  return postJson(webhookUrl, { text });
}

// deliver — the single entry point the alerting engine calls. Routes a
// contact to the right channel by contact.channel and returns the result.
// Delivery failures are returned (not thrown) so escalation continues.
// Email tries SES first (if configured), then SendGrid, matching the spec's
// "SES or SendGrid" stance.
export async function deliver(contact, alert, cfg = {}) {
  const text = `[${alert.severity}] ${alert.impact}${alert.runbook ? ` — runbook: ${alert.runbook}` : ''}${alert.escalated ? ' (ESCALATED)' : ''}`;
  switch (contact.channel) {
    case 'sms': return sendTwilio({ ...cfg.twilio, to: contact.address, body: text });
    case 'voice': return sendTwilio({ ...cfg.twilio, to: contact.address, body: text, voice: true });
    case 'email': {
      const ses = await sendSes({ ...cfg.ses, to: contact.address, subject: text, text });
      if (!ses.skipped) return ses;
      return sendSendGrid({ ...cfg.sendgrid, to: contact.address, subject: text, text });
    }
    case 'slack':
    case 'teams': return sendWebhook({ webhookUrl: cfg.webhook?.[contact.channel] ?? cfg.webhook?.url, text });
    default: return { skipped: true, reason: `unknown channel ${contact.channel}` };
  }
}
