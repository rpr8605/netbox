# Open Questions — agent/md-sync-2026-09-22

## KF3 (control-plane host bind/publish) — RESOLVED

Implemented in `c975e84`. `BIND_HOST` env var controls the listen address (safe default `127.0.0.1` in code); `docker-compose.yml` sets `BIND_HOST=0.0.0.0` for compose-internal reachability. Host-side port is configurable via `CONTROL_PLANE_HOST_PORT`; default remapped from `9100` to `10443` because Windows reserves `9100` in excluded range `9035-9134`.

## step-ca Docker health status — RESOLVED

Container `beacon-relay-step-ca` is healthy after restart.

## Host port 9100 unavailable on Windows — RESOLVED via remap

`docker-compose.yml` now publishes host port `10443` -> container port `9100`. Host-side tests and `seed_demo_sites.js` default to `https://localhost:10443`. The container port remains `9100` for `device-sim` and `vm-harness` compose-internal access.

## Microsoft 365 / Entra ID Phase 1 — real tenant credentials needed for live validation

The `m365_account_health` adapter (`beacon-relay-agent/lib/m365_account_health.js`) is built and tested against mocks only. It uses the four read-only scopes the spec requires (`User.Read.All`, `AuditLog.Read.All`, `Organization.Read.All`, `Reports.Read.All`) and emits metadata-only `check_result` events. A real Entra ID test tenant with admin consent for those scopes is required to prove the Graph calls and response shapes against production endpoints. No real hospital tenant should be used.

## Hardware lifecycle — physical steps remain manual

The software-side hardware-lifecycle tooling is built (BOM, golden-image manifest, manifest validator, and control-plane swap workflow). The following physical steps are intentionally out of scope until a real device or manufacturing partner is available:

- Physical secure wipe / TPM clear on returned units.
- Physical barcode/serial-number scanning and RMA label integration.
- Factory burn-in, thermal, and power-cycle qualification of approved alternates.
- Verifying that every approved alternate in `hardware/bom.json` actually boots the golden image and seals LUKS correctly.

These are logged here rather than built ahead of demand.

## QEMU acceptance x3 — BLOCKED by missing KVM in Docker Desktop

Two acceptance runs failed identically with `Could not access KVM kernel module: No such file or directory`. Docker Desktop on Windows does not expose `/dev/kvm` to containers, and `vm-harness/acceptance.sh` hardcodes `-enable-kvm`. Anti-loop rule applied: stopped after 2 failures. See `.agent/attempts.md` for options.
