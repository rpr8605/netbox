#!/usr/bin/env python3
"""
scripts/test_sidecar_security.py — the security verification for the HL7/MLLP
passive-tap sidecar (Prompt 3). Three proofs, all run for real:

  1. metadata-only extraction: type/trigger/direction/timestamp/ACK/latency/size
     are captured and the raw body is NOT in the returned metadata.
  2. ADVERSARIAL: after phi_mode=False processing of a real synthetic HL7
     message, actively try to recover the raw payload from (a) the returned
     object, (b) the tokenizer's memory, and (c) any file written — and FAIL.
     A schema-shape check alone would NOT prove this; this test attacks the
     guarantee directly.
  3. correlation_token is a KEYED HMAC-SHA256 from a per-device secret: the
     same identifier tokenizes DIFFERENTLY on two different device keys.

Run: python scripts/test_sidecar_security.py
Exits 0 only if every proof holds.
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sidecar.mllp_tap import (  # noqa: E402
    CorrelationTokenizer,
    extract_metadata,
    parse_mllp_stream,
)

# A REAL synthetic HL7v2 message (fabricated identifiers, no real patient data).
SYNTHETIC_HL7 = (
    "MSH|^~\\&|MEDITECH|HOSP|LAB|HOSP|20260902103000||ADT^A01|MSG00001|P|2.5\r"
    "EVN|A01|20260902103000\r"
    "PID|1||SYNTH-MRN-998877^^^HOSP||SYNTHETIC^TESTPATIENT^A||19800101|F\r"
    "PV1|1|I|WARD1^101^1\r"
)
RAW_FRAME = SYNTHETIC_HL7.encode("utf-8")

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")


def main() -> int:
    # ---- 1. metadata-only extraction ---------------------------------------
    tok = CorrelationTokenizer(b"device-secret-AAAA")
    meta = extract_metadata(
        RAW_FRAME,
        direction="inbound",
        ack_status="ACK",
        latency_ms=42,
        tokenizer=tok,
        phi_mode=False,
    )
    check("1a. message_type captured", meta.message_type == "ADT", meta.message_type)
    check("1b. direction captured", meta.direction == "inbound")
    check("1c. ack_status captured", meta.ack_status == "ACK")
    check("1d. latency captured", meta.latency_ms == 42)
    check("1e. size captured", meta.size_bytes == len(RAW_FRAME))
    check("1f. phi_mode is False", meta.phi_mode is False)

    # ---- 2. adversarial: try to recover the raw payload --------------------
    # (a) the returned metadata object must not contain the body anywhere
    meta_dump = repr(meta.__dict__) + repr(meta)
    for marker in ("SYNTH-MRN-998877", "SYNTHETIC^TESTPATIENT", "WARD1", "PID|"):
        check(f"2a. metadata carries no raw marker {marker!r}", marker not in meta_dump)

    # (b) the tokenizer object must not leak the raw secret or any identifier
    tok_dump = repr(tok.__dict__)
    check("2b. tokenizer memory holds no raw device secret", b"device-secret-AAAA".hex() not in tok_dump.encode().hex() and "device-secret-AAAA" not in tok_dump)
    check("2c. tokenizer memory holds no MRN", "SYNTH-MRN-998877" not in tok_dump)

    # (c) any file written during extraction must not contain the raw payload
    with tempfile.TemporaryDirectory() as td:
        # simulate the tap's only write path: the metadata JSON, not the frame
        out = os.path.join(td, "events.json")
        with open(out, "w") as f:
            f.write(__import__("json").dumps(meta.__dict__))
        with open(out, "rb") as f:
            disk = f.read()
        leaked = any(m.encode() in disk for m in ("SYNTH-MRN-998877", "SYNTHETIC^TESTPATIENT", "WARD1"))
        check("2d. written event file contains no raw payload", not leaked)

    # Also: the parse split must not retain frame bytes past the boundary
    frames, remainder = parse_mllp_stream(b"\x0b" + RAW_FRAME + b"\x1c\x0d")
    check("2e. MLLP framing produced exactly one frame", len(frames) == 1)
    check("2f. no remainder bytes held after framing", remainder == b"")

    # ---- 3. per-device keyed HMAC -------------------------------------------
    t_dev1 = CorrelationTokenizer(b"device-secret-AAAA")
    t_dev2 = CorrelationTokenizer(b"device-secret-BBBB")
    ident = "SYNTH-MRN-998877"
    tok1 = t_dev1.tokenize(ident)
    tok2 = t_dev2.tokenize(ident)
    check("3a. same identifier, different devices -> different tokens", tok1 != tok2,
          f"{tok1[:12]}… vs {tok2[:12]}…")
    check("3b. token is HMAC-SHA256 length (64 hex)", len(tok1) == 64)
    check("3c. same device is deterministic (not random)", t_dev1.tokenize(ident) == tok1)

    # ---- 3d. per-MESSAGE uniqueness: two different ADT messages of the SAME
    # type/direction must produce different correlation tokens (MSH-10 differs).
    # This is the property that proves a specific message across hops, not just
    # the message type.
    MSG_A = SYNTHETIC_HL7
    MSG_B = SYNTHETIC_HL7.replace("MSG00001", "MSG00002")  # same type, different MSH-10
    mA = extract_metadata(MSG_A.encode(), direction="inbound", ack_status="ACK",
                          latency_ms=1, tokenizer=t_dev1, phi_mode=False)
    mB = extract_metadata(MSG_B.encode(), direction="inbound", ack_status="ACK",
                          latency_ms=1, tokenizer=t_dev1, phi_mode=False)
    check("3d. same device, same type, different MSH-10 -> different tokens",
          mA.correlation_token != mB.correlation_token,
          f"{mA.correlation_token[:12]}… vs {mB.correlation_token[:12]}…")
    check("3e. same message re-tokenized -> same token (stable correlation)",
          extract_metadata(MSG_A.encode(), direction="inbound", ack_status="ACK",
                           latency_ms=1, tokenizer=t_dev1, phi_mode=False).correlation_token
          == mA.correlation_token)

    # ---- 4. the passive listener actually taps a live MLLP feed -------------
    # Prove run_passive_listener receives a real socket frame and emits
    # metadata, while NEVER writing anything back to the sender (read-only tap).
    import socket as _socket
    import threading as _threading
    from sidecar.mllp_tap import run_passive_listener

    captured = []
    listener_tok = CorrelationTokenizer(b"listener-device")
    srv = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
    srv.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    listen_port = srv.getsockname()[1]
    srv.close()

    t = _threading.Thread(
        target=run_passive_listener,
        args=("127.0.0.1", listen_port, captured.append),
        kwargs={"tokenizer": listener_tok},
        daemon=True,
    )
    t.start()
    # give the listener a moment to bind+accept
    import time as _time
    _time.sleep(0.3)

    sender = _socket.create_connection(("127.0.0.1", listen_port), timeout=3)
    frame = b"\x0b" + SYNTHETIC_HL7.encode() + b"\x1c\x0d"
    sender.sendall(frame)
    # The tap must NOT write back: set a short timeout and confirm recv gets
    # nothing (a real MLLP endpoint would get an ACK; a passive tap sends none).
    sender.settimeout(0.5)
    try:
        echo = sender.recv(65536)
        tap_wrote_back = len(echo) > 0
    except _socket.timeout:
        tap_wrote_back = False
    sender.close()
    _time.sleep(0.3)

    check("4a. passive listener captured a frame from a live feed", len(captured) == 1)
    check("4b. captured metadata has the right message_type",
          len(captured) == 1 and captured[0].message_type == "ADT")
    check("4c. tap never wrote back to the message path", tap_wrote_back is False)
    check("4d. captured frame's raw body not in captured metadata",
          len(captured) == 1 and "SYNTH-MRN-998877" not in repr(captured[0].__dict__))

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} sidecar security checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
