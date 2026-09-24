# Phase 3 Inventory

Generated 2026-09-24. Read-only inventory of every remaining NOT STARTED item, open question, and BOM caveat that could feed into the next build phase. No code changes are represented here.

Build-order stages (in priority order):

1. Product boundary / L0–L4 definitions
2. Metadata-only data model / PHI boundary
3. Security and network deployment pack
4. Device identity + fleet management (includes C1 operator auth: MFA, RBAC, audit log, no standing SSH)
5. Alerting / escalation / downtime runbooks
6. Signed updates / rollback / vulnerability management
7. Hardware / replacement / LTE
8. Customer agreement / support / insurance
9. Passive HL7 metadata collector
10. Handoff interoperability add-on

Tag meanings:

- **AGENT** — can be implemented straight from the spec/doc without a decision from Ryan.
- **DECISION** — needs Ryan's call; options and a recommendation are listed.
- **HARDWARE** — requires a physical device or physical test to resolve.

---

| ID | Description | Stage | Blocked by | Tag |
|---|---|---|---|---|
| QEMU-1 | Phase 3 QEMU acceptance harness re-run (`vm-harness/acceptance.sh` with fresh image) | 1 | Docker Desktop on Windows lacks `/dev/kvm`; harness hardcodes `-enable-kvm` | HARDWARE |
| REACT-1 | React rewrite of the Fleet Console (approved per `docs/specs/BEACON_RELAY_TECH_CONSOLE_SPEC.md`; localhost-only until C1) | 1 | Plan-only: write `.agent/console-build-plan.md`, STOP for review | DECISION → plan-only |
| SQLITE-1 | Remove SQLite entirely and use native PostgreSQL + `TIMESTAMPTZ`; drop `pgize()` and dual-driver code; replace SQLite in CI with a Postgres service container | 2 | None — decision made (Option B) | DECISION → AGENT (Phase B) |
| M6 | Native timestamp handling in PostgreSQL (`pgize()` currently stores `TEXT`/`NOW()::TEXT`) | 2 | SQLITE-1 (Postgres-only phase) | DECISION → AGENT (Phase B) |
| RD-PHI-1 | **DEFERRED** — Implement PHI-mode toggle (design note exists in `.agent/phi-mode-design.md`); stay metadata-only through pilot | 2 | Pilot will remain metadata-only | DECISION → DEFERRED |
| RD-PHI-2 | **DONE** — Extend PHI guard to SMS, voice, Slack/Teams webhook channels (M1, commit `f54226b`; covered by `control-plane/test/deliver.phi.test.js`) | 2 | None | AGENT (DONE) |
| RD-SEC-1 | Create consolidated security approval pack (`docs/SECURITY_MODEL.md`, risk assessment, pen-test plan, vendor questionnaire responses) | 3 | None — can be derived from existing specs and the independent review | AGENT |
| RD-CON-1 | Draft BAA and MSA templates in `docs/legal/`, marked "DRAFT — requires attorney review, not legal advice"; AWS BAA step listed in `docs/planning/AWS_SETUP_CHECKLIST.md` | 8 | None — decision made (Option B) | DECISION → AGENT (draft templates) |
| AWS-1 | AWS Organization + three accounts (prod, sim/staging, security/log-archive); Ryan will create org/accounts and accept AWS BAA | 3 | Agent must write `docs/planning/AWS_SETUP_CHECKLIST.md`; Ryan executes the checklist | DECISION → AGENT (checklist) |
| AWS-2 | RDS PostgreSQL Multi-AZ (+ TimescaleDB check / partitioning fallback) | 3 | AWS-1 (Ryan executes setup) | AGENT |
| AWS-3 | ECS Fargate control-plane API + ingestion behind ALB | 3 | AWS-1 (Ryan executes setup) and C1 plan approval | AGENT |
| AWS-4 | QLDB or S3-Object-Lock audit export | 3 | AWS-1 (Ryan executes setup) | AGENT |
| C1 | Operator authentication: Amazon Cognito with TOTP MFA required, five RBAC groups, room for SAML/OIDC federation later; localhost-only until merged/tested | 4 | Plan-only: write implementation plan, STOP for review | DECISION → plan-only |
| COGNITO-1 | Cognito user pools with the five RBAC groups | 4 | C1 plan approval and AWS-1 (Ryan executes setup) | AGENT |
| M4 | TPM-backed device identity: align `provision.js` enrollment pin with the TPM-generated public key so the pinned `device_key_fp` matches the signing key | 4 | None — technical approach is known, but touches device identity boundary | AGENT |
| IOT-1 | IoT Core + step-ca CA registration (device registry ingestion) | 4 | AWS-1 (accounts) | AGENT |
| IOT-2 | IoT Jobs OTA rollout over the RAUC bundle | 6 | AWS-1 (accounts); existing RAUC bundle pipeline is DONE | AGENT |
| IOT-3 | IoT Secure Tunneling + Action Registry session layer (real byte pipe, not just session record) | 4 | AWS-1 (accounts); session broker is DONE | AGENT |
| FLEET-1 | Sim/staging synthetic device fleet | 4 | AWS-1 (accounts) and IOT-1 | AGENT |
| M365-1 | Microsoft 365 / Entra ID Phase 1 live validation with a real test tenant | 10 | **DEFERRED** until a customer requires it | DECISION → DEFERRED |
| M365-2 | M365 Phase 2 gated non-admin password reset | 10 | **DEFERRED** until a customer requires it | DECISION → DEFERRED |
| IDP-1 | Okta / Google Workspace identity providers | 4 | **DEFERRED** until a customer requires it | DECISION → DEFERRED |
| STEP-1 | Step Functions escalation engine | 5 | AWS-1 (accounts) | AGENT |
| RD-FP-1 | Systematic false-positive control workflow / runbook-driven tuning process | 5 | None — can be documented and partially automated from existing alert data | AGENT |
| RD-OTA-1 | SBOM generation + CVE monitoring workflow | 6 | None — can be added to the existing signed-update pipeline | AGENT |
| PB-SW | Power backup software work: agent reports power source/battery %/time left; alerts for "on battery" and "battery below 25%"; console power status; clean shutdown at low threshold — **decision: Option A** (test first, then facilities approval) | 7 | PB-HW1–PB-HW5 hardware tests | AGENT |
| PB-HW1 | Confirm EcoFlow RIVER 3 Plus 12 V output stays live in UPS mode with no switchover dropout | 7 | Physical power station + box to test with | HARDWARE |
| PB-HW2 | Confirm Linux can read RIVER 3 Plus battery status (USB data port or choose a reporting unit) | 7 | Physical power station; cable/driver investigation | HARDWARE |
| PB-HW3 | Measure actual average draw of VP2420 / V1210 running Beacon Relay, with and without LTE modem | 7 | Physical boxes + power meter | HARDWARE |
| PB-HW4 | Hospital facilities approval for a lithium battery in the network closet (LiFePO4 preferred) — **decision: Option A** (EcoFlow first, then approval) | 8 | PB-HW1–PB-HW3 test results | DECISION → HARDWARE |
| PB-HW5 | Confirm whether Protectli V1210 has TPM 2.0 enabled in firmware — **Ryan will email Protectli** | 7 | Protectli support response | HARDWARE |
| HLIVE-1 | Physical hardware-lifecycle steps: secure wipe / TPM clear on returned units | 7 | Real returned hardware + wipe tools/TPM clear process | HARDWARE |
| HLIVE-2 | Physical barcode/serial-number scanning and RMA label integration | 7 | Real hardware + scanner/RMA workflow | HARDWARE |
| HLIVE-3 | Factory burn-in, thermal, and power-cycle qualification of approved alternates | 7 | Physical alternates + test harness | HARDWARE |
| HLIVE-4 | Verify every approved alternate in `hardware/bom.json` boots the golden image and seals LUKS correctly | 7 | Physical alternates + golden image | HARDWARE |
| BOM-V1210 | Protectli V1210 marked `tpm_unconfirmed: true` — cannot be a trusted alternate until PB-HW5 is resolved | 7 | PB-HW5 | HARDWARE |
| BOM-TPM | VP2420e primary compute keeps add-on TPM-02 module — **decision: (a)** | 7 | Supplier availability / procurement | DECISION → AGENT (update BOM note) |
| BOM-VP2410 | VP2410 is out of stock — **decision: (b) on-hand only** | 7 | None | DECISION → AGENT (update BOM note) |
| BOM-N100 | CUSTOM-N100-4 alternate requires M.2 NVMe SSD selection | 7 | None | AGENT |
| BOM-WYSE | **DECISION: (c)** Use Ryan's Intel i5 Mac mini as `role: dev_test` instead of Dell Wyse 5070; add Mac mini entry to `hardware/bom.json` | 7 | None | DECISION → AGENT (update BOM) |
| BOM-MACMINI | Intel i5 Mac mini as `dev_test` box: verify x86_64/UEFI/TPM-or-PTT/USB3/second-NIC; plan a "no TPM, test only" boot mode that flags the box as "Test box: no TPM" in the console | 7 | Plan-only: write `.agent/mac-mini-test-mode-plan.md`, STOP for review | DECISION → plan-only |
| CK-EHR-1 | Vendor config profiles: Healthland, MEDHOST, Altera, NextGen, Veradigm, Azalea, Juno, Netsmart, WellSky, Sunquest/SCC | 10 | **DEFERRED** until a real customer justifies each | DECISION → DEFERRED |
| CK-EHR-2 | Federal Oracle Health profile (VA/IHS Cerner deployment) | 10 | **DEFERRED** until a real deployment need | DECISION → DEFERRED |
| CK-ENG-1 | Iguana and InterSystems admin-API readers first (verify-only per `.agent/KIMI_ENGINE_READERS_PROMPT.md` Step 1); Rhapsody/Corepoint/Cloverleaf wait for customer access | 10 | Reach this stage; spec says opportunistic | DECISION → AGENT (when reached) |
| CK-TIX-1 | Ticketing Tier 1 generic REST adapter | 8 | **DEFERRED** until a customer names a system | DECISION → DEFERRED |

---

## Decisions applied (2026-09-24)

| ID | Decision |
|---|---|
| C1 | Amazon Cognito with TOTP MFA required, five RBAC groups, SAML/OIDC federation room later. Write `.agent/cognito-implementation-plan.md` and STOP for review. Localhost-only until merged/tested. |
| AWS-1 | Ryan will create AWS Organization + three accounts and accept the AWS BAA. Agent writes `docs/planning/AWS_SETUP_CHECKLIST.md`; Ryan executes it. |
| SQLITE-1 / M6 | Option B: Postgres-only. Remove SQLite, replace CI SQLite with a Postgres service container. Do as its own phase with `npm test` green before and after. |
| RD-PHI-1 | **DEFERRED** — stay metadata-only through pilot. Do not implement PHI-mode toggle. |
| RD-CON-1 | Option B: draft BAA and MSA templates in `docs/legal/` marked draft; include AWS BAA step in the AWS checklist. |
| Power backup (PB-SW / PB-HW4) | Option A: EcoFlow RIVER 3 Plus. Test first (PB-HW1–HW3), then seek hospital facilities approval. |
| BOM-TPM | Option (a): keep VP2420e + TPM-02 module. |
| BOM-VP2410 | Option (b): keep as "on-hand only". |
| BOM-WYSE / BOM-MACMINI | Option (c): use Ryan's Intel i5 Mac mini as `dev_test` instead of Wyse 5070. Add Mac mini BOM entry and plan a "no TPM, test only" mode. |
| PB-HW5 | Ryan will email Protectli to confirm V1210 TPM 2.0 support. |
| REACT-1 | Approved per `docs/specs/BEACON_RELAY_TECH_CONSOLE_SPEC.md`. Write `.agent/console-build-plan.md` and STOP for review. Localhost-only until C1. |
| M365-1 / M365-2 / IDP-1 / CK-EHR-1 / CK-EHR-2 / CK-TIX-1 | **DEFERRED** until a customer requires them. |
| CK-ENG-1 | When reached, follow `.agent/KIMI_ENGINE_READERS_PROMPT.md` Step 1 (verify-only); Iguana/InterSystems first, Rhapsody/Corepoint/Cloverleaf wait for customer access. |

---

## DECISION items — options and recommendations

### C1 — Operator authentication IdP

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Microsoft Entra ID** | Hospitals often already have M365; conditional access + MFA; HIPAA BAA available. Cons: Microsoft coupling, per-tenant admin consent. | **Start here if first customers are M365 shops** — fastest SSO story and strongest hospital compliance fit. |
| **B. Auth0 / Okta** | Rich MFA/passkey support, good docs, easy Fastify integration. Cons: higher cost at scale, external dependency. | **Start here if customers are not Microsoft-aligned** — fastest implementation and best enterprise feature set. |
| **C. Self-hosted Keycloak / Authentik** | Full control, no per-user SaaS cost. Cons: operational burden, slower to set up. | Choose only if avoiding SaaS lock-in is worth the ops overhead. |

### AWS-1 — AWS Organization + three accounts

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Create org + prod/sim/security accounts now** | Required by `CLOUD_ARCHITECTURE_AWS`; unblocks all AWS work. Cons: monthly cost, setup time. | **Do this first** — every AWS item depends on it. |
| **B. Use a single staging account temporarily** | Faster. Cons: violates the spec's security separation. | Only as a spike; do not deploy customer data here. |
| **C. Stay local/self-hosted** | No AWS dependency. Cons: blocks cloud deployment features indefinitely. | Not viable if the AWS architecture doc remains the target. |

### SQLITE-1 / M6 — SQLite removal

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Keep dual-driver (Postgres + SQLite)** | Zero-ops local dev, fast tests. Cons: `pgize()` complexity, native timestamp bugs, two code paths. | Keep short-term if dev friction is high. |
| **B. Postgres-only, require `DATABASE_URL`** | One code path, native `TIMESTAMPTZ`, closer to prod. Cons: devs need Postgres, tests need reset. | **Do this** — it unblocks M6 and matches the production target. |
| **C. Postgres-only with testcontainers/in-memory** | Cleanest architecture. Cons: more CI infra. | Consider after B is stable. |

### RD-PHI-1 — PHI-mode toggle

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Implement as designed** | Matches `.agent/phi-mode-design.md`. Cons: requires review first. | **Approve the design note and implement** — the gap is already well-spec'd. |
| **B. Modify design before implementing** | Address concerns now. Cons: delays implementation. | Only if you disagree with the design note. |
| **C. Defer indefinitely** | No code change. Cons: leaves a spec'd surface unbuilt and blocks some hospital use cases. | Not recommended. |

### RD-CON-1 — Contracts / insurance

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Start AWS BAA process now** | Required for AWS HIPAA. Cons: paperwork, may need legal review. | Do in parallel with AWS-1. |
| **B. Draft internal BAA/MSA templates** | Enables customer conversations quickly. Cons: not legal advice. | **Do this first** — low cost and unblocks sales. |
| **C. Defer until first customer** | No upfront work. Cons: delays sales and AWS HIPAA readiness. | Not recommended. |

### PB-HW4 / PB-SW — Power backup adoption

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Standardize on EcoFlow RIVER 3 Plus after testing** | SKU already selected and documented. Cons: consumer-ish, hospital facilities approval needed. | **Run PB-HW1–HW3 first, then seek facilities approval** for this unit. |
| **B. Industrial 12 V DC UPS + LiFePO4 battery** | More appropriate for network closets. Cons: integration and sourcing work. | Switch to this if PB-HW1 fails or facilities reject the EcoFlow. |
| **C. Defer power backup entirely** | No hardware/software work. Cons: leaves sites unprotected during outages. | Not recommended for production deployments. |

### BOM-TPM / BOM-VP2410 / BOM-WYSE — Hardware procurement caveats

| Item | Options | Recommendation |
|---|---|---|
| **BOM-TPM** | (a) Keep VP2420e + TPM-02 module; (b) switch to a compute with onboard fTPM; (c) keep as software-only fallback. | **(a)** — the BOM is already built around this path; just confirm module availability. |
| **BOM-VP2410** | (a) Remove from alternates; (b) keep as "on-hand only"; (c) wait for restock. | **(b)** — honest to current procurement reality. |
| **BOM-WYSE** | (a) Procure adapter + SSD for desk testing; (b) skip and use a different dev_test box; (c) use the Intel i5 Mac mini instead. | **(a)** if you want a cheap dev_test node; **(c)** requires verifying Mac mini specs (see Mac-mini blockers below). |

### M365-1 / M365-2 — Entra ID validation and Phase 2

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Create a dedicated Entra ID test tenant** | Proves integration safely. Cons: small cost/setup. | **Do this** before any pilot hospital work. |
| **B. Partner with a pilot hospital for sandbox** | Real data shapes. Cons: BAA complexity. | Only after A passes. |
| **C. Stay mock-tested** | No infra. Cons: unproven in production. | Not recommended for a customer-facing feature. |

For **M365-2** (non-admin password reset):
| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Entra ID SSPR delegation** | Native Microsoft path. Cons: requires higher-privilege API permissions. | Defer until M365-1 is validated and a customer demands it. |
| **B. Build request/approval workflow** | Safer, custom. Cons: more code. | Defer until a customer demands it. |
| **C. Defer** | No work. Cons: gap. | **Recommended for now** — Phase 1 is not yet live-proven. |

### IDP-1 — Okta / Google Workspace

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Add Okta OIDC** | Strong enterprise fit. Cons: effort. | Defer until a customer requires it. |
| **B. Add Google Workspace** | Common for smaller customers. Cons: fewer enterprise features. | Defer until a customer requires it. |
| **C. Defer** | Matches spec's "don't build ahead of demand". Cons: limited market. | **Recommended** — C1 covers the primary IdP. |

### CK-EHR-1 / CK-EHR-2 / CK-ENG-1 — Additional vendor/interface profiles

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Build top 3 likely profiles now** | Faster sales demos. Cons: may not match first customers. | Only if you know which hospitals you are targeting. |
| **B. Build profiles when a customer names a vendor** | Right work at the right time. Cons: slower initial sales cycle. | **Recommended** — matches spec intent and avoids wasted effort. |
| **C. Build all listed profiles** | Broad coverage. Cons: very high effort, many may never be used. | Not recommended. |

### CK-TIX-1 — Ticketing Tier 1 REST adapter

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Build generic REST adapter now** | Useful once a target is named. Cons: no current target. | Not recommended without a customer system. |
| **B. Wait for customer to name system** | Right integration. Cons: delay. | **Recommended** — spec explicitly defers this. |

### PB-HW5 — V1210 TPM confirmation

| Option | Tradeoffs | Recommendation |
|---|---|---|
| **A. Email Protectli support** | Low cost. Cons: may get ambiguous answer. | **Do this first.** |
| **B. Order a V1210 and test Linux TPM visibility** | Definitive. Cons: cost and time. | Do this only if (a) is inconclusive and you want to keep V1210 as an alternate. |

---

## Blockers for using the Intel i5 Mac mini as the first Beacon Relay box

The Mac mini is not in the approved BOM. Before it can be a dev_test or reference node, these items must be resolved:

1. **M4 (device identity)** — any box needs a TPM-backed identity; Mac mini has no discrete TPM. Whether Apple T2 / Intel PTT exposes a firmware TPM usable by Linux must be verified, or the box must use a USB/TPM module.
2. **BOM-WYSE / BOM-N100-class verification** — the Mac mini likely has only one Ethernet port and uses non-standard storage; a second USB/Thunderbolt NIC and a SATA/NVMe adapter may be needed.
3. **Golden-image boot qualification** — the x86_64 Debian + RAUC image must boot, LUKS-seal, and run the agent on the Mac mini. This is a special case of HLIVE-4.
4. **Power backup questions (PB-HW1–HW3)** — if the Mac mini will run at a site, power draw and UPS compatibility must be measured.
5. **QEMU acceptance (QEMU-1)** — while not directly about the Mac mini, the Phase-3 image proof is the reference for any physical install.

Decisions applied:

- BOM-WYSE is replaced by BOM-MACMINI: the Intel i5 Mac mini is approved as `role: dev_test` only, not for hospital production.
- BOM-TPM stays with VP2420e + TPM-02 module for production compute; the Mac mini is explicitly a test box.
- A "no TPM, test only" boot mode will be planned (BOM-MACMINI) so the Mac mini can run without a TPM while clearly flagging itself in the console.

If the goal is desk development, the Mac mini is the approved **dev_test** node. It still needs an explicit BOM entry and the no-TPM test-mode plan before it is considered supported.

---

## Plan-only items requiring STOP-for-review

These items are approved in principle but must have a written implementation plan reviewed before any code is written:

| ID | Stage | Plan file | Why it needs review |
|---|---|---|---|
| REACT-1 | 1 | `.agent/console-build-plan.md` | React rewrite touches every console surface; must stay localhost-only until C1 auth is merged. |
| C1 | 4 | `.agent/cognito-implementation-plan.md` | Auth is a security boundary; nothing exposed beyond localhost until merged and tested. |
| BOM-MACMINI | 7 | `.agent/mac-mini-test-mode-plan.md` | A no-TPM boot mode changes the device-identity trust model and must not accidentally be used in production. |

---

*Status: decisions applied. Next: implement AGENT items in stage order, one commit per item, `npm test` green after each, checkpoint every $5, STOP after each plan-only item for review.*
