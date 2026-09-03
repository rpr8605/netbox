#!/usr/bin/env node
/**
 * scripts/gen_schema.js
 * Responsibility: render TS + Python types for the Netbox canonical event.
 * How invoked: `node scripts/gen_schema.js` (also pre-build hook).
 * Outputs: schemas/typescript.ts (TS, enums as literal unions where practical),
 *          schemas/python.py (TypedDict literals).
 */
const { createRequire } = await import('node:module');
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const schema = JSON.parse(fs.readFileSync('schemas/netbox_event.schema.json', 'utf8'));

// ---------- TypeScript ----------
let ts = `/* eslint-disable */
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
`;
fs.writeFileSync('schemas/typescript.ts', ts);

// ---------- Python ----------
const py = `# schemas/python.py — GENERATED, do not edit by hand.
# Twin: schemas/typescript.ts + scripts/gen_schema.js.
from __future__ import annotations
from typing import Literal, TypedDict, Optional


class HL7Metadata(TypedDict, total=False):
    """HL7v2 metadata only when kind == 'hl7_metadata'."""
    message_type: Optional[str]
    direction: Optional[Literal["inbound", "outbound"]]
    ack_status: Optional[Literal["ACK", "NACK", "timeout"]]
    correlation_token: Optional[str]


class NetboxEvent(TypedDict, total=False):
    event_id: str
    device_id: str
    site_id: str
    occurred_at: str  # ISO 8601 date-time, UTC
    kind: Literal["check_result", "hl7_metadata", "heartbeat", "update_event"]
    service: Literal[
        "ehr", "adt", "lab", "pharmacy", "imaging",
        "eprescribe", "internet", "phone", "printing", "custom"
    ]
    tier_observed: Literal["L0", "L1", "L2", "L3", "L4"]
    status: Literal["reachable", "verified_ready", "active", "degraded", "down", "unknown"]
    latency_ms: int
    confidence: Literal["high", "medium", "low"]
    freshness_s: int
    phi_mode: bool
    hl7_metadata: HL7Metadata
`;
fs.writeFileSync('schemas/python.py', py);
console.log('schemas/typescript.ts + schemas/python.py written');
