# Attempts log — agent/md-sync-2026-09-22

## QEMU acceptance x3

**Task:** Run `vm-harness/acceptance.sh` three times in a row against a fresh image.
**Approach:** `docker compose -f vm-harness/compose.yml run --rm vm-harness bash /work/vm-harness/acceptance.sh 0.1.0`

| Run | Log | Result | Failure |
|---|---|---|---|
| 1 | `logs/acceptance-1-20260922-173423.log` | FAIL | `Could not access KVM kernel module: No such file or directory` |
| 2 | `logs/acceptance-2-20260922-173624.log` | FAIL | Same KVM error |

**Diagnosis:** Docker Desktop on Windows does not expose `/dev/kvm` inside containers. `vm-harness/acceptance.sh` hardcodes `qemu-system-x86_64 ... -enable-kvm`, so the run cannot start. This is an environment limitation, not a code defect.

**Next options (if resuming):**
1. Modify `vm-harness/acceptance.sh` (and `run_qemu.sh`) to detect KVM absence and fall back to TCG (`-accel tcg`), with longer timeouts to account for slower guest time.
2. Run acceptance on a Linux host or VM with KVM available.
3. Use WSL2 backend for Docker Desktop and check if `/dev/kvm` becomes available.

**Decision per anti-loop rule:** stopped after 2 identical failures with the same approach. Moving to next priority items.
