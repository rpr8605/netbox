#!/usr/bin/env node
/**
 * scripts/gen_schema.js
 * Responsibility: render TS + Python types for the Beacon Relay canonical event.
 * How invoked: `node scripts/gen_schema.js` (also pre-build hook).
 * Outputs: schemas/typescript.ts (TS, enums as literal unions where practical),
 *          schemas/python.py (TypedDict literals).
 */
const { createRequire } = await import('node:module');
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const schema = JSON.parse(fs.readFileSync('schemas/beacon_relay_event.schema.json', 'utf8'));

// ---------- TypeScript ----------
let ts = `/* eslint-disable */
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


class SecuritySignalPayload(TypedDict, total=False):
    signal: Literal["unusual", "advisory", "verified_unusual"]
    severity: Optional[Literal["info", "warn", "critical"]]
    source: str
    basis: str
    observed: Optional[dict]


class BeaconRelayEvent(TypedDict, total=False):
    event_id: str
    device_id: str
    site_id: str
    occurred_at: str  # ISO 8601 date-time, UTC
    kind: Literal["check_result", "hl7_metadata", "heartbeat", "update_event", "security_signal"]
    service: Literal[
        "ehr", "adt", "lab", "pharmacy", "imaging",
        "eprescribe", "internet", "phone", "printing", "custom"
    ]
    tier_observed: Optional[Literal["L0", "L1", "L2", "L3", "L4"]]
    status: Optional[Literal["reachable", "verified_ready", "active", "degraded", "down", "unknown"]]
    signal: Optional[Literal["unusual", "advisory", "verified_unusual"]]
    severity: Optional[Literal["info", "warn", "critical"]]
    latency_ms: int
    confidence: Literal["high", "medium", "low"]
    freshness_s: int
    channel_id: Optional[str]
    phi_mode: bool
    hl7_metadata: HL7Metadata
    security_signal_payload: SecuritySignalPayload
`;
fs.writeFileSync('schemas/python.py', py);
console.log('schemas/typescript.ts + schemas/python.py written');
