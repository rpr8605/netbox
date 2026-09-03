# Netbox — Status (stopping point)

Written at a deliberate stopping point, after a credit-limited break call. This file is
the honest "what's actually true right now" record — nothing in it is a plan or a
projection; every "built" line below has a test suite that currently passes and proves it.

**Current commit on `main`:** `3c29426` (pushed to `origin/main`, in sync).

> **History note (read before pulling into another clone):** history was rewritten on
> 2026-09-02 to strip large build-artifact binaries (two ~1 GB disk images and a ~440 MB
> rootfs.ext4) that had been committed inside the earlier `feat(phase3)` commit and were
> making `git push` time out. The rewritten phase-3 commit is `0ef3144`; the original
> hash was `1780722`. Any other clone must do a **fresh fetch + reset**, not a normal
> pull — the old hashes are gone.

---

## 1. What's actually built and passing tests right now

Mapped to `NETBOX_BUILD_SPEC.md` Section 8 phases and the companion docs. "Built" here
means: real code exists, it runs, and a named test suite passes against it as of this
commit. Nothing is listed as built on the strength of a prior prose summary.

### Built and green

- **Phase 1 — schema & PKI foundation** (`BUILD_SPEC` §8.1). Canonical event schema
  (`schemas/netbox_event.schema.json` + generated TS/Python types), step-ca private CA,
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
- **Interface topology visibility** (`EHR_INTEGRATIONS` §11/§12). Channel registry,
  optional `channel_id` on the canonical schema, per-site topology view, cross-site rollup
  gated to operations-manager/support-technician. Rule-based detail panel — no AI
  narration, per the §11 guardrail.
- **Alerting & escalation engine** (`BUILD_SPEC` §6). Severity tiers, owner/contact
  mapping, plain-language impact statements (transport jargon rejected at the door),
  runbook attachment, required ack with automatic escalation on timeout, suppression/
  maintenance windows. Delivery rails (Twilio SMS/voice, SendGrid email, Slack/Teams
  webhook) wired as injected senders.
- **RBAC completeness** (`BUILD_SPEC` §5). All five roles (support technician, customer IT
  admin, operations manager, security auditor, read-only executive) with per-route
  allow/deny proven.
- **Audit log** (`BUILD_SPEC` §5). Append-only, immutability enforced by database triggers
  (UPDATE/DELETE raise), not by policy. Remote-support sessions, alert lifecycle, and RBAC
  denies are all written to it.
- **Remote-support session broker** (`BUILD_SPEC` §7). Admin requests → device picks up a
  JIT token over its existing outbound mTLS → opens an outbound, time-limited tunnel.
  Sessions close at their TTL (sweep-enforced); every session is audit-logged.
- **Rootfs/agent-source integrity** (this pass's earlier fix). `pipeline/build.js` copies
  the repo-root `netbox-agent/` into the staged tree at build time and hard-fails if any
  required agent file is missing; `pipeline/stages/30-agent.sh` re-gates on presence inside
  the image. The manually-maintained duplicate tree is gone from git.

### Speced but NOT started (do not assume any of this exists)

- **AWS hosting of the control plane** (`CLOUD_ARCHITECTURE_AWS` §6): AWS Organization +
  three accounts, IoT Core CA registration, RDS Multi-AZ + Cognito groups, ECS Fargate
  services, IoT Jobs (OTA), Secure Tunneling, QLDB/S3-Object-Lock audit export, Step
  Functions escalation. None of it is built.
- **Network controls + Action Registry + Microsoft Graph Phase 1** (`CONTROLS_AND_IDENTITY`
  §6): WAN/firewall/DNS/TLS-cert critical-service entries, wireless/VPN, backup/EDR status
  reads, the Action Registry whitelist mechanism, and the read-only M365 account-health
  adapter. The existing `netbox-agent/lib/graph.js` is only the earlier Step-1 Graph
  security-signal work, not this phase.
- **Fleet map + troubleshooting memory + ticketing export**
  (`TOPOLOGY_AND_TROUBLESHOOTING_MEMORY` §5): geographic fleet map (lat/lng), the
  deterministic case-based "similar past incidents" memory, and ticketing Tier-0
  (copy-paste block + send-as-email). Not started.
- **Remaining EHR vendor profiles** (`EHR_INTEGRATIONS` §5 rows 5–15): Healthland, MEDHOST,
  Altera, NextGen, Veradigm, Azalea, Juno, Netsmart, WellSky, Sunquest/SCC. Deliberately
  deferred — profiles only, when a real customer site justifies each.
- **RAUC OTA staged rollout path** (`BUILD_SPEC` §8.7): the bundle builds and signs, but the
  dev → test-device → pilot-group → broad rollout with rollback-verified-intentionally-
  broken-build is not built. The `rauc bundle` step is verified; the rollout machinery is not.
- **PHI-mode toggle + hardware lifecycle tooling** (`BUILD_SPEC` §8.9). Not started.

---

## 2. Test suite counts as of this commit

| Suite | Command | Result |
|---|---|---|
| Documentation audit | `node audit_docs.cjs .` | 62 files scanned, 0 missing header, 0 missing doc comment, 137 exports |
| EHR adapters unit | `node scripts/test_ehr_unit.js` | 16/16 |
| Device agent loop (monitor + self-monitor + downtime) | `node scripts/test_agent_loop.js` | 10/10 |
| HL7 sidecar security (incl. adversarial payload-recovery, must fail) | `python scripts/test_sidecar_security.py` | 18/18 |
| EHR E2E through the real stack (incl. feed-down, public sandbox) | `node scripts/test_ehr_e2e.js` | 23/23 |
| Alerting / RBAC / audit / support broker | `node scripts/test_alerting_rbac_audit_support.js` | 23/23 |
| Topology (channel registry, RBAC rollup gate) | `node --test scripts/test_topology.js` | 6/6 |

Prereqs for the E2E-style suites: `docker compose up -d step-ca control-plane` first.
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
- **Alert delivery is wired but unauthenticated to real SaaS in this repo** — Twilio/
  SendGrid/webhook senders are real code but run against no live credentials in tests; the
  delivery path is proven by shape, not by a real SMS leaving the building.
- **The Epic Community Connect profile ships with its FHIR check `enabled: false` by
  default** (parent-org API grant is not guaranteed) — that's a deliberate product decision,
  not a bug; the `unknown`-not-`down` auth mapping exists because of it.
- **SQLite is the dev store; Postgres is the spec's target.** The schema is written so the
  migration is a driver swap, but the swap has not been done and the RDS/TimescaleDB
  decision (per the AWS doc) is untested.
- **`git push` history was rewritten** — see the note at the top. Clones need fetch+reset.
- A handful of test/harness scripts write state to `os.tmpdir()` on the host (monitor
  state, downtime cache, the tamper-test DB). They clean up, but a killed process can leave
  a temp file; harmless, and they're all gitignored paths or temp dirs.

---

## 4. Single next recommended step

**Start `NETBOX_CLOUD_ARCHITECTURE_AWS.md` §6, step 1: stand up the AWS Organization with
the three accounts (prod, sim/staging, security/log-archive).** The doc is explicit that
nothing else in it should be built before that exists, and every later hosting step
(IoT Core CA registration, RDS+Cognito, ECS Fargate) depends on the account boundary. It is
the lowest-risk, highest-leverage next move, and it requires no new device or EHR work.

(The runner-up, if AWS access isn't ready yet: the network-controls phase in
`CONTROLS_AND_IDENTITY.md` §6 step 1 — register the WAN/firewall/DNS/TLS-cert checks as
first-class critical services, which reuses the already-built generic network-check adapter
with no new adapter code.)
