// netbox-agent/lib/signal_emit.js — emit SECURITY_SIGNAL events (Step 1).
// Single, shared helper so every signal source (Graph audit / sign-in,
// backup-proxy, backup-API) produces the same canonical shape; the
// non-status-shape is enforced here — a `status` field is *removed* before
// emit and its kind code path rejects undefined payload on the control plane.
// Structurally guarantees the schema change is never "bypassed" by agent code.
import crypto from 'node:crypto';
import { postEvent } from './post_event.js';

// The ONLY constructor/transport for security_signal events — every signal
// source funnels through here so the canonical shape can't drift per-source
// (see header). The `signal` enum guard fails fast ON THE DEVICE rather than
// letting a bad value travel upstream and die as a silent ingest rejection.
// phi_mode is hardcoded false: signal payloads are metadata-only by design
// (spec §10, metadata-only-by-default), and no caller parameter may flip that.
export async function emitSecuritySignal({ deviceId, siteId, service = 'custom', source,
                                           severity = 'info', observed = {}, basis,
                                           signal = 'advisory', confidence = 'high',
                                           latencyMs = 0, post = postEvent }) {
  if (!['unusual', 'advisory', 'verified_unusual'].includes(signal)) {
    throw new Error(`invalid signal enum: ${signal}`);
  }
  const ev = {
    event_id: crypto.randomUUID(),
    device_id: deviceId,
    site_id: siteId,
    occurred_at: new Date().toISOString(),
    kind: 'security_signal',
    service,
    signal,
    severity,
    latency_ms: latencyMs,
    confidence,
    freshness_s: 0,
    phi_mode: false,
    security_signal_payload: { signal, source, basis, observed, severity },
  };
  return post(ev);
}
