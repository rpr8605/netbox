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

NETWORK BOUNDARY (what "passive tap" does NOT do): this code never sets up or
verifies the feed that delivers traffic to it. A switch mirror/SPAN session —
or an equivalent capture forwarder connecting to this port — must exist on the
hospital network BEFORE anything arrives here. "The tap is read-only" means it
cannot affect the message path; it does NOT mean it is already receiving
traffic. That boundary is operational (site network engineering), not code.

ACK SEMANTICS, MEASURED NOT ASSUMED: on a feed that carries both directions,
each response frame is correlated to its request by MSA-2 == the request's
MSH-10 control ID. ack_status is only ever a measured value:
  "ACK"/"NACK" — the matching response frame was actually observed;
  "TIMEOUT"    — no response observed within ack_timeout of the request;
  "UNKNOWN"    — the feed ended (or the frame had no MSH-10) before any answer
                 could be observed.
On a topology where the return path is not mirrored, expect UNKNOWN/TIMEOUT —
never a fabricated ACK.
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


def _parse_msa_fields(msg: bytes) -> dict:
    """Classify a frame as request/response and pull ACK correlation fields.

    A frame carrying an MSA segment is a RESPONSE (HL7 ACK messages always
    carry MSA); anything else is a request. MSA-1 is the acknowledgment code —
    AA/CA -> "ACK", AE/AR/CE/CR -> "NACK" — and MSA-2 echoes the MSH-10 of the
    message being answered, which is the correlation key back to the held
    request. Header segments only; no PID content is read here either.
    """
    text = msg.decode("utf-8", errors="replace")
    lines = [l for l in text.split("\r") if l]
    msa = next((l for l in lines if l.startswith("MSA")), "")
    if not msa:
        return {"is_response": False, "ack_code": None, "original_control_id": ""}
    # MSA alone does NOT make a frame an acknowledgment: data-bearing messages
    # (e.g. RSP query responses) legitimately carry MSA too. Only MSH-9 == ACK
    # is a pure acknowledgment; anything else is a request in its own right
    # (it expects its own ACK downstream and gets its own record).
    msh = next((l for l in lines if l.startswith("MSH")), "")
    msh_parts = msh.split("|")
    msh_type = (msh_parts[8] if len(msh_parts) > 8 else "").split("^")[0]
    if msh_type != "ACK":
        return {"is_response": False, "ack_code": None, "original_control_id": ""}
    parts = msa.split("|")
    raw_code = parts[1] if len(parts) > 1 else ""
    ack_code = (
        "ACK" if raw_code in ("AA", "CA")
        else "NACK" if raw_code in ("AE", "AR", "CE", "CR")
        else None  # unrecognized code: emit UNKNOWN rather than guess
    )
    original_control_id = parts[2] if len(parts) > 2 else ""
    return {"is_response": True, "ack_code": ack_code, "original_control_id": original_control_id}


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


class PendingMessages:
    """Request frames observed on the feed, held until their answer arrives.

    Stores ONLY Hl7Metadata objects (the one thing the tap is allowed to keep)
    plus the monotonic observation time — never raw frames, so holding a
    message for correlation does not extend the lifetime of any PHI bytes.
    Keyed by MSH-10 control ID (the same per-message identifier the
    correlation token binds to). Bounded two ways so a one-way mirror (return
    path not visible) cannot grow memory without limit: a per-entry TTL
    (ack_timeout) and a hard cap (max_pending, oldest evicted).
    """

    def __init__(self, ack_timeout: float = 60.0, max_pending: int = 10_000):
        self.ack_timeout = ack_timeout
        self.max_pending = max_pending
        # insertion-ordered dict: control_id -> (metadata, t_observed_monotonic)
        self._pending: dict[str, tuple[Hl7Metadata, float]] = {}

    def add(self, control_id: str, t_observed: float, meta: Hl7Metadata) -> list[tuple[Hl7Metadata, float]]:
        """Insert an entry; return any displaced/evicted ones for the caller to
        emit as UNKNOWN. A request that leaves the table without an answer must
        still produce a record — silent loss is exactly the failure mode this
        bug fix exists to remove."""
        displaced: list[tuple[Hl7Metadata, float]] = []
        old = self._pending.pop(control_id, None)
        if old is not None:
            # A reused control ID displaces the older request; senders are
            # expected to make MSH-10 unique, but the displaced entry is
            # returned (and recorded), not dropped silently.
            displaced.append(old)
        self._pending[control_id] = (meta, t_observed)
        while len(self._pending) > self.max_pending:
            displaced.append(self._pending.pop(next(iter(self._pending))))  # oldest (FIFO)
        return displaced

    def pop_match(self, control_id: str):
        """Remove and return (meta, t_observed) for control_id, or None."""
        return self._pending.pop(control_id, None)

    def expire(self, now: float) -> list[tuple[Hl7Metadata, float]]:
        """Remove and return all entries older than ack_timeout."""
        expired = [(cid, v) for cid, v in self._pending.items()
                   if now - v[1] >= self.ack_timeout]
        for cid, _ in expired:
            del self._pending[cid]
        return [v for _, v in expired]

    def flush(self) -> list[tuple[Hl7Metadata, float]]:
        """Remove and return every remaining entry (feed ended)."""
        remaining = list(self._pending.values())
        self._pending.clear()
        return remaining


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
    ack_timeout: float = 60.0,
    max_pending: int = 10_000,
    stop_event=None,
) -> None:
    """Listen on host:port for MLLP frames and emit metadata per REQUEST frame.

    Read-only by construction: the socket is only ever read from, never written
    to. Runs indefinitely — a dropped feed connection is accepted again, never
    fatal (a 24/7 monitor must not need a manual restart after a switch
    hiccup). stop_event (threading.Event, optional) lets tests shut it down
    deterministically.

    Emission model (see header "ACK SEMANTICS"): request frames are HELD in a
    PendingMessages table and emitted exactly once — with the real measured
    outcome (ACK/NACK + wire latency) when the response frame arrives, as
    TIMEOUT when ack_timeout elapses unanswered, or as UNKNOWN when the feed
    ends first. Response frames themselves never emit records.
    """
    import socket

    pending = PendingMessages(ack_timeout=ack_timeout, max_pending=max_pending)

    def _emit_timed(meta: Hl7Metadata, t_observed: float, status: str, now: float) -> None:
        # latency is measured from when the request was OBSERVED on the wire to
        # when its answer (or the give-up point) was observed — never the parse
        # time of the Python code, which was the old always-~0ms bug.
        meta.ack_status = status
        meta.latency_ms = int((now - t_observed) * 1000)
        try:
            on_metadata(meta)
        except Exception as e:  # a failing consumer must never kill a 24/7 tap
            print(f"mllp_tap: on_metadata callback raised (record dropped): {e}", file=sys.stderr)

    def _sweep_expired() -> None:
        now = time.monotonic()
        for meta, t_obs in pending.expire(now):
            _emit_timed(meta, t_obs, "TIMEOUT", now)

    def _flush_remaining() -> None:
        now = time.monotonic()
        for meta, t_obs in pending.flush():
            _emit_timed(meta, t_obs, "UNKNOWN", now)

    def _stopped() -> bool:
        return stop_event is not None and stop_event.is_set()

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as srv:
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((host, port))
        srv.listen(1)
        srv.settimeout(1.0)  # wake periodically so stop_event is honored pre-connection
        while not _stopped():
            try:
                conn, _addr = srv.accept()
            except socket.timeout:
                continue
            with conn:
                conn.settimeout(1.0)  # sweep for expired requests on a quiet feed
                buf = b""
                while not _stopped():
                    try:
                        chunk = conn.recv(65536)
                    except socket.timeout:
                        _sweep_expired()
                        continue
                    if not chunk:
                        break  # peer closed the feed connection
                    buf += chunk
                    # Unbounded-garbage guard: a misconfigured feed streaming
                    # non-MLLP bytes would otherwise grow buf forever. 1 MiB is
                    # far past any legitimate HL7 frame.
                    if len(buf) > 1_000_000:
                        buf = b""
                    frames, buf = parse_mllp_stream(buf)
                    for frame in frames:
                        observed = time.monotonic()
                        try:
                            resp = _parse_msa_fields(frame)
                            if resp["is_response"]:
                                match = pending.pop_match(resp["original_control_id"])
                                if match is not None:
                                    meta, t_obs = match
                                    _emit_timed(meta, t_obs, resp["ack_code"] or "UNKNOWN", observed)
                                # Unmatched responses emit nothing: without the
                                # request half there is no honest metadata to record.
                                continue
                            meta = extract_metadata(
                                frame,
                                direction=direction,
                                ack_status="UNKNOWN",  # placeholder; set for real at emission
                                latency_ms=0,
                                tokenizer=tokenizer,
                                phi_mode=False,
                            )
                            control_id = _parse_msh_fields(frame)["message_control_id"]
                            if control_id:
                                for old_meta, old_t in pending.add(control_id, observed, meta):
                                    _emit_timed(old_meta, old_t, "UNKNOWN", observed)
                            else:
                                # No MSH-10 -> correlation is impossible; emit now as
                                # UNKNOWN rather than hold an unmatchable entry.
                                _emit_timed(meta, observed, "UNKNOWN", observed)
                        except Exception as e:
                            # Pathological input must never kill the listener:
                            # log and move to the next frame.
                            print(f"mllp_tap: frame processing error (frame skipped): {e}", file=sys.stderr)
                # This feed connection ended: anything still pending can never
                # be answered on it — flush as UNKNOWN, then accept the next one.
                _flush_remaining()
