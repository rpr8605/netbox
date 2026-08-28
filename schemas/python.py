# schemas/python.py — GENERATED, do not edit by hand.
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
