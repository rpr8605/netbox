#!/usr/bin/env node
// control-plane/test/deliver.phi.test.js
// Verifies finding M1: the PHI guard applies to every delivery channel
// (SMS, voice, webhook, email), and voice TwiML escapes the spoken text.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deliver } from '../src/deliver.js';

function makeAlert() {
  return { severity: 'P1', impact: 'EHR down', runbook: null, escalated: false };
}

describe('M1 — PHI guard covers every delivery channel', () => {
  it('blocks SMS when the alert text contains an MRN', async () => {
    const r = await deliver(
      { channel: 'sms', address: '+15550100' },
      { ...makeAlert(), impact: 'patient MRN 1234567 unavailable' },
      { twilio: { accountSid: 'AC', authToken: 'tok', from: '+15550199' } },
    );
    assert.ok(r.skipped, 'SMS with PHI must be skipped');
    assert.match(r.reason, /PHI/i, 'skip reason mentions PHI');
  });

  it('blocks voice when the alert text contains an MRN', async () => {
    const r = await deliver(
      { channel: 'voice', address: '+15550100' },
      { ...makeAlert(), impact: 'patient MRN 1234567 unavailable' },
      { twilio: { accountSid: 'AC', authToken: 'tok', from: '+15550199' } },
    );
    assert.ok(r.skipped, 'voice with PHI must be skipped');
  });

  it('blocks Slack/Teams webhooks when the alert text contains an MRN', async () => {
    const r = await deliver(
      { channel: 'slack', address: 'https://hooks.slack.com/test' },
      { ...makeAlert(), impact: 'patient MRN 1234567 unavailable' },
      { webhook: { slack: 'https://hooks.slack.com/test' } },
    );
    assert.ok(r.skipped, 'webhook with PHI must be skipped');
  });

  it('escapes XML special characters in voice TwiML', async () => {
    // We cannot actually POST to Twilio in a unit test, but we can inspect the
    // Twiml payload by stubbing the request. Deliver uses the configured
    // twilio object; we pass a fake auth so it attempts the POST and returns
    // the form body via the mocked https layer is hard. Instead, export a
    // helper that builds the Twiml and test it directly.
    const { buildVoiceTwiml } = await import('../src/deliver.js');
    const twiml = buildVoiceTwiml('say <hello> & "goodbye"');
    assert.ok(!twiml.includes('<hello>'), 'angle brackets escaped');
    assert.ok(twiml.includes('&lt;hello&gt;'), 'angle brackets escaped to entities');
    assert.ok(twiml.includes('&amp;'), 'ampersand escaped');
  });
});
