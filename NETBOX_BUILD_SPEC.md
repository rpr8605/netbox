# Netbox — Technical Build Specification for Kimi

**Purpose of this document:** a complete engineering brief for building Netbox — the remote hospital infrastructure monitoring appliance for small, rural, and critical-access hospitals. This answers "what does it take to build this" concretely: not one program, but three real subsystems that have to work together — a device image/configurator pipeline, the device-side monitoring agent, and a cloud control plane with a fleet dashboard. Each is scoped below with real, purpose-built tools rather than from-scratch reinvention wherever a solved tool already fits.

---

## 0. The shape of the answer, up front

"Do I build the configurator, or the dashboard infrastructure" isn't an either/or — both are required, plus a third piece that's easy to underweight: the device identity and enrollment system that lets the other two trust each other. Skipping it doesn't simplify the build, it just means shipping a fleet of devices with no real way to tell a legitimate appliance from a cloned or compromised one, which was flagged as a hard requirement, not a nice-to-have, when the security review was done.

So, three subsystems:

1. **The Configurator** — a tool Ryan runs to build the signed, provisioned OS image that gets flashed onto each physical box before it ships. This is the literal "build the OS/install file" ask.
2. **The Device Agent** — the software that actually runs on the box in the hospital: local monitoring checks, the HL7/MLLP metadata capture, the update client, the local downtime cache.
3. **The Cloud Control Plane + Fleet Console** — the "everything else": device registry, ingestion API, alerting/escalation engine, the dashboard Ryan and hospital IT actually look at, audit logging, update distribution.

All three are scoped below, each keeping to the "narrow promise, evidence-graded, never more coverage than is true" discipline already decided for the product.

---

## 1. System architecture — the shape of it

```
HOSPITAL SITE (mini PC, on their network)              │  NETBOX CONTROL PLANE (cloud)
                                                          │
  ┌────────────────────────┐   outbound-only, mTLS       │
  │      DEVICE AGENT       │──────────────────────────▶ │   ┌──────────────────┐
  │  ┌──────────────────┐  │                              │   │  Ingestion API    │
  │  │ Node/TS           │  │                              │   │  (device registry, │
  │  │ orchestrator       │  │                              │   │   metadata store)  │
  │  │ - L0-L4 checks     │  │                              │   └────────┬─────────┘
  │  │ - heartbeat/self-  │  │                              │            │
  │  │   health           │  │                              │            ▼
  │  │ - downtime cache    │  │                              │   ┌──────────────────┐
  │  └──────────────────┘  │                              │   │ Alerting &        │
  │  ┌──────────────────┐  │                              │   │ Escalation Engine │
  │  │ Python sidecar     │  │                              │   └────────┬─────────┘
  │  │ HL7/MLLP passive   │  │                              │            │
  │  │ capture, metadata- │  │                              │            ▼
  │  │ only by default     │  │                              │   ┌──────────────────┐
  │  └──────────────────┘  │                              │   │ Fleet Console      │
  │  ┌──────────────────┐  │   cert issuance, updates,    │   │ (React, RBAC,      │
  │  │ Update client       │◀─┼──────────────────────────── │   │  audit log)        │
  │  │ (RAUC, A/B verify)  │  │                              │   └──────────────────┘
  │  └──────────────────┘  │                              │   ┌──────────────────┐
  │  TPM-backed identity,  │◀─┼── device PKI (step-ca) ────▶│   │ Update/Release     │
  │  per-device cert        │  │                              │   │ Server (signed,    │
  └────────────────────────┘  │                              │   │  staged rollout)   │
                                │                              │   └──────────────────┘
```

The line down the middle matters the same way it does in Handoff: everything left of it runs inside the hospital's network, on hardware Ryan physically controls before it ships. Everything right of it only ever receives metadata-scoped telemetry over an outbound, mutually-authenticated connection the device initiates — never an inbound port, never a standing credential, never a raw HL7 payload by default.

---

## 2. The Configurator — building the OS/install image

This is a tool that runs on Ryan's machine, not on the appliance. Its job: produce one signed, versioned, bootable image per device, and a first-boot provisioning flow that turns a blank mini PC into a trusted, enrolled Netbox appliance.

**Base OS:** a minimal Debian or Ubuntu Server install, stripped to what the agent needs — not a general-purpose desktop image. Read-only root filesystem where practical, with writable state confined to a small, explicit data partition (telemetry cache, logs, local config).

**Update/partition scheme — use RAUC, don't hand-roll this.** RAUC (raucs.io) is a real, purpose-built open-source tool for exactly this problem: signed, atomic A/B updates for embedded Linux devices, with automatic rollback if a new image fails to boot or fails a post-update health check. This directly satisfies the signed-update and rollback requirement from the security review without inventing custom partition-swap logic. The Configurator's core job is building a RAUC bundle (the signed image artifact) for each release, and burning the *first* one onto each device's storage before it ships.

**Device identity, generated at image-build or first-boot (not before):**
- On first boot at the hospital, the device generates its own keypair. Where the mini PC's chipset includes a TPM 2.0 (most N100/N305-class boards do — confirm per exact SKU before ordering hardware at volume), seal the private key to the TPM so it can't be extracted even with physical disk access. Without a TPM, fall back to a securely generated software key sealed behind full-disk encryption (LUKS).
- The device then requests a short-lived client certificate from the control plane's private CA. **Use step-ca (Smallstep)** for this rather than building a PKI from scratch — it's a real, actively maintained open-source CA purpose-built for automated short-lived certificate issuance and rotation to a device fleet, with mTLS support built in.
- Until that certificate is issued and the device passes its own config/firmware-signature self-check, the device sits in a **quarantine state** — it can request enrollment, nothing else. This is what makes a cloned or tampered device harmless even if someone gets a copy of the disk image.

**Disk encryption:** full-disk LUKS encryption as standard, not optional, so a failed/replaced/stolen SSD can't be read for stored telemetry — this also directly enables the "secure-wipe" and field-replacement requirements from the hardware lifecycle review.

**What "building the OS/install file" concretely means in practice:** a script/pipeline (this can reasonably be a shell + Packer-based build, or a simpler Debian preseed/cloud-init-driven build feeding into a RAUC bundle) that takes the current release's agent software, bakes it into a base image, signs it, and outputs a flashable artifact plus its RAUC bundle for future OTA delivery. One build produces both "what ships on day one" and "what the fleet update-checks against later" — the same artifact, not two different things to maintain.

---

## 3. The Device Agent — what actually runs on the box

**Node.js/TypeScript orchestrator** (as already decided): owns the local monitoring loop.
- Runs the configured critical-service checks per site (EHR reachability, identity/auth, ADT, lab, pharmacy, imaging, e-prescribing, internet, phone, printing — whichever are in scope for that hospital's critical-service register).
- Implements the L0–L4 tiers concretely as check depth, not just a label: L0 = ICMP/basic reachability, L1 = TCP port open, L2 = TLS handshake/certificate valid, L3 = an authenticated synthetic transaction against the actual service (only ones the customer has explicitly signed off as safe and non-disruptive), L4 = confirmed successful real traffic observed (e.g., a real HL7 ACK seen recently for that dependency). This gives "Reachable / Verified Ready / Active" a concrete technical basis instead of being three vague labels.
- **Monitors itself**, not just the network: its own heartbeat, last successful check per monitor, local clock sync, disk space, DNS resolution, cellular modem status, and control-plane reachability. A monitor that's silently stopped working is worse than no monitor.
- Before escalating a critical outage, does multi-step confirmation: retry locally, check a second independent dependency, validate the primary WAN path, then fail over to LTE specifically to confirm whether it's a local outage or the control plane itself that's unreachable. This is what keeps one ISP blip from generating twenty false alerts instead of one accurate one.
- Caches everything needed for **downtime mode locally** — contact tree, vendor numbers, per-site recovery priorities, runbooks — so it's available on the device's own local web UI even if the WAN and the cloud dashboard are both unreachable. This is the one piece of the product that has to work *especially* when everything else is down.

**Python sidecar** (as already decided): passive HL7/MLLP capture.
- Reads MLLP traffic passively — never in the message path, never able to block or delay a real message.
- Extracts **metadata only** by default, per the canonical schema in Section 5 below: message type/trigger event, direction, timestamp, ACK/NACK, latency, size — never the message body.
- Tokenizes any identifier-shaped field with a per-device, keyed HMAC before it's even written to local disk, let alone sent anywhere — not a plain hash, which is reversible in practice against a small, guessable identifier space like MRNs.

**Update client:** checks the control plane for a new signed RAUC bundle, verifies the signature before anything touches disk, applies it to the inactive partition, and only marks it active after a successful boot and a post-update local health check — automatic rollback to the previous known-good partition otherwise.

---

## 4. Canonical data model — metadata-only, PHI as an opt-in mode

Every check and every captured HL7 metadata event gets written in one shape, matching the discipline already used for Handoff:

```json
{
  "event_id": "uuid-v4",
  "device_id": "netbox-device-uuid",
  "site_id": "client-scoped-uuid",
  "occurred_at": "2026-08-28T14:02:11Z",
  "kind": "check_result | hl7_metadata | heartbeat | update_event",
  "service": "ehr | adt | lab | pharmacy | imaging | eprescribe | internet | phone | printing | custom",
  "tier_observed": "L0 | L1 | L2 | L3 | L4",
  "status": "reachable | verified_ready | active | degraded | down | unknown",
  "latency_ms": 214,
  "confidence": "high | medium | low",
  "freshness_s": 12,
  "hl7_metadata": {
    "message_type": "ADT | ORU | ORM | ...",
    "direction": "inbound | outbound",
    "ack_status": "ACK | NACK | timeout",
    "correlation_token": "hmac-sha256, per-device-key-derived"
  },
  "phi_mode": false
}
```

`phi_mode` defaults to `false` for every device, every client, unless explicitly toggled per a signed contractual amendment — and when it's `false`, the sidecar's code path physically doesn't have the raw payload in memory past the point metadata is extracted, not just a flag that's supposed to stop it. That's a real behavioral guarantee, not a policy statement — the distinction matters if this is ever the subject of a hospital's security review or, worse, an incident.

---

## 5. The Cloud Control Plane

**Device registry & ingestion API** (Node.js/TypeScript, pairs naturally with the device agent's own language): accepts mTLS connections from enrolled devices, validates the client cert against step-ca, enforces the quarantine gate, and stores incoming events.

**Storage:** PostgreSQL for device registry, config, RBAC, audit log, and incident records — this doesn't need Handoff's ClickHouse-scale trace storage; Netbox's telemetry volume (periodic health checks per site, not per-message tracing across a busy interface engine) is orders of magnitude lower. Add the TimescaleDB extension to the same Postgres instance if the time-series query patterns need it later — don't stand up a second database system before there's a real reason to.

**RBAC:** support technician, customer IT admin, operations manager, security auditor, read-only executive — as distinct roles from day one, not bolted on later, since "who can see what" is one of the first questions a hospital security review will ask.

**Audit log:** every login, config change, software update, access grant, and remote-support session — written as an append-only, immutable record. This is a compliance deliverable as much as an engineering one.

---

## 6. Alerting & Escalation Engine

Own the logic (severity tiers, owner mapping, plain-language impact statements, runbook attachment, acknowledgment tracking, suppression/maintenance windows) as real product IP — but don't rebuild message delivery from scratch. Use Twilio for SMS/voice and SES or SendGrid for email, with a Teams/Slack webhook for chat — proven delivery infrastructure, with the escalation *decisions* (who, when, how loud, what's attached) as the actual thing Netbox is selling.

Every P1/P2 alert carries: severity, the specific critical-service dependency affected, a plain-language impact line ("EHR login unavailable from this site," never a raw port/protocol string), the client-approved runbook for that condition, and a required acknowledgment with automatic escalation to the next contact if it's not acknowledged in the configured window.

---

## 7. Fleet Console (the dashboard)

**React frontend**, paired with the same Node/TS API layer — reuse patterns from Handoff's console rather than starting the visual design over, though Netbox's own status semantics (Reachable/Verified Ready/Active, not Nominal/Watch/Critical) should read as their own thing, not a reskin.

Shows, per device: status, software/RAUC bundle version, storage remaining, modem signal/state, last contact time, network path, monitoring-pack version. Shows, per site: the critical-service register and current status of each, active incidents, and downtime-mode history.

**Remote support session broker:** never a standing SSH port or shared credential. An admin requests a support session; the device (already holding an outbound mTLS connection) picks up a session token and opens an *outbound* tunnel for a time-limited window. The hospital never has to open an inbound port for this to work, and every session is itself an audit-logged event.

---

## 8. Build order

1. **Schema & PKI foundation** — canonical event schema (Section 4), step-ca stood up, device enrollment/quarantine flow designed and tested end to end with a single test device. Nothing else matters until a device can prove who it is.
2. **Minimal control plane** — device registry, ingestion API, a bare-bones console that just shows "device checked in, here's its status." The smallest possible real thing.
3. **The Configurator** — RAUC-based image build pipeline, first-boot provisioning script, LUKS disk encryption. This produces the first real, flashable device image.
4. **Device Agent** — the Node/TS orchestrator's L0–L4 checks and self-heartbeat, running against a real (or realistically simulated) hospital-side test environment.
5. **HL7/MLLP sidecar** — metadata-only capture and tokenization, wired into the same event stream.
6. **Alerting & escalation engine** — severity tiers, owner mapping, Twilio/SES integration, acknowledgment tracking.
7. **Signed OTA updates** — full staged rollout path (dev → test device → pilot group → broad), SBOM generation, rollback verified with an intentionally-broken test build.
8. **Downtime mode, RBAC, audit log, remote-support broker** — the remaining trust-and-operations surface.
9. **PHI mode toggle + hardware lifecycle tooling (golden images, swap procedure)** — largely policy/process work with a thin code surface, can run in parallel with the above rather than blocking it.

Steps 1–3 are the genuine prerequisite chain — nothing after them can be trusted or demoed credibly without them. Everything from step 4 on can proceed in roughly the order given, but isn't as strictly sequential.

---

## 9. Tech stack summary

| Layer | Choice | Why |
|---|---|---|
| Device orchestrator | Node.js/TypeScript | Already decided; pairs with the control-plane API |
| HL7/MLLP sidecar | Python | Already decided; strong HL7 tooling ecosystem |
| OS/image base | Debian or Ubuntu minimal | Small footprint, well-understood, long support lifecycles |
| Signed A/B updates | RAUC | Purpose-built for exactly this — signed bundles, atomic updates, automatic rollback |
| Device PKI | step-ca (Smallstep) | Purpose-built private CA for automated short-lived device certs + mTLS |
| Device identity root | TPM 2.0 (where available) + LUKS fallback | Hardware-backed key protection; graceful fallback where TPM isn't present |
| Control plane API | Node.js/TypeScript | Shared language/types with the device agent |
| Fleet console | React | Reuse Handoff's visual/interaction patterns; own status semantics |
| Registry/config/audit/incidents | PostgreSQL (+TimescaleDB if needed) | Netbox's telemetry volume doesn't justify a separate time-series store yet |
| Alert delivery | Twilio (SMS/voice) + SES/SendGrid (email) + Teams/Slack webhook | Proven delivery rails; escalation logic stays in-house as real product IP |
| Remote support | Outbound-only session broker, JIT tokens | No inbound ports, no standing credentials, every session audit-logged |

---

## 10. Documentation & commenting standard

Same standard as Handoff's build spec, Section 11: every file gets a header comment stating its responsibility and where it sits in the Section 1 diagram; every function gets a docstring covering what it does and when/why it's called; and the deliberate safety-load-bearing design decisions — metadata-only-by-default, the quarantine state, no-standing-remote-access, deterministic multi-step alert confirmation — get inline comments explaining *why*, not just what, so a future maintainer doesn't quietly "simplify" a safety boundary. Assume the next reader has never seen this system and isn't in the room to ask.

---

## 11. Copy-paste build prompt for Kimi

```
You are building "Netbox," a remote hospital infrastructure monitoring appliance for
small, rural, and critical-access hospitals. This is three subsystems that must work
together: a device image/configurator pipeline, a device-side monitoring agent, and a
cloud control plane with a fleet dashboard. Follow the attached technical build
specification exactly for architecture and tool choices — do not substitute different
tools (e.g. do not replace RAUC or step-ca with a custom-built equivalent) without
flagging why first.

DOCUMENTATION REQUIREMENT: apply Section 10's standard to every file — header comments,
docstrings explaining what AND when/why, and inline comments on every deliberate safety
decision (metadata-only capture, the quarantine state, no standing remote access,
multi-step alert confirmation before escalating).

Do not use any real hospital data, real patient identifiers, or a real HL7 feed at any
point in this build — use synthetic MLLP traffic for all testing.

Start with Phase 1 only (Section 8):
1. Define the canonical event schema from Section 4 as a JSON Schema file, with generated
   TypeScript and Python types.
2. Stand up step-ca as a local private CA.
3. Build the device enrollment flow: a device generates a keypair (TPM-backed if
   available, LUKS-sealed software key otherwise), requests a short-lived cert from
   step-ca, and sits in a quarantine state until the control plane confirms identity and
   config integrity.
4. Test this end to end with one simulated device against a local step-ca instance —
   enrollment succeeds, and confirm a device presenting an invalid/unsigned identity is
   correctly refused and stays quarantined.

Stop after Phase 1 is demoable and report back before continuing to Phase 2 (the minimal
control plane). Every later phase depends on this identity/trust foundation being solid.
```

Hand Kimi this document in full alongside that prompt — the prompt scopes the first unit of work, but every later phase depends on the schema and tool choices made in Sections 2–7, so it needs the whole spec in context.
