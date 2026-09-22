#!/usr/bin/env python3
"""
scripts/test_sidecar_correlation.py — functional tests for the MLLP tap's
ACK/NACK correlation, wire-latency measurement, and connection resilience
(audit items 3-5 in BEACON_RELAY_KIMI_AUDIT_FIXES(1).md).

Complements test_sidecar_security.py (which proves the PHI/security boundary;
this file proves the tap measures real outcomes instead of fabricating them):

  1. a request followed by a real AA frame emits ONE record: ack_status=ACK
     and latency_ms = the actual gap between the two frames on the wire.
  2. a request followed by an AE frame emits ack_status=NACK (not a hardcoded
     ACK, and the NACK record still carries no PHI markers).
  3. a request with no response within ack_timeout emits ack_status=TIMEOUT.
  4. the listener survives a dropped feed connection and keeps accepting:
     record 1 flushes as UNKNOWN on the drop, record 2 correlates normally
     on the next connection.

All frames are synthetic (fabricated identifiers, no real patient data) over
real localhost sockets. Run: python scripts/test_sidecar_correlation.py
Exits 0 only if every check holds.
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sidecar.mllp_tap import CorrelationTokenizer, run_passive_listener  # noqa: E402

SB, EB_CR = b"\x0b", b"\x1c\x0d"


def mllp(payload: str) -> bytes:
    return SB + payload.encode("utf-8") + EB_CR


def request_msg(cid: str) -> str:
    # Synthetic ADT^A01 with a fabricated MRN — same shape as the security
    # suite's fixture, never real patient data.
    return (
        f"MSH|^~\\&|SYNTH|HOSP|LAB|HOSP|20260922120000||ADT^A01|{cid}|P|2.5\r"
        "EVN|A01|20260922120000\r"
        "PID|1||SYNTH-MRN-10101^^^HOSP||SYNTHETIC^TESTPATIENT^B||19900101|M\r"
    )


def ack_msg(cid: str, code: str) -> str:
    return (
        f"MSH|^~\\&|LAB|HOSP|SYNTH|HOSP|20260922120001||ACK^A01|R-{cid}|P|2.5\r"
        f"MSA|{code}|{cid}\r"
    )


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")


def start_listener(ack_timeout: float = 60.0):
    """Start a listener thread on a free localhost port. Returns (captured, port, stop)."""
    captured: list = []
    tok = CorrelationTokenizer(b"correlation-test-device")
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    stop = threading.Event()
    t = threading.Thread(
        target=run_passive_listener,
        args=("127.0.0.1", port, captured.append),
        kwargs={"tokenizer": tok, "ack_timeout": ack_timeout, "stop_event": stop},
        daemon=True,
    )
    t.start()
    time.sleep(0.3)  # let it bind + accept
    return captured, port, stop


def wait_for(captured: list, n: int, deadline_s: float = 4.0) -> bool:
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        if len(captured) >= n:
            return True
        time.sleep(0.05)
    return False


def connect(port: int, attempts: int = 20) -> socket.socket:
    """Connect with retry: the listener thread may need a moment to bind/accept
    on a loaded box, and a bare create_connection races that."""
    for i in range(attempts):
        try:
            return socket.create_connection(("127.0.0.1", port), timeout=3)
        except (ConnectionRefusedError, OSError):
            if i == attempts - 1:
                raise
            time.sleep(0.1)


def main() -> int:
    # ---- 1. real ACK + real wire latency ------------------------------------
    captured, port, stop = start_listener()
    conn = connect(port)
    conn.sendall(mllp(request_msg("CTRL-A1")))
    time.sleep(0.15)  # the wire gap the tap should measure
    conn.sendall(mllp(ack_msg("CTRL-A1", "AA")))
    got = wait_for(captured, 1)
    check("1a. request+ACK produced exactly one record", got and len(captured) == 1)
    if got:
        rec = captured[0]
        check("1b. ack_status is the measured ACK", rec.ack_status == "ACK", rec.ack_status)
        check("1c. latency_ms is the real ~150ms wire gap, not parse time",
              140 <= rec.latency_ms <= 1000, f"{rec.latency_ms}ms")
        check("1d. message_type still correct", rec.message_type == "ADT", rec.message_type)
    conn.close()
    stop.set()

    # ---- 2. real NACK (and PHI still absent on the NACK path) ---------------
    captured, port, stop = start_listener()
    conn = connect(port)
    conn.sendall(mllp(request_msg("CTRL-N2")))
    time.sleep(0.05)
    conn.sendall(mllp(ack_msg("CTRL-N2", "AE")))
    got = wait_for(captured, 1)
    check("2a. request+NACK produced exactly one record", got and len(captured) == 1)
    if got:
        rec = captured[0]
        check("2b. ack_status is the measured NACK", rec.ack_status == "NACK", rec.ack_status)
        dump = repr(rec.__dict__)
        check("2c. NACK record carries no PHI markers",
              all(m not in dump for m in ("SYNTH-MRN-10101", "SYNTHETIC^TESTPATIENT", "PID|")))
    conn.close()
    stop.set()

    # ---- 3. no response within ack_timeout -> TIMEOUT ------------------------
    captured, port, stop = start_listener(ack_timeout=0.5)
    conn = connect(port)
    conn.sendall(mllp(request_msg("CTRL-T3")))
    got = wait_for(captured, 1, deadline_s=5.0)  # keep the feed OPEN: closing would flush UNKNOWN
    check("3a. unanswered request eventually emits one record", got and len(captured) == 1)
    if got:
        rec = captured[0]
        check("3b. ack_status is TIMEOUT, not a fabricated ACK", rec.ack_status == "TIMEOUT", rec.ack_status)
        check("3c. TIMEOUT latency reflects the wait, not ~0ms", rec.latency_ms >= 450, f"{rec.latency_ms}ms")
    conn.close()
    stop.set()

    # ---- 4. dropped connection: flush UNKNOWN, then keep accepting -----------
    captured, port, stop = start_listener()
    conn1 = connect(port)
    conn1.sendall(mllp(request_msg("CTRL-D4")))
    conn1.close()  # drop the feed with the request still unanswered
    got1 = wait_for(captured, 1)
    check("4a. dropped feed flushed the pending request", got1 and len(captured) == 1)
    if got1:
        check("4b. flushed record is honestly UNKNOWN", captured[0].ack_status == "UNKNOWN",
              captured[0].ack_status)
    conn2 = connect(port)
    conn2.sendall(mllp(request_msg("CTRL-D5")))
    time.sleep(0.05)
    conn2.sendall(mllp(ack_msg("CTRL-D5", "AA")))
    got2 = wait_for(captured, 2)
    check("4c. listener accepted a NEW connection after the drop", got2 and len(captured) == 2)
    if got2:
        check("4d. post-drop record correlates normally", captured[1].ack_status == "ACK",
              captured[1].ack_status)
    conn2.close()
    stop.set()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} sidecar correlation checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
