# Checkpoint log — agent/md-sync-2026-09-22

## Checkpoint #1 | Spend this block: $4.65 | Total session: $4.65

- **Completed:**
  - MD inventory via @scout (16 files, hashed, classified); ledger `.agent/processed-md.json` created.
  - Preparatory commit `1c9f91d` — prior-session verified rauc fixes (TMPDIR=/run + verify logging; on-device unsquashfs). Not from an MD file; carried forward so MD commits stay clean.
  - `f840531` — BEACON_RELAY_KIMI_AUDIT_FIXES(1).md items 3-6: sidecar measured ACK/NACK (MSA correlation by MSH-10), real wire latency (monotonic, request→response), resilient accept-loop listener, doc-only network-prerequisite note. New `scripts/test_sidecar_correlation.py`.
  - No-Docker suite re-verification (audit Priority 3, partial): sidecar security 24/24, agent loop 11/11, EHR unit 16/16, topology 6/6 — all fresh this session.
- **Tests/build:** pass — 24/24 security, 14/14 correlation, 11/11 agent loop, 16/16 EHR unit, 6/6 topology. (Note: two suite counts grew since CHECKLIST was written: 18→24, 10→11; both green.)
- **Currently in progress:** KIMI_FIXES.md verifiably-open items next: KF6 (graph.js missing `Bearer ` prefix, 1-line), KF7 (dead enroll.js imports node-forge), KF8 (dead gen_sfdisk/partition.env flows), KF3 (control-plane host bind/publish). Then Docker-dependent: audit item 1 (acceptance x3), item 1b (EHR E2E re-run + CHECKLIST wording), CHECKLIST updates with fresh evidence.
- **Blocked / questions:** none logged to open-questions.md. Operational note: `docker ps` shows step-ca "Up 5 days (unhealthy)" — must be addressed before E2E/acceptance runs; not a spec question.
- **Agent usage:** @scout ×1 (MD inventory+hashes+summaries). @architect ×1 (sidecar items 3-6 plan — PHI-boundary file, required by escalation rules; plan was directly implementable). @reviewer ×3 (preparatory diff: commit; sidecar v1: fix-first, 1 high + 5 med; sidecar v2: commit after fixes).
- **Efficiency notes:** one self-inflicted error — a global regex replace in the test file rewrote the `connect()` helper's own body into infinite recursion; caught by the test run, fixed in one pass. Lesson: never regex-replace call sites without excluding the definition. No subagent loops; each returned usable output first try. Model-mapping note: this environment's task tool exposes only `explore`/`general` subagent types, not literal model IDs — @scout mapped to `explore`, @reviewer/@architect to `general`.
- **Model fit:** @reviewer earned its tier — caught a real HIGH (listener could die via callback exception) the Builder missed. @architect plan needed zero rework. No weak outputs.
- **Remaining:** KF6/KF7/KF8/KF3 (small, ~$1-2); Docker-dependent acceptance ×3 + EHR E2E + CHECKLIST/STATUS updates (~$3-5 depending on QEMU/TCG run length); ledger finalization + final report.

## Checkpoint #2 | Spend this block: $0.00 | Total session: $4.65

- **Baseline set:** `opencode stats` total = **$650.07** (new $5 checkpoint threshold = $655.07).
- **Setup check result:** STOP triggered. I am `opencode-go/kimi-k2.7-code`. The model IDs configured in `opencode.json` for the subagents are **not all valid in this environment**:
  - `@reviewer` is mapped to `opencode/claude-sonnet-5`; invoking it failed with `Model not found: opencode/claude-sonnet-5` (available alternatives include `claude-sonnet-5`, `claude-sonnet-4-5`).
  - The `opencode/` prefix on the Claude model IDs appears to be the mismatch. `@scout` (`opencode-go/deepseek-v4-flash`) and `@architect` (`opencode/claude-opus-5-5`) were not tested after the failure per the STOP rule.
- **Housekeeping done:** ledger `.agent/processed-md.json` updated with new/updated reference entries (`AGENTS.md`, `opencode.json`, `models/opencode.json`, `models/cost-calc.py`, `models/pricing.csv`); committed as `affebe3` — `chore: model routing config`. `README(2).md` already recorded as reference. `.gitignore` was unchanged/already committed.
- **Commit 1c9f91d review:** could not send to `@reviewer` because the subagent is not callable with the current model mapping. Retry once `opencode.json` is corrected.
- **step-ca diagnosis (read-only):** the CA process itself is healthy — logs show `/health` returning HTTP 200 consistently. The `unhealthy` Docker status is caused by the container health-check exec failing with `OCI runtime exec failed: exec failed: unable to start container process: procReady not received`. This is a Docker Desktop / container-runtime health-check execution issue, not a step-ca application, cert, or key problem. No regeneration required; likely fix is to restart the container or Docker Desktop.
- **Blocked / questions:** `@reviewer` and `@architect` model IDs need correction before any MD-driven work can proceed. Not proceeding with KF6/KF7/KF8/KF3 until model routing is fixed.
- **Agent usage this block:** none successfully invoked (failed `@reviewer` ×1).

## Checkpoint #3 | Spend this block: $2.01 | Total session: $6.66

- **Model / subagents:** I am `opencode-go/kimi-k2.7-code`. `opencode.json` was updated to Go-only models (`19a9062`) but the `task` tool still maps `@reviewer`/`@architect` to non-existent `opencode/claude-*` IDs, so all helper work was done manually this block.
- **Setup / housekeeping done:**
  - Committed `opencode.json` as `chore: switch model routing to Go-only` (`19a9062`).
  - step-ca now **healthy** after `docker compose up -d control-plane` recreated the dependency chain.
  - Reviewed commit `1c9f91d` manually: **no HIGH severity findings**.
- **KF6 done** (`107ac2f`): Graph API requests now send `Bearer ` prefix; removed dead `authorization` property; `scripts/test_step1_signals.js` now sets mock tenant creds and asserts the Bearer prefix. Test passes.
- **KF7 done** (`a68b0f5`): Removed dead `beacon-relay-agent/lib/enroll.js` and its references in `pipeline/build.js` / `pipeline/stages/30-agent.sh`. `node --check pipeline/build.js` + `node scripts/test_agent_loop.js` 11/11 pass.
- **KF8 done** (`2b1d01d`): Removed dead `pipeline/gen_sfdisk.js`, `out/**/sfdisk.script`, `/tmp/partition.env` flow. `20-partition.sh` now validates the partition map; `40-rauc.sh` no longer sources `partition.env`. `node --check pipeline/build.js` + `node scripts/test_agent_loop.js` 11/11 pass.
- **KF3 blocked:** literal spec fix (bind `127.0.0.1` + drop host port publish) breaks host-side tests and vm-harness. Logged to `.agent/open-questions.md`; pending Ryan's decision.
- **Docker-dependent items blocked:** Windows excluded port range `9035-9134` covers host port 9100, so `docker-compose.yml` cannot publish `9100:9100`. Host-side E2E/RBAC/acceptance runs are blocked in this environment.
- **Fresh no-Docker evidence gathered:** doc audit 89/0/0/213, EHR unit 16/16, agent loop 11/11, Step 1 signals Graph path emits 2 signals with Bearer assertion, sidecar security 24/24, topology 6/6.
- **CHECKLIST/STATUS updated** with current commit `2b1d01d`, fresh evidence, KF6/7/8/3 status, and environment blockers. Committed as `fea0d33`.
- **Ledger finalized:** `.agent/processed-md.json` updated with `fea0d33` references and new `BEACON_RELAY_KIMI_AUDIT_FIXES(1).md` entry. Committed as `156f9ea`.
- **Agent usage this block:** none successfully invoked (helpers still misconfigured). Manual reviews: 4 (opencode.json, KF6, KF7, KF8, 1c9f91d).

## Checkpoint #4 | Block: $2.14 | Total: $4.96 | Cost/commit: $1.65

- **Done:**
  - `c975e84` fix(control-plane): make bind address and host publish configurable (KF3) — source `BEACON_RELAY_KIMI_FIXES.md` item 3
  - `5615c10` docs: update CHECKLIST/STATUS with KF3 DONE and fresh E2E/RBAC results — source `BEACON_RELAY_CHECKLIST.md` / `BEACON_RELAY_STATUS.md`
- **Tests:** E2E 23/23, alerting/RBAC 33/33, doc audit 89/0/0/213, EHR unit 16/16, agent loop 11/11, sidecar security 24/24, topology 6/6, Step 1 signals Graph path emits 2 signals
- **Next:** QEMU acceptance x3 (needs fresh image build) after "continue"
- **Blocked:** none; KF3 and port-9100 blocker resolved
- **Repeat check:** none
- **Progress:** KF6/7/8/3 complete; E2E/RBAC re-verified; ~85% of MD-sync work done, acceptance and next-priority spec items remain

## Checkpoint #5 | Block: $? | Total: $? | Cost/commit: $?

- **Done:**
  - Channel registry now stores `site_id`, `source_system`, `destination_system`; `mirthChannelStates` exposes graph endpoints; topology/rollup/full-status routes return them; seed data and tests updated.
  - `BEACON_RELAY_CHECKLIST.md` / `BEACON_RELAY_STATUS.md` updated: channel registry §11/§12 marked DONE, EHR unit count 17/17, removed completed item from "cheapest next wins".
- **Tests:** topology 6/6, EHR unit 17/17, EHR E2E 23/23, alerting/RBAC 33/33, agent loop 11/11, Step 1 signals 2/2, configurator 8/8, update client 5/5
- **Next:** AWS Organization + three accounts (blocked by missing AWS CLI/credentials) OR TLS-cert-expiration critical service
- **Blocked:** QEMU acceptance x3 (missing KVM in Docker Desktop); AWS Organization (no AWS CLI)
- **Progress:** 61 of 99 CHECKLIST items complete (62%), up from 60 of 99 (61%)

## Checkpoint #6 | Block: $? | Total: $? | Cost/commit: $?

- **Done:**
  - TLS certificate expiration as a first-class critical service (`CONTROLS_AND_IDENTITY` §3): `cert_expiration` in schema + critical-service register, metadata-only events emitted from every TLS handshake, status mapping expired/down / soon/degraded / valid/verified_ready, unit tests for all three cases.
- **Tests:** EHR unit 21/21, E2E 23/23, alerting/RBAC 33/33, topology 6/6, agent loop 11/11, Step 1 signals 2/2, configurator 8/8, update client 5/5
- **Next:** Ticketing Tier 0 copy-paste block (`TOPOLOGY_…_MEMORY` §3)
- **Blocked:** QEMU acceptance x3 (missing KVM); AWS Organization (no AWS CLI)
- **Progress:** 62 of 99 CHECKLIST items complete (63%), up from 61 of 99 (62%)

## Checkpoint #7 | Block: $? | Total: $? | Cost/commit: $?

- **Done:**
  - Ticketing Tier 0 (`TOPOLOGY_…_MEMORY` §3): `GET /api/alerts/:id/ticket` and `POST .../ticket/email`, RBAC-gated, metadata-only, SendGrid pipe reused.
- **Tests:** alerting/RBAC/audit/support/ticketing 39/39, EHR unit 21/21, E2E 23/23, topology 6/6, agent loop 11/11, Step 1 signals 2/2, configurator 8/8, update client 5/5
- **Next:** SES email sender alongside SendGrid (`BUILD_SPEC` §6), then next unblocked CHECKLIST items in spec priority order
- **Blocked:** QEMU acceptance x3 (missing KVM); AWS Organization (no AWS CLI)
- **Progress:** 63 of 99 CHECKLIST items complete (64%), up from 62 of 99 (63%)

## Checkpoint #8 | Block: $? | Total: $? | Cost/commit: $?

- **Done:**
  - SES email sender alongside SendGrid (`BUILD_SPEC` §6): `sendSes()` using `@aws-sdk/client-sesv2`, SES-first then SendGrid fallback, ticket email endpoint updated, skip-when-unconfigured test.
- **Tests:** alerting/RBAC/audit/support/ticketing/SES 40/40, EHR unit 21/21, E2E 23/23, topology 6/6, agent loop 11/11, Step 1 signals 2/2, configurator 8/8, update client 5/5
- **Next:** next highest-priority unblocked CHECKLIST items in spec priority order (geographic fleet map, incident_signature, or remaining network controls)
- **Blocked:** QEMU acceptance x3 (missing KVM); AWS Organization (no AWS CLI)
- **Progress:** 64 of 99 CHECKLIST items complete (65%), up from 63 of 99 (64%)

## Checkpoint #9 | Block: $? | Total: $? | Cost/commit: $?

- **Done:**
  - Geographic fleet map (`TOPOLOGY_AND_TROUBLESHOOTING_MEMORY` §1): `sites` table with `lat`/`lng`/`name`; enrollment tokens accept optional site metadata; `GET /api/fleet/map` with RBAC (ops/support full fleet, customer-it-admin single site); overall site status = worst of critical-service statuses with unknown as baseline; `public/fleet.html` renders pins.
- **Tests:** alerting/RBAC/audit/support/ticketing/SES/fleet-map 47/47, EHR unit 24/24, E2E 23/23, topology 6/6, agent loop 11/11, Step 1 signals 2/2, configurator 8/8, update client 5/5
- **Next:** next highest-priority unblocked CHECKLIST items in spec priority order (troubleshooting-memory `incident_signature`, WAN/ISP circuit health, Action Registry, or M365 Phase 1 read-only account health)
- **Blocked:** QEMU acceptance x3 (missing KVM); AWS Organization (no AWS CLI)
- **Progress:** 67 of 99 CHECKLIST items complete (68%), up from 64 of 99 (65%)

## Checkpoint #10 | Block: $? | Total: $? | Cost/commit: $?

- **Done:**
  - Troubleshooting memory (`TOPOLOGY_AND_TROUBLESHOOTING_MEMORY` §2): `incident_signature` captured automatically on alert open; `POST /api/alerts/:id/close` records `resolution_record`; deterministic weighted-overlap matching in `control-plane/src/incident_memory.js`; `GET /api/alerts/:id/similar` returns ranked matches + distributions + cold-start-honest empty state.
- **Tests:** alerting/RBAC/audit/support/ticketing/SES/fleet-map/troubleshooting-memory 58/58, EHR unit 24/24, E2E 23/23, topology 6/6, agent loop 11/11, Step 1 signals 2/2, configurator 8/8, update client 5/5
- **Next:** next highest-priority unblocked CHECKLIST items in spec priority order (WAN/ISP circuit health, Action Registry, M365 Phase 1 read-only account health, or RAUC OTA staged rollout)
- **Blocked:** QEMU acceptance x3 (missing KVM); AWS Organization (no AWS CLI)
- **Progress:** 71 of 99 CHECKLIST items complete (72%), up from 67 of 99 (68%)

## Checkpoint #11 | Block: $37.61 | Total: $676.42 | Cost/commit: $37.61

- **Done:**
  - M365 Phase 1 read-only account health (`CONTROLS_AND_IDENTITY` §4): `m365_account_health` critical service + `m365` adapter, read-only Graph scopes, mock-tested. `e0834e2`.
- **Tests:** EHR unit 32/32, alerting/RBAC/audit 76/76, OTA rollout 10/10, control-plane rebuilt with new schema.
- **Next:** wireless AP health + VPN tunnel health, then backup/DR + AV/EDR read-only status, per `CONTROLS_AND_IDENTITY` §3 build order.
- **Blocked:** QEMU acceptance x3 (missing KVM); AWS Organization (no AWS CLI); live Entra ID test tenant for M365 real-world validation.
- **Progress:** 72 of 99 CHECKLIST items complete (73%), up from 71 of 99 (72%).

## Checkpoint #12 | Block: $4.77 | Total: $681.19 | Cost/feature commit: $1.59

- **Done:**
  - Site-level network/endpoint controls (`CONTROLS_AND_IDENTITY` §3): wireless AP, VPN tunnel, backup/DR, AV/EDR read-only adapters (`site_controls.js`). `b998c64`.
  - Topology detail panel (`EHR_INTEGRATIONS` §11/§12): Mirth reader fetches metadata-only message timestamps and recent error counts; full-status API and Fleet Console render them. `f025efc`.
  - Mirth reader allowlist fix: `pickMessageMeta` drops any content fields the API returns despite `includeContent=false`; new test feeds content-bearing stub and asserts it is dropped. `9332e36`.
  - Hardware lifecycle tooling (no-hardware portion): BOM + alternates (`hardware/bom.json`), golden-image manifest (`hardware/golden_manifest.json`), manifest validator (`scripts/validate_golden_manifest.js`), swap procedure doc, control-plane `POST /api/devices/:id/replace` workflow + CLI (`scripts/swap_device.js`). `36df918`.
  - PHI-mode toggle design note (`BUILD_SPEC` §8.9): `.agent/phi-mode-design.md` written and under review; no code implemented. `60dd1d3`.
  - React frontend rewrite logged as deferred in `BEACON_RELAY_STATUS.md` / `BEACON_RELAY_CHECKLIST.md`.
- **Tests:** EHR unit 43/43, topology 7/7, device lifecycle 6/6, alerting/RBAC/audit 76/76, OTA rollout 10/10, doc audit 97 files / 0 missing headers / 4 pre-existing missing doc comments.
- **Repeat check:** none.
- **Blocked:** QEMU acceptance x3 (missing KVM in Docker Desktop); AWS Organization (no AWS CLI); live Entra ID test tenant for M365; live Mirth 3.x instance validation; PHI-mode design awaiting review before implementation; physical hardware-lifecycle steps (secure wipe/TPM clear/alternate qualification/barcode scanning) require real hardware.
- **Next 3:**
  1. Await PHI-mode design approval; do not implement until approved.
  2. After approval, implement PHI-mode toggle (schema/API/audit/badge/purge worker).
  3. Then pick the next unblocked priority: PostgreSQL driver swap, AWS account setup, or remaining BUILD_SPEC surfaces.
- **Progress:** 78 of 99 CHECKLIST items complete (79%), up from 72 of 99 (73%).

## Checkpoint #13 | Block: $4.32 | Total: $685.51 | Cost/feature commit: $2.16

- **Done:**
  - Device swap security hardening (`BUILD_SPEC` §8.9 / hardware lifecycle): `POST /api/devices/:id/replace` now revokes the old device's certificate in step-ca via JWK provisioner token, records the serial in a local `revoked_serials` registry, and rejects the next mTLS connection attempt with `403 certificate revoked`. `5769c12`.
  - RBAC lockdown: added `devices:replace` permission granted only to `operations-manager`; support-technician can no longer retire devices. `5769c12`.
  - Unit + E2E tests for swap revocation: `scripts/test_device_lifecycle.js` extended; new `scripts/test_device_replace_e2e.js` proves old cert rejected and step-ca refuses renewal. `5769c12`.
  - Demo mode: `npm run demo` / `demo.ps1` one-command orchestrator; `scripts/demo_seed.js` seeds 6 fictional MO/KS critical-access hospitals; `scripts/demo_timeline.js` plays a ~10-min scripted incident timeline (channel stall, TLS cert near expiry, WAN flap/recovery, DNS failure, incident-memory similar-past lookup); `DEMO.md` with start/stop/reset and 5-minute hospital-IT-director click-through; DEMO banner in console pages via `/api/demo`; `device-sim` loops in `DEMO_MODE=1`. `67425ea`.
  - Demo tests: `scripts/test_demo_seed.js` and `scripts/test_demo_timeline.js` verify seed definitions and timeline coverage. `67425ea`.
  - `device-sim` confirm call fixed to include `?role=operations-manager` so the Phase 1 test suite passes under current RBAC. `67425ea`.
- **Tests:** device lifecycle 13/13, device-swap E2E 7/7, EHR E2E 23/23, alerting/RBAC/audit 76/76, EHR unit 43/43, agent loop 11/11, topology 7/7, Step 1 signals 4/4, configurator 8/8, update client 9/9, OTA rollout 10/10, demo seed 5/5, demo timeline 4/4. All fresh this session.
- **Repeat check:** none.
- **Blocked:** QEMU acceptance x3 (missing KVM in Docker Desktop); AWS Organization (no AWS CLI); live Entra ID test tenant for M365; live Mirth 3.x instance validation; PHI-mode design awaiting review before implementation; physical hardware-lifecycle steps require real hardware.
- **Next:** PostgreSQL driver swap per `BUILD_SPEC` §5. Architect plan complete; implementation starts in next block. If it exceeds one checkpoint it will be broken into steps with a checkpoint between.
- **Progress:** 78 of 99 CHECKLIST items complete (79%).

## Checkpoint #14 | Block: $? | Total: $? | Cost/feature commit: $?

- **Done:**
  - PostgreSQL storage for the control plane (`BUILD_SPEC` §5): `control-plane/src/db.js` rewritten as an async dual-driver layer that uses PostgreSQL when `DATABASE_URL` is set and falls back to SQLite for local dev/tests. All routes, alerting, incident memory, index.js, and RBAC preHandler updated to `await` DB calls. `control-plane/src/schema.js` holds the shared SQLite/Postgres DDL. `65ba54d`.
  - SQLite-to-PostgreSQL migration: `control-plane/migrate.js` (and thin launcher `scripts/migrate_sqlite_to_postgres.js`) copies legacy SQLite data idempotently table-by-table with `ON CONFLICT DO NOTHING`. `65ba54d`.
  - Docker composition: `docker-compose.yml` adds a `postgres` service, wires `DATABASE_URL` into the control-plane, and makes the control-plane depend on Postgres health. `control-plane/Dockerfile` uses an entrypoint that runs the migration before starting the server. `65ba54d`.
  - Migration verified in compose: the existing SQLite `cp-data` volume (2023 rows) was copied into the new Postgres service before the control-plane started; full stack came up healthy.
- **Tests:**
  - Unit/no-Docker suites green on SQLite: EHR unit 43/43, agent loop 11/11, Step 1 signals 4/4, configurator 8/8, update client 9/9, topology 7/7, device lifecycle 13/13, demo seed 5/5, demo timeline 4/4.
  - DB-touching suites green on PostgreSQL: `DATABASE_URL=postgres://... node --test scripts/test_device_lifecycle.js scripts/test_topology.js` 20/20.
  - E2E against live compose stack with Postgres: device-swap E2E 7/7, alerting/RBAC/audit/support/ticketing/fleet-map/troubleshooting-memory/Action Registry 76/76, EHR E2E 23/23, OTA rollout 10/10.
  - Migration smoke test: seeded SQLite file → `node control-plane/migrate.js` → verified rows in Postgres.
- **Repeat check:** none.
- **Blocked:** QEMU acceptance x3 (missing KVM in Docker Desktop); AWS Organization (no AWS CLI); live Entra ID test tenant for M365; live Mirth 3.x instance validation; PHI-mode design awaiting review before implementation; physical hardware-lifecycle steps require real hardware.
- **Next:** AWS Organization + three accounts (`CLOUD_ARCHITECTURE_AWS` §6 step 1), now unblocked by Postgres storage. Alternatively, continue with any remaining `BUILD_SPEC` surfaces if AWS access is not ready.
- **Progress:** 79 of 99 CHECKLIST items complete (80%), up from 78 of 99 (79%).

## Checkpoint #15 | Block: $7.42 | Total: $692.93 | Cost/feature commit: $1.48

- **Done:**
  - Migration safety (BUILD_SPEC �5): SQLite-to-Postgres migration now runs exactly once per Postgres database. A marker row in schema_migrations prevents re-runs; after success the SQLite source is renamed to *.migrated. control-plane/test/migrate.once.test.js proves a row deleted in Postgres is NOT resurrected after restart. dfaca41.
  - Secrets moved out of committed files: .env.example committed, .env gitignored; docker-compose.yml no longer hardcodes CA_PASSWORD, POSTGRES_USER, POSTGRES_PASSWORD, or POSTGRES_DB; scripts/pki_seed.js requires CA_PASSWORD from the environment. 2fce3cd.
  - PostgreSQL made the default for test suites: .env sets DATABASE_URL to isolated eacon_relay_test; 
pm run test:db:reset recreates it; root and control-plane/package.json scripts load .env via 
ode --env-file=.env; scripts/test_alerting_rbac_audit_support.js forces SQLite only for its isolated audit tamper test.  d0e22c.
  - Readiness audit (no new code): .agent/readiness-audit.md maps 10 areas to DONE/PARTIAL/MISSING with file paths and test names. 2ebd4c7.
  - DHCP health as a first-class critical service (CONTROLS_AND_IDENTITY �3): dhcp_health added to schema service enum and critical-service register; unDhcpHealthCheck reads from a hospital-exposed status source and reports erified_ready/degraded/down/unknown. 503e165.
  - CHECKLIST/STATUS updated with fresh evidence and the new .env/test workflow. dcd8365.
- **Tests:**
  - Doc audit 97 files / 0 missing headers / 4 pre-existing missing doc comments.
  - EHR unit 48/48 (up from 43; +5 DHCP checks), agent loop 11/11, Step 1 signals 4/4, sidecar security 24/24, topology 7/7, device lifecycle 13/13, migration safety 1/1, DB-touching Postgres suite 21/21, EHR E2E 23/23, alerting/RBAC/audit/support/ticketing/SES/fleet-map/troubleshooting-memory/Action Registry 76/76, update client 9/9, OTA rollout 10/10.
  - All suites re-run fresh this session against Postgres defaults.
- **Repeat check:** none.
- **Blocked:** AWS Organization + three accounts (skipped per Ryan's instruction); QEMU acceptance x3 (missing KVM in Docker Desktop); live Entra ID test tenant for M365; live Mirth 3.x instance validation; PHI-mode design awaiting review before implementation; physical hardware-lifecycle steps require real hardware.
- **Next:** Security gaps from .agent/readiness-audit.md and the independent review (Beacon_Relay_Code_Review_2026-09-23.md): device-side server cert pinning, OTA version validation/no-shell, atomic token consumption, route auth-policy test.
- **Progress:** 80 of 99 CHECKLIST items complete (81%), up from 79 of 99 (80%).

## Checkpoint #16 | Block: $6.43 | Total: $699.36 | Cost/feature commit: $0.80

- **Done (Batch 1 security fixes from independent review):**
  - C3: `docker-compose.yml` binds control-plane and step-ca host ports to `127.0.0.1`; Postgres no longer published; `POSTGRES_PASSWORD` and `CA_PASSWORD` use `${VAR:?message}` with no defaults; `.env.example` updated; `.gitignore` ignores whole `out/` tree. `28c4c1c`.
  - C4: strict version regex on rollout create and device receipt; `execSync` template strings replaced with `execFileSync` arg arrays in `beacon-relay-agent/lib/update.js` and `beacon-relay-agent/lib/tpm.js`; `fetchBytes` fails on non-200. `bba3793`.
  - C2: `POST /api/enroll/tokens` gated behind `operator:enroll:tokens`; existing device_id refused unless `re_enroll=true` and audited; active device never downgraded; `device_key_fp` preserved. `e36f925`.
  - H1: device pins step-ca root in `/data/ca-root.pem` and verifies control-plane server cert (`ca`, `rejectUnauthorized: true`, `servername`) on every call via new `beacon-relay-agent/lib/tls_pin.js`. `be90fec`.
  - H3: every route declares `config.auth` policy (`device`, `operator:<perm>`, or `public`); ungated console reads (devices, alerts, channels, topology, full-status, support) now RBAC-gated; `control-plane/test/route-auth.test.js` enumerates the route table. `f4fc5c2`.
  - H4: already fixed in `dfaca41` (marker table + `*.migrated`); verified by `control-plane/test/migrate.once.test.js`.
  - M3: atomic `UPDATE ... RETURNING` for enrollment-token and retrust-challenge consumption. `ae073d5`.
  - M5: bundle download reuses `deviceFromCert()` from `events.js`, enforcing revocation/state checks. `903b854`.
  - M1: PHI guard applied to SMS, voice, and Slack/Teams webhooks; voice TwiML escapes XML special characters. `f54226b`.
- **Tests:**
  - New review-focused tests: 25/25 pass (C3 7, C4 3, C2 4, H1 2, H3 2, H4 1, M3 2, M5 2, M1 4).
  - Existing no-Docker suites re-run: EHR unit 48/48, agent loop 11/11, update client 9/9.
  - Docker-dependent alerting/RBAC/support suite not re-run yet (needs `docker compose up`).
- **Repeat check:** none.
- **Blocked:** QEMU acceptance x3 (missing KVM in Docker Desktop); AWS Organization (no AWS CLI); live Entra ID test tenant for M365; live Mirth 3.x instance validation; PHI-mode design awaiting review; physical hardware-lifecycle steps require real hardware.
- **Open questions updated:** M4 (TPM key generation partially addressed; provision.js pin mismatch remains) and M6 (native Postgres timestamps blocked on SQLite removal) logged to `.agent/open-questions.md`.
- **Next 3:**
  1. Batch 2: H2 OTA rollback correctness (remove in-cycle mark-good/mark-bad; health-check after reboot into new slot).
  2. Batch 3 maintainability: README rewrite, ARCHITECTURE + SECURITY_MODEL docs, docs reorg, single `npm test`, GitHub Actions workflow, lint configs, wrong-comment fixes.
  3. C1 options note (operator auth identity-provider decision) per user instruction.
- **Progress:** 9 of 15 review code findings closed (excluding maintainability list and H5 repo-setting). No CHECKLIST items added yet.


