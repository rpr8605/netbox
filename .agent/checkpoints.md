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
