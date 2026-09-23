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

## M4 — TPM key generation

**Status:** PARTIALLY ADDRESSED in Batch 1 (C4). `beacon-relay-agent/lib/tpm.js` now generates the RSA key inside the TPM via `tpm2_create`; the private key never exists in software. The review's literal claim ("generated in software, then imported") is therefore DISPUTED.

**Remaining issue:** `beacon-relay-agent/provision.js` sends the software-generated public key's fingerprint to the control plane as `device_key_fp`, while the agent later signs with the TPM-generated key. The pinned fingerprint and the signing key will not match on retrust. Fixing this requires aligning first-boot provisioning with the TPM-generated key pair (use the TPM public key for the enrollment pin) or refactoring the enrollment flow to have the device present the TPM public key. This is deferred until Batch 2/3 are complete.

## M6 — Native timestamp handling in PostgreSQL

**Status:** LOGGED for post-Batch-3 work. `control-plane/src/db.js` still uses `pgize()` to translate SQLite SQL into Postgres, and timestamp columns are stored as `TEXT` with `NOW()::TEXT` comparisons. Converting to native `TIMESTAMPTZ` requires removing the SQLite driver path (part of Batch 3 maintainability: "Remove SQLite; Postgres only, native timestamps, delete pgize"). Do not attempt before SQLite removal is approved/undertaken.

## Plan for removing SQLite entirely

`control-plane/src/db.js` is currently a dual-driver layer (Postgres when `DATABASE_URL` is set, SQLite otherwise). SQLite is still convenient for zero-ops local runs and a few unit tests, but PostgreSQL is the spec'd production store. Removal checklist:

1. **Test-suite migration (this session):**
   - `.env` now sets `DATABASE_URL` to the isolated `beacon_relay_test` database by default.
   - `npm run test:db:reset` recreates the test database.
   - `npm test` runs the DB-touching suites against Postgres.
   - `control-plane/test/migrate.once.test.js` verifies the one-shot SQLite migration.
2. **Remaining SQLite-only call sites to migrate:**
   - Audit-log tamper test currently reaches into the SQLite driver directly; it needs a Postgres equivalent (use a read-only role or trigger check).
   - Any host-side scripts that rely on `DB_PATH` or the absence of `DATABASE_URL` should require `DATABASE_URL` instead.
3. **Drop the dual-driver code:**
   - Remove the `isPg` branch and the `pgize()` placeholder conversion in `control-plane/src/db.js`.
   - Keep only Postgres SQL and use `$n` placeholders everywhere.
   - Remove `better-sqlite3` from `control-plane/package.json`.
   - Remove `DB_PATH` from `docker-compose.yml` and the control-plane environment.
   - Retire `control-plane/migrate.js` once all deployed environments have migrated (it is now marker-guarded and renames the source file).
4. **Validation gate before removal:**
   - All `node --test` suites must pass with `DATABASE_URL` set and SQLite unavailable.
   - The Docker image must build and start with only `pg` installed.
    - Document the final removal commit and update `docs/specs/BEACON_RELAY_STATUS.md` / `docs/specs/BEACON_RELAY_CHECKLIST.md`.
