# Beacon Relay — Status (stopping point)

> **Renamed:** this project was formerly **Netbox**; it is now **Beacon Relay**. The rename
> is a mechanical rebrand only (no architecture/logic/scope change). The GitHub repo
> rename is a manual step — see the completion note at the bottom.

Written at a deliberate stopping point, after a credit-limited break call. This file is
the honest "what's actually true right now" record — nothing in it is a plan or a
projection; every "built" line below has a test suite that currently passes and proves it.

**Current commit on `main`:** `63e9a70` (agent/md-sync-2026-09-22; HEAD includes channel-registry, TLS-cert-expiration, firewall, DNS, WAN/ISP circuit health, ticketing Tier-0, SES email-sender, geographic fleet-map, troubleshooting-memory work, and PHI guard).

> **History note (read before pulling into another clone):** history was rewritten on
> 2026-09-02 to strip large build-artifact binaries (two ~1 GB disk images and a ~440 MB
> rootfs.ext4) that had been committed inside the earlier `feat(phase3)` commit and were
> making `git push` time out. The rewritten phase-3 commit is `0ef3144`; the original
> hash was `1780722`. Any other clone must do a **fresh fetch + reset**, not a normal
> pull — the old hashes are gone.

---

## 1. What's actually built and passing tests right now

Mapped to `BEACON_RELAY_BUILD_SPEC.md` Section 8 phases and the companion docs. "Built" here
means: real code exists, it runs, and a named test suite passes against it as of this
commit. Nothing is listed as built on the strength of a prior prose summary.

### Built and green

- **Phase 1 — schema & PKI foundation** (`BUILD_SPEC` §8.1). Canonical event schema
  (`schemas/beacon_relay_event.schema.json` + generated TS/Python types), step-ca private CA,
  device enrollment → quarantine → confirm flow. Proven by the device-sim suite and by
  the QEMU acceptance harness (`vm-harness/acceptance.sh`).
- **Phase 2 — minimal control plane** (`BUILD_SPEC` §8.2). Device registry, mTLS-gated
  ingestion API with quarantine enforcement, schema validation, minimal console.
- **Phase 3 — the Configurator** (`BUILD_SPEC` §8.3, §2; `EHR_INTEGRATIONS` §1). Verified
  end to end this pass: signed RAUC bundle builds and verifies (`rauc bundle` + `rauc info
  --keyring` VERIFY OK); Configurator `releases` / `save` / `flash` with the unmissable
  confirm-target gate; flash + post-write sha256 verify; first-boot → TPM-seal → quarantine
  → confirm → active heartbeat in QEMU (`ACCEPTANCE_PASS`); standalone install file boots
  identically via dd; LUKS on the data partition confirmed by post-boot `luksDump`.
- **Phase 4 — device agent** (`BUILD_SPEC` §8.4, §3). The continuous monitoring loop
  (`lib/monitor_loop.js`): scheduled checks, last-successful-check-per-monitor persisted to
  /data, and the ordered multi-step outage confirmation (`lib/outage_confirm.js`: retry
  locally → second independent dependency → primary WAN path → LTE failover) before any
  escalated event fires. Self-monitoring (`lib/self_monitor.js`): heartbeat, clock sync,
  disk, DNS, cellular modem, control-plane reachability — each its own monitor. Downtime
  mode (`lib/downtime.js`): a local web UI on the device serving the cached contact tree /
  vendor numbers / recovery priorities / runbooks from /data, proven to keep serving with
  the control plane severed and to catch back up on reconnect.
- **Phase 5 — HL7/MLLP sidecar** (`BUILD_SPEC` §8.5, §3). `sidecar/mllp_tap.py`: passive
  metadata-only extraction (type/trigger, direction, timestamp, ACK/NACK, latency, size),
  per-device keyed HMAC-SHA256 correlation token. The `phi_mode: false` guarantee is
  structural (raw body never retained past metadata extraction) and was attacked directly
  in the security test — the adversarial test FAILS to recover the payload.
- **EHR/EMR integration layer** (`EHR_INTEGRATIONS` §9 steps 1–4, §10). Four protocol
  adapters — FHIR R4 read-only (SMART backend-services, capability statement + scoped
  synthetic read), Mirth Connect admin-API reader (status only, never message content),
  generic network checks (L0/L1/L2), and the `ehr_check` orchestrator — plus config
  profiles for MEDITECH (Expanse, Magic, Client-Server), TruBridge/Evident, Epic Community
  Connect, Oracle Health CommunityWorks, athenahealth, Surescripts connectivity, VA
  (VistA/CPRS), and IHS (RPMS). Tested against a public FHIR R4 sandbox and stubs.
- **Interface topology visibility** (`EHR_INTEGRATIONS` §11/§12). Channel registry
  now carries `site_id`, `source_system`, and `destination_system` so channels can be
  rendered as graph edges; the Mirth/NextGen reader exposes those endpoints; per-site
  topology view, cross-site rollup gated to operations-manager/support-technician, and
  full-status detail panel all return them. Rule-based detail panel — no AI narration,
  per the §11 guardrail.
- **TLS certificate expiration as a first-class critical service** (`CONTROLS_AND_IDENTITY`
  §3). The existing L2 TLS handshake now also emits a metadata-only `cert_expiration`
  check_result (subject CN, issuer CN, valid_from, valid_to — no cert bytes or keys).
  Status mapping: expired -> `down`, expiring within 30 days -> `degraded`, valid ->
  `verified_ready`. Added to the canonical schema `service` enum and the Fleet Console
  critical-service register. Covered by dedicated unit checks for expired / soon / valid.
- **Core firewall/router reachability as a first-class critical service** (`CONTROLS_AND_IDENTITY`
  §3). `firewall` added to the canonical schema `service` enum and the critical-service
  register; existing generic TCP/TLS net checks can target a gateway with `service: 'firewall'`.
  No new adapter needed — the network-check rail is reused.
- **DNS health as a first-class critical service** (`CONTROLS_AND_IDENTITY` §3). `dns` added to
  the schema `service` enum and critical-service register; new `dnsCheck` adapter queries a
  site-configured resolver for a known-good hostname and reports `active`/`down`. DHCP health
  is still inferred from monitored endpoints, not a direct check.
- **WAN/ISP circuit health as a first-class critical service** (`CONTROLS_AND_IDENTITY`
  §1/§3). `wan` added to the schema `service` enum and critical-service register; new
  `runWanCheck` adapter tests each configured circuit against external targets, reports
  `reachable` when healthy, `degraded` when the primary circuit is down but a backup circuit
  has taken over (`observed.failover = true`), and `down` when both fail. Falls back from
  ICMP ping to TCP when the image does not ship a ping binary.
- **Alerting & escalation engine** (`BUILD_SPEC` §6). Severity tiers, owner/contact
  mapping, plain-language impact statements (transport jargon rejected at the door),
  runbook attachment, required ack with automatic escalation on timeout, suppression/
  maintenance windows. Delivery rails (Twilio SMS/voice, SendGrid email, SES email via
  `@aws-sdk/client-sesv2`, Slack/Teams webhook) wired as injected senders.
- **RBAC completeness** (`BUILD_SPEC` §5). All five roles (support technician, customer IT
  admin, operations manager, security auditor, read-only executive) with per-route
  allow/deny proven.
- **Audit log** (`BUILD_SPEC` §5). Append-only, immutability enforced by database triggers
  (UPDATE/DELETE raise), not by policy. Remote-support sessions, alert lifecycle, and RBAC
  denies are all written to it.
- **Remote-support session broker** (`BUILD_SPEC` §7). Admin requests → device picks up a
  JIT token over its existing outbound mTLS → opens an outbound, time-limited tunnel.
  Sessions close at their TTL (sweep-enforced); every session is audit-logged.
- **Ticketing Tier 0 export** (`TOPOLOGY_AND_TROUBLESHOOTING_MEMORY` §3). `GET
  /api/alerts/:id/ticket` returns plain-text and Markdown copy-paste blocks from the
  alert's existing fields; `POST .../ticket/email` sends the block via the existing
  SendGrid pipe. Works with any inbox/ticketing system, no vendor API. RBAC-gated and
  metadata-only (no raw events, payloads, keys, or cert contents).
- **Geographic fleet map** (`TOPOLOGY_AND_TROUBLESHOOTING_MEMORY` §1). `sites` table
  stores `lat`/`lng`/`name`; enrollment tokens accept optional site metadata;
  `GET /api/fleet/map` returns one pin per site with overall status computed as the
  worst of the site's critical-service statuses (unknown is the baseline, not a
  downgrade). RBAC mirrors the rollup gate: operations-manager/support-technician
  see the whole fleet; customer-it-admin must supply their own `site_id` and sees
  only that pin. `public/fleet.html` renders the pins without external map libraries.
  Covered by the alerting/RBAC suite.
- **Troubleshooting memory + similar-past-incidents panel** (`TOPOLOGY_AND_TROUBLESHOOTING_MEMORY`
  §2). `incident_signature` is captured automatically when an alert opens, from
  recorded events only (status transition, tier, co-occurring degraded/down signals,
  time-of-day bucket, interface engine). `POST /api/alerts/:id/close` captures the
  human-filled `resolution_record`. `GET /api/alerts/:id/similar` runs a deterministic
  weighted-overlap match against closed incidents and returns ranked matches with
  root-cause/action distributions and per-incident links — or an empty list when
  nothing clears the threshold. No LLM, no generated narration. Covered by the
  alerting/RBAC suite.
- **RAUC OTA staged rollout path** (`BUILD_SPEC` §8.7). Control-plane rollout policy
  (`rollouts` table) supports `dev`/`test`/`pilot`/`broad` stages with a 0-100%
  percentage; `deviceInRollout` assigns devices deterministically by hashing
  `device_id:version`; `/api/releases/latest` gates visibility so a device outside the
  rollout sees no update. The update client passes `device_id`, verifies the bundle
  signature before install, runs a post-install health check, and automatically rolls
  back (RAUC `mark-bad`) when the check fails; passing the check calls `mark-good`.
  Every rollout action is audit-logged. Covered by `scripts/test_update_client.js` and
  `scripts/test_ota_rollout.js`.
- **Rootfs/agent-source integrity** (this pass's earlier fix). `pipeline/build.js` copies
  the repo-root `beacon-relay-agent/` into the staged tree at build time and hard-fails if any
  required agent file is missing; `pipeline/stages/30-agent.sh` re-gates on presence inside
  the image. The manually-maintained duplicate tree is gone from git.

### `BEACON_RELAY_KIMI_FIXES.md` items this pass

- **KF6 — Graph Authorization header** (`107ac2f`). Fixed `beacon-relay-agent/lib/graph.js` so GET requests to Microsoft Graph send `authorization: Bearer <token>` instead of the raw token. Removed the dead `authorization` property on the returned client object. Added an assertion in `scripts/test_step1_signals.js` and set mock tenant credentials so the Graph path actually executes in the test.
- **KF7 — Dead `enroll.js` / node-forge** (`a68b0f5`). Removed `beacon-relay-agent/lib/enroll.js` (unused, imported `node-forge` which is not on-device) and removed it from the required-files lists in `pipeline/build.js` and `pipeline/stages/30-agent.sh`.
- **KF8 — Dead `sfdisk.script` / `partition.env` flows** (`2b1d01d`). Deleted `pipeline/gen_sfdisk.js` and its call in `pipeline/build.js`; removed `source /tmp/partition.env` from `pipeline/stages/40-rauc.sh`; converted `pipeline/stages/20-partition.sh` to a partition-map validation stage; removed the `out/**/sfdisk.script` line from `.gitignore`.
- **KF3 — Control-plane host bind/publish** (`c975e84`). `BIND_HOST` env var controls the listen address (safe default `127.0.0.1` in code); `docker-compose.yml` sets `BIND_HOST=0.0.0.0` for compose-internal reachability. `CONTROL_PLANE_HOST_PORT` env var configures the host-side published port; default remapped from `9100` to `10443` because Windows reserves `9100` in excluded range `9035-9134`. Host-side tests/seed default to `localhost:10443`. Verified with E2E 23/23 and alerting/RBAC 33/33.

### Speced but NOT started (do not assume any of this exists)

- **AWS hosting of the control plane** (`CLOUD_ARCHITECTURE_AWS` §6): AWS Organization +
  three accounts, IoT Core CA registration, RDS Multi-AZ + Cognito groups, ECS Fargate
  services, IoT Jobs (OTA), Secure Tunneling, QLDB/S3-Object-Lock audit export, Step
  Functions escalation. None of it is built.
- **Network controls + Action Registry + Microsoft Graph Phase 1** (`CONTROLS_AND_IDENTITY`
  §6): wireless/VPN, backup/EDR status reads, the Action Registry whitelist mechanism, and
  the read-only M365 account-health adapter. The existing `beacon-relay-agent/lib/graph.js`
  is only the earlier Step-1 Graph security-signal work, not this phase. TLS certificate
  expiration, firewall, DNS, and WAN/ISP health are now built separately.
- **Ticketing Tier-1 generic REST adapter** (`TOPOLOGY_AND_TROUBLESHOOTING_MEMORY` §3).
  Not started — explicitly deferred until a real customer names a specific system.
- **Remaining EHR vendor profiles** (`EHR_INTEGRATIONS` §5 rows 5–15): Healthland, MEDHOST,
  Altera, NextGen, Veradigm, Azalea, Juno, Netsmart, WellSky, Sunquest/SCC. Deliberately
  deferred — profiles only, when a real customer site justifies each.
- **PHI-mode toggle + hardware lifecycle tooling** (`BUILD_SPEC` §8.9). Not started.

---

## 2. Test suite counts as of this commit

| Suite | Command | Result |
|---|---|---|
| Documentation audit | `node audit_docs.cjs .` | 89 files scanned, 0 missing header, 0 missing doc comment, 213 exports |
| EHR adapters unit | `node scripts/test_ehr_unit.js` | 27/27 |
| Device agent loop (monitor + self-monitor + downtime) | `node scripts/test_agent_loop.js` | 11/11 |
| Step 1 Graph signals | `node scripts/test_step1_signals.js` | Graph path emits 2 security_signal events; Bearer prefix asserted |
| HL7 sidecar security (incl. adversarial payload-recovery, must fail) | `python scripts/test_sidecar_security.py` | 24/24 |
| Topology (channel registry, RBAC rollup gate) | `node --test scripts/test_topology.js` | 6/6 |
| EHR E2E through the real stack (incl. feed-down, public sandbox) | `node scripts/test_ehr_e2e.js` | 23/23 |
| Alerting / RBAC / audit / support broker / ticketing Tier 0 / SES skip / PHI guard / fleet map / troubleshooting memory | `node scripts/test_alerting_rbac_audit_support.js` | 68/68 |
| OTA update client (signed bundles, staged rollout, rollback) | `node scripts/test_update_client.js` | 9/9 |
| OTA staged rollout control-plane policy + audit | `node scripts/test_ota_rollout.js` | 10/10 |
| Phase 3 QEMU acceptance | `vm-harness/acceptance.sh` | **not re-run this pass** — blocked by missing KVM in Docker Desktop on Windows; see `.agent/attempts.md` |

Prereqs for the E2E-style suites: `docker compose up -d step-ca control-plane` first. `step-ca` is healthy; control-plane host port is remapped to `10443` because Windows reserves `9100`.
The QEMU acceptance run (`vm-harness/acceptance.sh`) is the Phase-3 proof and needs the
built image plus the harness container.

---

## 3. Known issues, TODOs, and honest shortcuts (the part to read first)

- **The device image's Node is v18** (from Debian apt in the image), while the host and
  control-plane run v24. Nothing breaks today, but the two runtimes have drifted; if the
  agent ever uses a v24-only API it will work in tests and die on-device. Worth pinning
  deliberately rather than drifting.
- **The EHR/FHIR/Mirth adapters call site-local endpoints with `rejectUnauthorized:false`**
  (documented in `lib/http_json.js`). This matches the existing agent's bootstrap posture,
  but the real hardening — pinning per-site/CA roots the way the step-ca bootstrap pin does
  — is a deliberate follow-up, not done.
- **The Mirth reader is verified against a faithful stub, not a live Mirth 3.x instance.**
  Needs one real-instance check at the first pilot site before calling it production-proven.
- **RBAC is a structural stub.** Phase 2 has no auth; `role` arrives as a request attribute
  and is checked against the map in `control-plane/src/rbac.js`. A real identity layer
  (Cognito, per the AWS doc) must supply the principal's role — the gate positions are
  already in the routes, but do not mistake the stub for real auth.
- **The support "tunnel" is modeled, not a real byte pipe.** The broker, JIT token, TTL
  enforcement, and audit logging are real and tested; the actual tunneled data path is a
  session record, not an SSH/websocket forwarder. The real transport is meant to be AWS IoT
  Secure Tunneling per `CLOUD_ARCHITECTURE_AWS` §1 — that substitution is by design, not a gap.
- **Alert delivery is wired but unauthenticated to real SaaS in this repo** — Twilio,
  SendGrid, SES (via `@aws-sdk/client-sesv2`), and webhook senders are real code, but run
  against no live credentials in tests; the delivery path is proven by shape/skip behavior,
  not by a real SMS or email leaving the building.
- **The Epic Community Connect profile ships with its FHIR check `enabled: false` by
  default** (parent-org API grant is not guaranteed) — that's a deliberate product decision,
  not a bug; the `unknown`-not-`down` auth mapping exists because of it.
- **SQLite is the dev store; Postgres is the spec's target.** The schema is written so the
  migration is a driver swap, but the swap has not been done and the RDS/TimescaleDB
  decision (per the AWS doc) is untested.
- **`git push` history was rewritten** — see the note at the top. Clones need fetch+reset.
- **Host port 9100 is inside a Windows/Hyper-V excluded port range (`9035-9134`) on the current build machine.** Worked around by remapping the published host port to `10443` in `docker-compose.yml` and updating host-side test/seed defaults. The container port remains `9100` for compose-internal services.
- **QEMU acceptance cannot run in Docker Desktop on Windows because `/dev/kvm` is unavailable.** `vm-harness/acceptance.sh` hardcodes `-enable-kvm`; two attempts failed identically. Options: run on a Linux host with KVM, modify the harness to fall back to TCG with longer timeouts, or use a WSL2/Docker setup that exposes KVM. See `.agent/attempts.md`.
- A handful of test/harness scripts write state to `os.tmpdir()` on the host (monitor
  state, downtime cache, the tamper-test DB). They clean up, but a killed process can leave
  a temp file; harmless, and they're all gitignored paths or temp dirs.

---

## 4. Single next recommended step

**Start `BEACON_RELAY_CLOUD_ARCHITECTURE_AWS.md` §6, step 1: stand up the AWS Organization with
the three accounts (prod, sim/staging, security/log-archive).** The doc is explicit that
nothing else in it should be built before that exists, and every later hosting step
(IoT Core CA registration, RDS+Cognito, ECS Fargate) depends on the account boundary. It is
the lowest-risk, highest-leverage next move, and it requires no new device or EHR work.

(The runner-up, if AWS access isn't ready yet: the network-controls phase in
`BEACON_RELAY_CONTROLS_AND_IDENTITY.md` §6 step 1 — register the WAN/firewall/DNS/TLS-cert checks as
first-class critical services, which reuses the already-built generic network-check adapter
with no new adapter code.)

---

## Rename note (this pass)

Rebranded Netbox → Beacon Relay as a mechanical rename only. All seven test suites were
re-run after the rename and are green at the same counts as before (see §2). The GitHub
repository itself was NOT renamed in this pass — `gh` was not authenticated, so the repo
rename is a **manual step** (GitHub repo Settings → Rename to `beacon-relay`, then
`git remote set-url origin https://github.com/<owner>/beacon-relay.git`). The local remote
is deliberately left on the old, working URL until then.
