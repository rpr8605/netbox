/* eslint-disable */
// schemas/typescript.ts — GENERATED, do not edit by hand.
// Twin: schemas/python.py + scripts/gen_schema.js.

export type BeaconRelayEvent = {
  /** v4 */
  event_id: string;
  device_id: string;
  site_id: string;
  /** ISO 8601 date-time */
  occurred_at: string;
  kind: 'check_result' | 'hl7_metadata' | 'heartbeat' | 'update_event' | 'security_signal';
  service: 'ehr' | 'adt' | 'lab' | 'pharmacy' | 'imaging' |
  'eprescribe' | 'internet' | 'phone' | 'printing' | 'custom';
  tier_observed?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  status?: 'reachable' | 'verified_ready' | 'active' | 'degraded' | 'down' | 'unknown';
  signal?: 'unusual' | 'advisory' | 'verified_unusual';
  severity?: 'info' | 'warn' | 'critical';
  latency_ms: number;
  confidence: 'high' | 'medium' | 'low';
  freshness_s: number;
  /** Optional interface-engine channel tag (topology); never PHI. */
  channel_id?: string;
  phi_mode: boolean;
  /** HL7v2 metadata only when kind == 'hl7_metadata' */
  hl7_metadata?: HL7Metadata;
  /** security_signal payload only when kind == 'security_signal' */
  security_signal_payload?: SecuritySignalPayload;
};

export interface SecuritySignalPayload {
  signal: 'unusual' | 'advisory' | 'verified_unusual';
  severity?: 'info' | 'warn' | 'critical';
  source: string;
  basis: string;
  observed?: Record<string, unknown>;
}

export interface HL7Metadata {
  /** e.g. ADT, ORU, ORM — raw payload never held */
  message_type?: string;
  direction?: 'inbound' | 'outbound';
  ack_status?: 'ACK' | 'NACK' | 'timeout';
  /** per-device HMAC-SHA256, irreversible */
  correlation_token?: string;
}
