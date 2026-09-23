# Beacon Relay — Readiness Audit

Audit date: 2026-09-23
Audited against commit: `0d0e22c` (agent/md-sync-2026-09-22 branch)

This document maps ten readiness areas to DONE / PARTIAL / MISSING, with the
actual file paths and test names that provide evidence. No guessing: if evidence
could not be found, the area is marked MISSING and the gap is stated.

Status definitions:
- **DONE** — real code/docs/tests exist and were verified this session.
- **PARTIAL** — something exists, but a spec'd or security-critical piece is
  stubbed, mocked, or unverified.
- **MISSING** — no evidence found in the repo.

---

## 1. Security approval pack

**Status: MISSING**

Evidence: none found.

What would be needed:
- A `docs/SECURITY_MODEL.md` or equivalent threat model.
- A formal risk assessment / HIPAA security rule mapping.
- A penetration-test plan or report.
- Vendor/security questionnaire responses.

What exists instead:
- Security design intent is scattered across specs (`docs/specs/BEACON_RELAY_BUILD_SPEC.md`
  §1, §5, §7; `docs/specs/BEACON_RELAY_CONTROLS_AND_IDENTITY.md`; `docs/specs/BEACON_RELAY_CLOUD_ARCHITECTURE_AWS.md`).
- An independent code review (`Beacon_Relay_Code_Review_2026-09-23.md`) lists
  critical/high findings and recommends creating `docs/SECURITY_MODEL.md` as
  the core of the approval pack.
- `.agent/phi-mode-design.md` touches contractual BAA references, but it is a
  design note, not an approval pack.

Gap: no consolidated security approval pack document exists.

---

## 2. Device identity / zero-trust (incl. TPM-backed keys)

**Status: PARTIAL**

Evidence:
- Device enrollment → quarantine → confirm flow is implemented and tested:
  - `control-plane/src/routes/enroll.js`
  - `beacon-relay-agent/provision.js`
  - `scripts/test_ehr_e2e.js` (23/23 E2E checks include real PKI enrollment)
- step-ca private CA issues short-lived device certs:
  - `docker-compose.yml` step-ca service
  - `pki-config/entrypoint.sh`
  - `scripts/pki_seed.js`
- TPM sealing intent and LUKS fallback are documented:
  - `docs/specs/BEACON_RELAY_BUILD_SPEC.md` §1, §2, §8.1
  - `docs/specs/BEACON_RELAY_STATUS.md` §1 Phase 3 claims TPM-seal → quarantine → confirm
- Device-side cert/key handling:
  - `beacon-relay-agent/lib/tpm.js`
  - `beacon-relay-agent/agent.js`

Gaps (from independent review and code inspection):
- **No real zero-trust verification of the server by the device.**
  `beacon-relay-agent/agent.js` defaults `rejectUnauthorized: false` and the
  mTLS path does not pin the step-ca root, so the device accepts any server
  cert (`Beacon_Relay_Code_Review_2026-09-23.md` H1).
- **TPM key is generated in software and imported into the TPM**, not generated
  inside the TPM (`Beacon_Relay_Code_Review_2026-09-23.md` M4,
  `beacon-relay-agent/lib/tpm.js`).
- QEMU acceptance (the Phase-3 proof of TPM/LUKS sealing) is blocked in this
  environment; see `.agent/attempts.md`.

Because the critical server-verification and true TPM-backed-generation gaps
exist, this area cannot be marked DONE.

---

## 3. Fleet management security (MFA, JIT access, no standing SSH)

**Status: PARTIAL**

Evidence:
- Remote-support session broker with JIT tokens, TTL enforcement, and audit
  logging:
  - `control-plane/src/routes/support.js`
  - `control-plane/src/db.js` (`createSupportSession`, `expiredSupportSessions`)
  - `scripts/test_alerting_rbac_audit_support.js` D1–D6 pass
- No standing SSH: design explicitly says "outbound-only session broker" and
  "no inbound ports" (`docs/specs/BEACON_RELAY_BUILD_SPEC.md` §7, §8.2).
- RBAC role/permission map exists for five roles:
  - `control-plane/src/rbac.js`
  - `scripts/test_alerting_rbac_audit_support.js` B1–B17 pass

Gaps:
- **No real authentication or MFA.** Roles are passed as query/body parameters
  (`?role=operations-manager`), not derived from an authenticated principal
  (`Beacon_Relay_Code_Review_2026-09-23.md` C1, `docs/specs/BEACON_RELAY_STATUS.md`
   "Known issues").
- **Several routes have no permission gate at all** (`Beacon_Relay_Code_Review_2026-09-23.md` H3).
- AWS Cognito with MFA is spec'd (`docs/specs/BEACON_RELAY_CLOUD_ARCHITECTURE_AWS.md`) but
  not implemented.

Because real auth/MFA is missing and route gates are incomplete, this area is
PARTIAL.

---

## 4. Signed OTA + rollback + SBOM/CVE monitoring

**Status: PARTIAL**

Evidence:
- Signed RAUC bundle pipeline builds and verifies:
  - `pipeline/build.js`
  - `pipeline/stages/40-rauc.sh`
  - `scripts/test_update_client.js` U2–U4 pass
- Staged rollout policy (dev → test → pilot → broad), deterministic device
  assignment, audit logging:
  - `control-plane/src/db.js` (`createRollout`, `activateRollout`, `deviceInRollout`)
  - `control-plane/src/routes/releases.js`
  - `scripts/test_ota_rollout.js` R1–R10 pass
- Update client verifies signature and has rollback path:
  - `beacon-relay-agent/lib/update.js`
  - `scripts/test_update_client.js` U8–U9 pass

Gaps:
- **SBOM generation is deferred** (`docs/specs/BEACON_RELAY_CHECKLIST.md` §8.7).
- **CVE monitoring is not implemented.** No SBOM means no CVE feed; no scanner
  integration found.
- **OTA rollback logic may mark the wrong slot.** Independent review notes that
  `runUpdateCycle` calls `mark-good`/`mark-bad` on the currently booted slot
  before reboot (`Beacon_Relay_Code_Review_2026-09-23.md` H2).
- **Version string is not validated** before being interpolated into shell
  commands (`Beacon_Relay_Code_Review_2026-09-23.md` C4).

Because SBOM/CVE monitoring is missing and rollback/version safety has open
questions, this area is PARTIAL.

---

## 5. PHI boundary

**Status: PARTIAL**

Evidence:
- Canonical event schema defaults `phi_mode: false` and never retains raw HL7
  bodies:
  - `schemas/beacon_relay_event.schema.json`
  - `sidecar/mllp_tap.py`
  - `scripts/test_sidecar_security.py` 24/24 (adversarial payload recovery fails)
- PHI guard scans alert/email payloads for identifiers:
  - `control-plane/src/phi_guard.js`
  - `scripts/test_alerting_rbac_audit_support.js` H1–H10 pass
- PHI-mode toggle design note exists but is not implemented:
  - `.agent/phi-mode-design.md`
  - `docs/specs/BEACON_RELAY_STATUS.md` §8.9

Gaps:
- **PHI guard only covers email.** SMS, voice, and Slack/Teams webhook paths
  do not apply the same scan (`Beacon_Relay_Code_Review_2026-09-23.md` M1,
  `control-plane/src/deliver.js`).
- **PHI-mode toggle is design-only**, pending approval.
- Regex-based PHI detection has known false positives/negatives (M2).

Because the PHI-mode toggle and full-channel PHI guard are incomplete, this
area is PARTIAL.

---

## 6. Alert design

**Status: DONE**

Evidence:
- Severity tiers, owner/contact mapping, plain-language impact statements,
  runbook attachment, required ack, auto-escalation, maintenance windows:
  - `control-plane/src/alerting.js`
  - `control-plane/src/routes/alerts.js`
  - `scripts/test_alerting_rbac_audit_support.js` A1–A6 pass
- Alert lifecycle and audit logging:
  - `control-plane/src/db.js` (`createAlert`, `ackAlert`, `escalateAlert`, `closeAlert`)
  - `scripts/test_alerting_rbac_audit_support.js` C1–C2 pass
- Delivery rails for SMS/voice, email, webhooks:
  - `control-plane/src/deliver.js`
  - SES/SendGrid fallback implemented

Note: delivery rails are proven by shape/skip behavior, not by sending real
SaaS messages (documented in `docs/specs/BEACON_RELAY_STATUS.md`).

---

## 7. False-positive control

**Status: PARTIAL**

Evidence:
- Multi-step outage confirmation before escalation (retry → second dependency →
  WAN → LTE):
  - `beacon-relay-agent/lib/outage_confirm.js`
  - `scripts/test_agent_loop.js` A2–A4 pass
- Config-deficit mapping (e.g. FHIR auth failure → `unknown`, not `down`):
  - `scripts/test_ehr_unit.js`
  - `scripts/test_ehr_e2e.js`
- Plain-language impact rejection to avoid transport-jargon alerts:
  - `control-plane/src/alerting.js`
  - `scripts/test_alerting_rbac_audit_support.js` A6 pass

Gaps:
- No documented false-positive review workflow or runbook-driven tuning
  process.
- PHI guard has false-positive issues (`Beacon_Relay_Code_Review_2026-09-23.md`
  M2) that can block legitimate ops notes.
- No alert correlation/causation engine; co-occurring signals are surfaced but
  not interpreted (this is by design, but it limits automated false-positive
  suppression).

Because the systematic false-positive management process is not documented or
implemented, this area is PARTIAL.

---

## 8. Downtime / resilience workflow

**Status: DONE**

Evidence:
- Local downtime UI serves cached contact tree, vendors, priorities, runbooks
  when the control plane is severed, and catches up on reconnect:
  - `beacon-relay-agent/lib/downtime.js`
  - `scripts/test_agent_loop.js` C1–C4 pass
- Multi-path WAN/LTE failover detection:
  - `beacon-relay-agent/lib/outage_confirm.js`
  - `beacon-relay-agent/lib/net_checks.js`
  - `scripts/test_ehr_unit.js` WAN checks pass
- Self-monitoring (heartbeat, clock, disk, DNS, modem, control-plane reachability):
  - `beacon-relay-agent/lib/self_monitor.js`
  - `scripts/test_agent_loop.js` B1–B2 pass
- PostgreSQL storage + migration safety for control-plane resilience:
  - `control-plane/src/db.js`
  - `control-plane/migrate.js`
  - `control-plane/test/migrate.once.test.js` pass

---

## 9. Hardware lifecycle

**Status: PARTIAL**

Evidence:
- BOM with approved alternates:
  - `hardware/bom.json`
  - `scripts/test_device_lifecycle.js` hardware manifest tests pass
- Golden-image manifest and validator:
  - `hardware/golden_manifest.json`
  - `scripts/validate_golden_manifest.js`
  - `scripts/test_device_lifecycle.js`
- Device swap workflow with cert revocation:
  - `control-plane/src/routes/devices.js`
  - `control-plane/src/db.js` (`replaceDevice`, `recordRevokedSerial`)
  - `scripts/test_device_lifecycle.js`
  - `scripts/test_device_replace_e2e.js`
- Swap procedure doc:
  - `hardware/swap_procedure.md`

Gaps:
- **Physical steps are out of scope** until real hardware is available:
  - secure wipe / TPM clear on returned units
  - barcode/serial scanning
  - factory burn-in and alternate qualification
  - (`hardware/swap_procedure.md`, `.agent/open-questions.md`)
- QEMU acceptance (the Phase-3 proof of first-boot provisioning and TPM/LUKS
  sealing) is blocked in this environment; see `.agent/attempts.md`.

Because physical lifecycle steps are not implemented, this area is PARTIAL.

---

## 10. Contracts / insurance (docs only)

**Status: MISSING**

Evidence: none found.

What would be needed:
- Draft Business Associate Agreement (BAA) or BAA checklist.
- Cyber-liability / E&O insurance summary.
- Customer MSA / contract amendment template (especially for PHI mode).
- AWS HIPAA-eligible-services confirmation and BAA process doc.

What exists instead:
- AWS doc mentions RDS, ECS/Fargate, S3, IoT Core, Cognito are HIPAA-eligible
  and a BAA is required (`docs/specs/BEACON_RELAY_CLOUD_ARCHITECTURE_AWS.md` §5).
- PHI-mode design note mentions requiring a recorded BAA/contract amendment
  reference per site (`.agent/phi-mode-design.md`).
- `docs/specs/BEACON_RELAY_CHECKLIST.md` lists "HIPAA BAA / eligible-services confirmation"
  as NOT STARTED.

Gap: no actual contract or insurance documents exist in the repo.

---

## Summary table

| # | Area | Status | Key evidence | Key gap |
|---|------|--------|--------------|---------|
| 1 | Security approval pack | MISSING | — | No consolidated security model / approval pack |
| 2 | Device identity / zero-trust | PARTIAL | `scripts/test_ehr_e2e.js`, `beacon-relay-agent/lib/tpm.js` | Device does not verify server; key generated in software, not TPM |
| 3 | Fleet management security | PARTIAL | `scripts/test_alerting_rbac_audit_support.js` D/B, `control-plane/src/routes/support.js` | No real auth/MFA; roles from query params; ungated routes |
| 4 | Signed OTA + rollback + SBOM/CVE | PARTIAL | `scripts/test_ota_rollout.js`, `scripts/test_update_client.js` | SBOM/CVE missing; rollback slot logic questioned |
| 5 | PHI boundary | PARTIAL | `scripts/test_sidecar_security.py`, `control-plane/src/phi_guard.js` | PHI-mode toggle design-only; SMS/voice/webhook not scanned |
| 6 | Alert design | DONE | `scripts/test_alerting_rbac_audit_support.js` A/C | — |
| 7 | False-positive control | PARTIAL | `scripts/test_agent_loop.js` A, `scripts/test_ehr_unit.js` | No systematic false-positive workflow; PHI guard false positives |
| 8 | Downtime / resilience | DONE | `scripts/test_agent_loop.js` C/B, `control-plane/test/migrate.once.test.js` | — |
| 9 | Hardware lifecycle | PARTIAL | `scripts/test_device_lifecycle.js`, `hardware/swap_procedure.md` | Physical steps (wipe/TPM clear/qualification) not implemented |
| 10 | Contracts / insurance | MISSING | — | No BAA, insurance, or contract documents |

---

## Follow-up actions implied by this audit

1. Create `docs/SECURITY_MODEL.md` (core of the security approval pack) before
   any real hospital deployment.
2. Fix device-side server certificate pinning (`beacon-relay-agent/agent.js`).
3. Generate the device identity key inside the TPM, not in software.
4. Add real operator authentication (Cognito/OIDC) with MFA; derive roles from
   the authenticated principal.
5. Add an auth policy to every route and a test that fails on undeclared
   policies.
6. Implement SBOM generation and a CVE monitoring workflow.
7. Resolve OTA rollback slot correctness and validate version strings.
8. Complete PHI-mode toggle implementation after design review.
9. Extend PHI guard to SMS/voice/webhook channels.
10. Add contract/insurance documentation (BAA template, cyber-liability summary).
