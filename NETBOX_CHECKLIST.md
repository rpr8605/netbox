# Netbox — Deliverables Checklist (read-only audit)

Audit pass, no code changed. Every status below was verified against the actual repo and
by re-running the test suites on the current commit — not copied from `NETBOX_STATUS.md`
or any prior summary. Where a claim couldn't be re-verified live, it says so and why.

**Audited at commit:** `84e3206` (main, in sync with origin).

## Test evidence on this commit (re-run during this audit)

| Suite | Command | Result |
|---|---|---|
| Doc audit | `node audit_docs.cjs .` | 62 files, 0 missing header, 0 missing doc comment (137 exports) |
| EHR adapters unit | `node scripts/test_ehr_unit.js` | 16/16 |
| Agent loop (monitor + self-monitor + downtime) | `node scripts/test_agent_loop.js` | 10/10 |
| Sidecar security (incl. adversarial payload-recovery) | `python scripts/test_sidecar_security.py` | 18/18 |
| EHR E2E through real stack | `node scripts/test_ehr_e2e.js` | 23/23 |
| Alerting / RBAC / audit / support | `node scripts/test_alerting_rbac_audit_support.js` | 23/23 |
| Topology (channel registry, RBAC rollup gate) | `node --test scripts/test_topology.js` | 6/6 |
| Phase 3 QEMU acceptance | `vm-harness/acceptance.sh` (fresh build) | ACCEPTANCE_PASS |

Prereq for the network suites: `docker compose up -d step-ca control-plane`.
Prereq for the acceptance suite: a built image at `out/0.1.0/` (via `node pipeline/build.js`).

Status marks: **DONE** = built and covered by a passing test (suite named). **PARTIAL** =
code exists but stubbed/mocked/unverified/missing a spec'd piece (the gap is stated).
**NOT STARTED** = no code yet.

---

## NETBOX_BUILD_SPEC.md

### §2 / §8.3 — The Configurator (Phase 3)
- Base image build (minimal Debian, ro root, writable /data partition) — **DONE** (pipeline stages 00–30; QEMU acceptance).
- RAUC bundle pipeline (one build → flashable artifact + signed bundle) — **DONE** (`pipeline/build.js` EXIT=0; `bundle assembled … CMS signed`; `VERIFY OK`).
- LUKS full-disk encryption, non-optional — **DONE** (decrypt-data.service luksFormats+opens /data every boot; post-boot `luksDump` confirmed LUKS2 container).
- First-boot provisioning (keypair → TPM/LUKS seal → step-ca cert → quarantine until confirm) — **DONE** (`ACCEPTANCE_PASS`: TPM-seal → quarantine → confirm → active heartbeat in QEMU).
- Configurator CLI: list releases — **DONE** (`configurator/src/index.js releases`).
- Configurator CLI: confirm-target gate (unmissable, exact-string confirm) — **DONE** (flash flow shows gate; refused on mismatch).
- Configurator CLI: drive-write with progress + post-write checksum verify — **DONE** (dd write + sha256 read-back match, `flash: verified; sha256 matches`).
- Configurator CLI: "save as standalone install file" — **DONE** (`save` exports sha256-identical artifact).
- Phase-3 end-to-end: saved-file flashes + boots identically via dd — **DONE** (`DD_BOOT_OK` in QEMU).

### §3 / §8.4 — The Device Agent (Phase 4)
- L0–L4 tiers as check depth — **DONE** (net_checks L0/L1/L2; FHIR adapter L3; L4 via observed-traffic note — L4 has no dedicated adapter, it's the HL7 tap's observed-ACK path; see note in Known-gaps).
- Continuous monitoring loop (scheduled checks, not test-invoked) — **DONE** (`lib/monitor_loop.js`; agent-loop 10/10).
- Last-successful-check-per-monitor — **DONE** (`lib/monitor_state.js` persisted to /data).
- Multi-step outage confirmation (retry → second dependency → WAN → LTE) before escalating — **DONE** (`lib/outage_confirm.js`; ordered-step proof in agent-loop 10/10).
- Self-monitoring: heartbeat, clock sync, disk, DNS, modem, control-plane reachability — **DONE** (`lib/self_monitor.js`; silence-detection proven in agent-loop 10/10).
- Downtime mode local UI (cached contact tree/vendors/priorities/runbooks, works with CP severed, catches up on reconnect) — **DONE** (`lib/downtime.js`; agent-loop 10/10).

### §3 / §8.5 — HL7/MLLP sidecar (Phase 5)
- Passive MLLP tap, never in message path — **DONE** (`sidecar/mllp_tap.py`).
- Metadata-only extraction (type/trigger, direction, timestamp, ACK/NACK, latency, size) — **DONE** (sidecar 18/18).
- Per-device keyed HMAC-SHA256 correlation token (not a plain hash) — **DONE** (sidecar 18/18; two devices → different tokens proven).
- `phi_mode:false` structural guarantee (raw body never retained) — **DONE** (sidecar 18/18; adversarial recovery FAILS to find payload).

### §4 — Canonical data model
- Canonical event schema (JSON Schema) — **DONE** (`schemas/netbox_event.schema.json`).
- Generated TS + Python types — **DONE** (`scripts/gen_schema.js` → `schemas/typescript.ts`, `schemas/python.py`).
- `phi_mode` default false everywhere — **DONE** (schema + sidecar enforce).
- Optional `channel_id` field (added for topology) — **DONE** (topology 6/6).

### §5 — Cloud Control Plane
- Device registry + mTLS ingestion API — **DONE** (EHR E2E 23/23 through real mTLS).
- Quarantine gate — **DONE** (device-sim + acceptance).
- PostgreSQL storage — **PARTIAL**. Repo runs on SQLite (`db.js`, better-sqlite3) with a schema written for a driver swap; the actual Postgres/RDS migration is not done and TimescaleDB-vs-partitioning is untested.
- RBAC five roles (support technician, customer IT admin, operations manager, security auditor, read-only executive) — **PARTIAL**. The role→permission map and per-route allow/deny are real and tested (alerting/RBAC suite 23/23), but Phase 2 has no auth — `role` arrives as a request attribute, not a verified principal. The Cognito/JWT layer is not built.
- Audit log: append-only, immutable — **DONE** (trigger-enforced UPDATE/DELETE raise; tamper test fails; suite 23/23).

### §6 — Alerting & Escalation Engine
- Severity tiers + owner/contact mapping — **DONE** (alert rules + tiered contacts; suite 23/23).
- Plain-language impact statements (transport jargon rejected) — **DONE** (validateImpactStatement; suite 23/23).
- Runbook attachment per condition — **DONE** (rule carries runbook_url; suite 23/23).
- Required ack + auto-escalation on timeout — **DONE** (sweep escalates un-acked P1 to tier 2; suite 23/23).
- Suppression/maintenance windows — **DONE** (maintenance suppresses fire; suite 23/23).
- Delivery rails: Twilio SMS/voice, SES/SendGrid email, Slack/Teams webhook — **PARTIAL**. `lib/deliver.js` is real code for all four channels, but no live SaaS credentials are wired in tests — delivery is proven by shape/mocking, not by a real message leaving. (SES specifically is not implemented — SendGrid is the email path currently written.)

### §7 — Fleet Console
- Per-device registry/status console — **DONE** (`public/index.html`).
- Per-site interface topology view (graph, status colors, click detail) — **DONE** (`public/topology.html`; topology 6/6).
- Cross-site rollup view, ops-manager/support-technician only — **DONE** (RBAC-gated; suite 23/23).
- Rule-based detail panel (failed check + raw detail, tier meaning, time-in-state, co-occurring signals w/o causation) — **DONE** (topology.html panel; deterministic, no AI).
- React frontend (spec asks React) — **PARTIAL**. The console is hand-written HTML/vanilla JS served by Fastify static, not a React app. It works and is tested, but it's not the React frontend the spec names.
- Remote-support session broker (outbound-only, JIT token, time-limited, audit-logged) — **PARTIAL**. The broker, JIT token, TTL enforcement, and audit logging are real and tested (suite 23/23), but the "tunnel" is a session record, not a real byte pipe — the actual transport is meant to be AWS IoT Secure Tunneling per the AWS doc (not built).

### §8.7 — Signed OTA updates
- Signed bundle builds + signature verifies — **DONE** (build.js VERIFY OK).
- Staged rollout path (dev → test → pilot → broad), SBOM, rollback-verified-with-broken-build — **NOT STARTED**.

### §8.9 — PHI mode toggle + hardware lifecycle tooling — **NOT STARTED**.

---

## NETBOX_EHR_INTEGRATIONS.md

### §2 — four protocol adapters
- HL7v2 passive tap — **DONE** (sidecar 18/18).
- FHIR R4 read-only polling client (SMART backend-services auth, capability fetch, scoped synthetic read) — **DONE** (EHR unit 16/16 + E2E 23/23 + public sandbox).
- Generic network checks (L0/L1/L2) — **DONE** (net_checks; unit 16/16).
- Mirth Connect / NextGen Connect admin-API reader (read-only status, no message content) — **DONE** (mirth_admin; unit 16/16 + E2E 23/23).
- Per-site config-profile schema + loader — **DONE** (ehr_check.loadProfile; loader rejects malformed input).

### §5 — vendor config profiles
- MEDITECH Expanse — **DONE** (E2E 23/23).
- MEDITECH Magic — **DONE** (E2E 23/23).
- MEDITECH Client-Server — **DONE** (E2E 23/23).
- TruBridge/Evident — **DONE** (E2E 23/23).
- Epic Community Connect (FHIR ships disabled-by-default; parent-org grant caveat) — **DONE** (E2E 23/23).
- Oracle Health CommunityWorks — **DONE** (E2E 23/23).
- athenahealth — **DONE** (E2E 23/23).
- Surescripts connectivity monitoring (net-check only, no native integration) — **DONE** (E2E 23/23).
- VA facilities (VistA/CPRS) — HL7v2 tap profile — **DONE** (E2E 23/23).
- IHS/tribal (RPMS) — HL7v2 tap profile — **DONE** (E2E 23/23).
- Healthland, MEDHOST, Altera, NextGen, Veradigm, Azalea, Juno, Netsmart, WellSky, Sunquest/SCC — **NOT STARTED** (deliberately deferred; profiles only, when a real customer justifies each).
- Federal Oracle Health profile (VA/IHS Cerner deployment) — **NOT STARTED** (deliberately flagged premature in the doc).

### §4 — interface engines beyond Mirth
- Rhapsody / Cloverleaf / Iguana admin-API readers — **NOT STARTED** (opportunistic-by-design; build only where a real deployment exposes the API).

### §11/§12 — interface topology visibility
- Channel registry (site/channel/engine/source/destination) — **PARTIAL**. The registry stores channel_id + display_name + engine and is tested, but it does NOT yet carry `source_system`/`destination_system` — the two fields that turn a channel list into a true graph. The console's per-site graph derives edges from a fixed layout, not from those two fields.
- `channel_id` optional on canonical event — **DONE** (topology 6/6).
- Per-site topology view — **DONE**.
- Cross-site rollup (ops-manager/support-technician only) — **DONE** (RBAC-gated).
- Clicking an edge shows last-message time / recent error count / connector state — **PARTIAL**. The detail panel shows status/detail/time-in-state/co-occurring signals, but does not yet surface last-message-time or a recent-error-count from the Mirth reader.

---

## NETBOX_CONTROLS_AND_IDENTITY.md

### §1/§3 — site network controls as first-class critical services
- WAN/ISP circuit health (dual-path, failover detection) — **NOT STARTED**.
- Core firewall/router reachability as a first-class service — **NOT STARTED**.
- DNS/DHCP health — **NOT STARTED**.
- Wireless AP health — **NOT STARTED**.
- Site-to-site VPN tunnel health — **NOT STARTED**.
- Backup/DR job status read — **NOT STARTED**.
- TLS certificate expiration as a first-class service — **PARTIAL**. The L2 TLS check already captures cert validity/expiry on checked endpoints (net_checks), but there's no dedicated "cert expiration" critical-service entry or per-site cert-expiry reporting.
- AV/EDR agent check-in — **NOT STARTED**.

### §2 — Action Registry
- Per-site whitelist of approved action types + session-gating + audit — **NOT STARTED** (the remote-support session broker it builds on exists; the registry itself does not).

### §4 — Microsoft 365 / Entra ID
- Phase 1 read-only account-health visibility (User/AuditLog/Organization/Reports .Read.All) — **NOT STARTED**. (`netbox-agent/lib/graph.js` is the *earlier* Step-1 Graph security-signal work — admin-create + after-hours sign-in — not this phase's account-health surface.)
- Phase 2 gated non-admin password reset — **NOT STARTED** (explicitly deferred by the doc).
- Okta / Google Workspace providers — **NOT STARTED** (explicitly "don't build ahead of demand").

---

## NETBOX_CLOUD_ARCHITECTURE_AWS.md

- AWS Organization + three accounts (prod, sim/staging, security/log-archive) — **NOT STARTED**.
- IoT Core + step-ca CA registration (device registry ingestion) — **NOT STARTED**.
- RDS PostgreSQL Multi-AZ (+TimescaleDB check/partitioning fallback) — **NOT STARTED**.
- Cognito user pools with the five RBAC groups — **NOT STARTED**.
- ECS Fargate control-plane API + ingestion behind ALB — **NOT STARTED**.
- IoT Jobs OTA rollout over the RAUC bundle — **NOT STARTED**.
- IoT Secure Tunneling + Action Registry session layer — **NOT STARTED**.
- QLDB or S3-Object-Lock audit export — **NOT STARTED**.
- Step Functions escalation engine — **NOT STARTED**.
- Sim/staging synthetic device fleet — **NOT STARTED**.
- HIPAA BAA / eligible-services confirmation — **NOT STARTED** (process, not code).

---

## NETBOX_TOPOLOGY_AND_TROUBLESHOOTING_MEMORY.md

- Geographic fleet map (lat/lng on site profile, pins colored by status, same RBAC) — **NOT STARTED**.
- `incident_signature` capture on incident open — **NOT STARTED**.
- `resolution_record` close-incident UI flow — **NOT STARTED**.
- Troubleshooting-memory matching function (deterministic weighted overlap) — **NOT STARTED**.
- "Similar past incidents" panel + cold-start-honest empty state — **NOT STARTED**.
- Ticketing Tier 0 (copy-paste block + "send as email" via existing SES/SendGrid) — **NOT STARTED**.
- Ticketing Tier 1 (generic REST adapter) — **NOT STARTED** (explicitly deferred until a customer names a system).

---

## NETBOX_SPEC_INDEX.md
- Reading/hand-off map for the five specs — **DONE** (it's a doc; it's present and read).

---

## Blocking gaps

Real dependencies where a NOT-STARTED/PARTIAL item blocks a DONE item's *completion* (not just "stuff left"):

- **Postgres storage (PARTIAL) blocks the AWS control-plane work (NOT STARTED).** The AWS doc's RDS/Cognito/Fargate steps all assume the control plane's data layer; today it's SQLite. The AWS phase can't be honestly demoed until the storage target is settled.
- **React frontend (PARTIAL) blocks nothing functionally but is a spec-named surface.** The console works as vanilla HTML, so this is a tech-choice gap, not a functional blocker — flagged, not a dependency.
- **Secure-Tunneling transport (NOT STARTED) is the real remote-support byte pipe.** The broker (DONE) models the session; the actual tunnel transport is unbuilt, so the "time-limited outbound tunnel" claim is proven at the session-record level only.
- **Live SaaS credentials for alert delivery (PARTIAL) block any real-world escalation proof.** The engine and escalation timing are fully tested; an actual SMS/email/webhook delivery has never run.

No DONE item is *broken* by an unbuilt dependency — the current system is internally consistent. These are the seams where the next phase's honesty depends on work that doesn't exist yet.

## Cheapest next wins

Small, unblocked, worth doing first:

- **AWS Organization + three accounts** (`CLOUD_ARCHITECTURE_AWS` §6 step 1) — the doc is explicit that nothing else in it should build before this, and it's foundational like step-ca was; zero new device/EHR code.
- **Channel registry: add `source_system`/`destination_system`** (`EHR_INTEGRATIONS` §11) — two columns + populate from the Mirth reader; turns the channel list into a true graph and unblocks the edge-detail panel's missing fields.
- **TLS-cert-expiration as a first-class critical service** (`CONTROLS_AND_IDENTITY` §3) — the L2 check already captures expiry on every checked endpoint; surfacing it as a named service is a thin slice over existing code.
- **Ticketing Tier 0 copy-paste block** (`TOPOLOGY_…_MEMORY` §3) — renders data the incident already carries; no new backend, and it covers every hospital incl. inbox-only sites.
- **SES email sender alongside SendGrid** (`BUILD_SPEC` §6) — the deliver.js email path is SendGrid-only today; the spec names SES *or* SendGrid, so this is a one-function addition on a proven rail, and closes the "SES not implemented" note.

---

*Audit produced read-only. No source, config, or test file was modified to produce this
checklist. The Phase-3 QEMU acceptance was re-run against a freshly built image during the
audit (an earlier failure was a Docker Desktop stale-mount-handle artifact on the Windows
host, cleared by restarting Docker — an environment issue, not a repo defect).*
