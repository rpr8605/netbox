/* eslint-disable */
// schemas/typescript.ts — GENERATED, do not edit by hand.
// Twin: schemas/python.py + scripts/gen_schema.js.

export type NetboxEvent = {
  /** v4 */
  event_id: string;
  device_id: string;
  site_id: string;
  /** ISO 8601 date-time */
  occurred_at: string;
  kind: 'check_result' | 'hl7_metadata' | 'heartbeat' | 'update_event';
  service: 'ehr' | 'adt' | 'lab' | 'pharmacy' | 'imaging' |
  'eprescribe' | 'internet' | 'phone' | 'printing' | 'custom';
  tier_observed: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  status: 'reachable' | 'verified_ready' | 'active' | 'degraded' | 'down' | 'unknown';
  latency_ms: number;
  confidence: 'high' | 'medium' | 'low';
  freshness_s: number;
  phi_mode: boolean;
  /** HL7v2 metadata only when kind == 'hl7_metadata' */
  hl7_metadata?: HL7Metadata;
};

export interface HL7Metadata {
  /** e.g. ADT, ORU, ORM — raw payload never held */
  message_type?: string;
  direction?: 'inbound' | 'outbound';
  ack_status?: 'ACK' | 'NACK' | 'timeout';
  /** per-device HMAC-SHA256, irreversible */
  correlation_token?: string;
}
