# Netbox — Spec Index (hand-off map for Kimi K3)

Five documents make up the complete Netbox build spec. This index exists so nobody —
Ryan or Kimi — has to reconstruct the reading/hand-off order from scratch each time a new
phase starts. It adds nothing new technically; every real decision lives in the five
documents themselves.

| # | Document | What it covers | Depends on |
|---|---|---|---|
| 1 | `NETBOX_BUILD_SPEC.md` | The core spec: architecture, device agent, control plane, alerting, Fleet Console, canonical event schema, tech stack, build order (Phases 1–9), documentation standard. Read this first, always. | — |
| 2 | `NETBOX_EHR_INTEGRATIONS.md` | Which real-world EHR/EMR, interface-engine, and e-prescribing systems Netbox has to recognize (17-system table), the 4-adapter integration strategy, and interface topology visibility in the Fleet Console. | Doc 1 |
| 3 | `NETBOX_CONTROLS_AND_IDENTITY.md` | Site network controls (WAN/firewall/DNS/VPN/backup/AV), the Action Registry (safe path from monitoring to limited remote action), and Microsoft 365/Entra ID read-only account-health visibility. | Doc 1 |
| 4 | `NETBOX_CLOUD_ARCHITECTURE_AWS.md` | How the control plane is actually hosted on AWS — IoT Core, RDS/Cognito, ECS Fargate, IoT Jobs, Secure Tunneling, audit log, Step Functions — service-by-service, with reasons. | Docs 1 & 3 (Action Registry, RBAC roles) |
| 5 | `NETBOX_TOPOLOGY_AND_TROUBLESHOOTING_MEMORY.md` | Geographic fleet map, deterministic (non-AI) troubleshooting memory / case-based matching, and ticketing-system export (copy-paste block + email, no vendor REST integration yet). | Docs 1 & 2 (interface topology, runbooks) |

Every document is self-contained enough to hand to Kimi on its own once its dependency
column is satisfied, and every document ends with one or more ready-to-paste Kimi build
prompts, each scoped to a demoable slice with an explicit "stop and report back" line.

---

## Suggested hand-off sequence

This follows `NETBOX_BUILD_SPEC.md` Section 8's build order, with the companion docs
slotted in where they actually apply — it is not a strict single-file-per-phase mapping,
because some phases (schema/PKI, minimal control plane, alerting logic) don't need their
own companion document and are fully specified in the main spec's narrative sections.

1. **Phase 1 — Schema & PKI foundation.** Hand Kimi `NETBOX_BUILD_SPEC.md` in full, then
   its Section 11 prompt. Nothing else matters until a device can prove who it is.
2. **Phase 2 — Minimal control plane.** Covered narratively in `NETBOX_BUILD_SPEC.md`
   Sections 5–7 (device registry, ingestion API, bare-bones console). No dedicated
   companion prompt exists yet — write one from those sections if/when this phase starts
   in isolation, or fold it into the AWS hosting work below.
3. **Phase 3 — The Configurator.** `NETBOX_BUILD_SPEC.md` Section 12 prompt (also
   reproduced in `NETBOX_EHR_INTEGRATIONS.md` Section 1 for convenience).
4. **AWS hosting for the control plane.** Once Phase 1's step-ca/enrollment and Phase 3's
   Configurator/RAUC output exist, hand Kimi `NETBOX_CLOUD_ARCHITECTURE_AWS.md` in full
   plus its Section 6 prompt — covers IoT Core, RDS, Cognito, and the Fargate API/ingestion
   services (steps 1–4 of that prompt). IoT Jobs (OTA), Secure Tunneling, the QLDB/S3-
   Object-Lock audit log, and Step Functions escalation are specified in that document's
   Sections 1 and 5 but not yet turned into their own ready-to-paste prompt — write one
   from those sections when that slice starts.
5. **Phases 4–5 — Device Agent + HL7/MLLP sidecar, real-world systems.** Hand Kimi
   `NETBOX_BUILD_SPEC.md` + `NETBOX_EHR_INTEGRATIONS.md` together, then the Section 10
   prompt (four protocol adapters + first three vendor config profiles).
6. **Interface topology visibility.** Once the Mirth/NextGen admin-API reader from step 5
   is demoable, hand Kimi `NETBOX_EHR_INTEGRATIONS.md` Section 12 prompt.
7. **Network controls + Action Registry + Identity.** Hand Kimi `NETBOX_CONTROLS_AND_IDENTITY.md`
   in full plus its Section 6 prompt. This can run in parallel with steps 5–6 — it doesn't
   depend on the EHR work.
8. **Fleet map + troubleshooting memory + ticketing export.** Once the per-site topology
   view (step 6) and the Action Registry/runbook plumbing (step 7) exist, hand Kimi
   `NETBOX_TOPOLOGY_AND_TROUBLESHOOTING_MEMORY.md` in full plus its Section 5 prompt.
9. **Remaining Phase 6–9 items not yet split into their own companion prompts:** the
   Alerting & Escalation Engine's Twilio/SES wiring and acknowledgment tracking
   (`NETBOX_BUILD_SPEC.md` Section 6), downtime mode and the remote-support session broker
   (`NETBOX_BUILD_SPEC.md` Section 7, Action Registry groundwork in
   `NETBOX_CONTROLS_AND_IDENTITY.md` Section 2), and the PHI-mode toggle + hardware
   lifecycle tooling (`NETBOX_BUILD_SPEC.md` Section 8, item 9). These are specified in
   prose in the main spec but don't yet have a dedicated copy-paste Kimi prompt the way the
   other slices do — worth writing one before each starts, following the same pattern as
   the existing prompts (numbered steps, synthetic-data-only rule, explicit stop point).

---

## Standing rules that apply across every document (don't restate per-phase)

- Never real hospital data, real patient identifiers, or a real HL7 feed — synthetic/test
  data only, in every phase, no exceptions.
- No tool substitution (RAUC, step-ca, LUKS, IoT Core, etc.) without flagging why first.
- Documentation standard from `NETBOX_BUILD_SPEC.md` Section 10 applies to every file Kimi
  writes, in every phase: header comments, docstrings (what + when/why), inline comments on
  every deliberate safety decision.
- `phi_mode` defaults to `false` everywhere, always, unless a signed contractual amendment
  says otherwise for a specific device.
- Every phase prompt ends the same way on purpose: build the scoped slice, demo it against
  synthetic data, stop, report back. Don't let Kimi continue past a phase boundary on its
  own judgment — each boundary exists because something later genuinely depends on it.
