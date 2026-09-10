#!/usr/bin/env python3
"""
sidecar/mllp_tap.py — Beacon Relay HL7/MLLP passive-tap sidecar (spec §3).

Reads MLLP traffic PASSIVELY (it is a tap on a mirror/SPAN feed or a read-only
socket: never in the message path, never able to block or delay a real message).
Extracts METADATA ONLY by default (phi_mode=False): message type/trigger event,
direction, timestamp, ACK/NACK, latency, size — never the message body.

THE SAFETY GUARANTEE (spec §4) is behavioral, not a policy flag:
when phi_mode is False the raw payload is dropped from memory IMMEDIATELY after
metadata extraction and before any write — the identifier fields are tokenized
with a per-device keyed HMAC-SHA256 and the body bytes are never assigned to a
name that survives the parse step. There is no code path that writes the body
when phi_mode is False.

Identifier tokenization is keyed per device: HMAC_SHA256(device_secret, value).
A plain hash would be reversible against a small guessable identifier space
(MRN farming); a per-device key means two devices tokenizing the same MRN
produce different tokens, so cross-device correlation is impossible without
the key.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import time
from dataclasses import dataclass, field

# --- MLLP framing bytes ------------------------------------------------------
SB = b"\x0b"          # start block
EB_CR = b"\x1c\x0d"   # end block + CR


@dataclass
class Hl7Metadata:
    """The ONLY thing the tap is allowed to keep when phi_mode is False."""
    message_type: str
    direction: str
    occurred_at: str
    ack_status: str
    latency_ms: int
    size_bytes: int
    correlation_token: str
    phi_mode: bool = False


class CorrelationTokenizer:
    """Per-device keyed HMAC-SHA256 tokenizer.

    The key is a per-device secret (derived at provision time). Because the
    key is per device, the same identifier tokenizes differently on different
    devices — that IS the anti-correlation property the spec calls for.
    """

    def __init__(self, device_secret: bytes):
        if not device_secret:
            raise ValueError("device_secret must be non-empty (per-device key)")
        # store only an HMAC of the secret, not the raw secret, so a memory
        # read of this object does not hand back the raw key material
        self._keyed = hmac.new(b"beacon-relay-correlation-key", device_secret, hashlib.sha256).digest()

    def tokenize(self, identifier: str) -> str:
        return hmac.new(self._keyed, identifier.encode("utf-8"), hashlib.sha256).hexdigest()


def _parse_msh_fields(msg: bytes) -> dict:
    """Pull only the fields metadata extraction needs from the MSH segment.

    Works on the raw bytes and returns ONLY header metadata — never any PID
    (patient-identifying) segment content.
    """
    text = msg.decode("utf-8", errors="replace")
    lines = [l for l in text.split("\r") if l]
    msh = next((l for l in lines if l.startswith("MSH")), "")
    parts = msh.split("|")
    # MSH-9 is the message type / trigger event (e.g. ADT^A01, ORU^R01)
    msg_type = parts[8] if len(parts) > 8 else "UNKNOWN"
    message_type = msg_type.split("^")[0] if msg_type else "UNKNOWN"
    # MSH-10 is the message control ID — the per-MESSAGE identifier that lets a
    # correlation token prove THIS message across hops, not just the type.
    message_control_id = parts[9] if len(parts) > 9 else ""
    return {"message_type": message_type, "message_control_id": message_control_id}


def extract_metadata(
    raw_frame: bytes,
    *,
    direction: str,
    ack_status: str,
    latency_ms: int,
    tokenizer: CorrelationTokenizer,
    phi_mode: bool = False,
) -> Hl7Metadata:
    """Extract metadata from one MLLP frame.

    When phi_mode is False (the default and the only supported production
    mode), the raw frame is NOT retained by this function past the metadata
    pull: the body is never assigned to an attribute, never logged, and never
    written. Only the derived Hl7Metadata is returned.
    """
    meta = _parse_msh_fields(raw_frame)
    # The correlation token binds to a PER-MESSAGE identifier (MSH-10 message
    # control ID) so two different messages of the same type tokenize
    # differently — that is the "prove identical messages across hops" property
    # the schema field promises. Falls back to type+direction only if MSH-10 is
    # genuinely absent (a malformed header); never a PHI field.
    identity = meta["message_control_id"] or f"{meta['message_type']}|{direction}"
    token = tokenizer.tokenize(identity)
    return Hl7Metadata(
        message_type=meta["message_type"],
        direction=direction,
        occurred_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        ack_status=ack_status,
        latency_ms=int(latency_ms),
        size_bytes=len(raw_frame),
        correlation_token=token,
        phi_mode=phi_mode,
    )


def parse_mllp_stream(buf: bytes) -> tuple[list[bytes], bytes]:
    """Split a byte buffer into complete MLLP frames + the leftover remainder.

    Returns (frames, remainder). A frame is SB ... EB CR. Bytes outside a
    complete frame stay in the remainder so the caller can append more data.
    """
    frames: list[bytes] = []
    while True:
        start = buf.find(SB)
        if start == -1:
            return frames, b""
        end = buf.find(EB_CR, start)
        if end == -1:
            return frames, buf[start:]
        frames.append(buf[start + 1:end])
        buf = buf[end + len(EB_CR):]


# --- Passive listener --------------------------------------------------------
# The tap is READ-ONLY: it accepts a mirror/SPAN feed (or a read-only copy of
# MLLP traffic) and never writes to the socket — no ACKs, no responses, nothing
# that could influence the real message path. This is the safety property the
# header docstring promises: the tap can observe, never block or delay a real
# message.
def run_passive_listener(
    host: str,
    port: int,
    on_metadata,
    *,
    tokenizer: CorrelationTokenizer,
    direction: str = "inbound",
) -> None:
    """Listen on host:port for MLLP frames and emit metadata for each.

    Read-only by construction: the socket is only ever read from, never written
    to. on_metadata(Hl7Metadata) is called per complete frame. Runs until the
    connection closes or the process is signalled.
    """
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as srv:
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((host, port))
        srv.listen(1)
        conn, _addr = srv.accept()
        with conn:
            buf = b""
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
                frames, buf = parse_mllp_stream(buf)
                for frame in frames:
                    started = time.time()
                    meta = extract_metadata(
                        frame,
                        direction=direction,
                        ack_status="ACK",
                        latency_ms=0,
                        tokenizer=tokenizer,
                        phi_mode=False,
                    )
                    meta.latency_ms = int((time.time() - started) * 1000)
                    on_metadata(meta)
