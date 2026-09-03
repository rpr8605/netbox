# Netbox — Cloud Architecture on AWS (Control Plane Hosting)

This is a companion document to `NETBOX_BUILD_SPEC.md`, `NETBOX_EHR_INTEGRATIONS.md`, and
`NETBOX_CONTROLS_AND_IDENTITY.md`. It does not replace any of them — the event schema,
device agent design, RBAC roles, Action Registry, and identity-provider work are still
governed there. This document answers one specific question Ryan asked: given the choice
to host the Netbox Control Plane (`NETBOX_BUILD_SPEC.md` Section 5–7) heavily on AWS, what
does the *ideal* version of that hosting look like, concretely, service by service.

The guiding rule carried over from the rest of the spec: prefer a real, purpose-built AWS
managed service over hand-rolling the same property, wherever one already exists. Every
hard security property already decided elsewhere in this spec — outbound-only mTLS, no
standing inbound port, per-device identity, staged signed rollouts, time-limited scoped
remote sessions — has an AWS-managed equivalent. Building it from scratch a second time
would be effort spent re-solving a problem AWS already solved, which cuts against the
"don't build fifteen integrations" / "don't build ahead of demand" discipline running
through the rest of this project.

---

## 1. Component-to-service map

| Netbox component (spec section) | AWS service | Why this one |
|---|---|---|
| Device registry + ingestion, outbound-only mTLS (`BUILD_SPEC` §5) | **AWS IoT Core**, with a customer-managed CA registration pointing at step-ca | Purpose-built for exactly this device model — per-device mTLS cert, outbound-only connection, device shadow/state. step-ca stays the actual issuing CA; IoT Core just trusts it. |
| Signed OTA rollout, staged (`BUILD_SPEC` §2, §3, §8 step 7) | **AWS IoT Jobs**, orchestrating the RAUC bundle already produced by the Configurator | Per-device job status (queued/in-progress/succeeded/failed/rejected), staged rollout groups, built-in retry — the distribution layer over an artifact whose *format* stays RAUC, unchanged. |
| Remote-support session broker / Action Registry transport (`BUILD_SPEC` §7, `CONTROLS_AND_IDENTITY` §2) | **AWS IoT Secure Tunneling** | Already implements "device behind NAT, no inbound port, opens an outbound tunnel on a time-limited scoped token" — the literal mechanism Section 7 describes, as a managed service. |
| Control-plane API, ingestion processor, console backend (`BUILD_SPEC` §5, §7) | **ECS on Fargate**, behind an ALB | Proportionate to Netbox's actual telemetry volume (periodic per-site checks, not high-frequency tracing) — EKS would solve a scale problem this product doesn't have. |
| Alerting & Escalation Engine logic (`BUILD_SPEC` §6) | **Step Functions**, calling Twilio/SES/SendGrid as already decided | The escalation logic (wait for ack, timeout, escalate to next contact) is a wait-then-branch state machine; Step Functions gives a visual, auditable execution history of every escalation for free. |
| Action Registry session issuance (`CONTROLS_AND_IDENTITY` §2) | **Lambda + DynamoDB** (TTL on session-token items) | Natural fit for short-lived, scoped tokens; DynamoDB TTL expires a session automatically without a cleanup job. |
| Device registry, config, RBAC, incident records (`BUILD_SPEC` §5) | **RDS for PostgreSQL, Multi-AZ** | As already decided — Netbox's telemetry volume doesn't justify a separate time-series store yet. Confirm TimescaleDB extension availability on the target RDS version before relying on it; native monthly partitioning is the fallback if it isn't supported. |
| Audit log — append-only, tamper-evident (`BUILD_SPEC` §5) | **Amazon QLDB**, or an S3-Object-Lock-backed export of the Postgres audit table | This is a step beyond "just don't issue UPDATE grants" — a cryptographically verifiable ledger is a genuinely stronger claim to make in a hospital security review, and mirrors the same tamper-evidence property already designed into the backup-risk Tier 2 check. |
| Console auth, RBAC roles (`BUILD_SPEC` §5) | **Amazon Cognito** (user pools, one group per role) | Five roles (support technician, customer IT admin, operations manager, security auditor, read-only executive) map directly to Cognito groups; MFA enforced above read-only; SAML/SSO federation available later without an auth rewrite. |
| Fleet Console frontend (`BUILD_SPEC` §7) | **React on S3 + CloudFront**, behind WAF | Static hosting for the SPA; WAF in front of both this and the API Gateway/ALB. |
| Secrets (Twilio, SES/SendGrid, MS Graph app credentials) | **AWS Secrets Manager** | Rotation support; never in code, env files, or device images. |

**Authorization discipline, regardless of which service issues the token:** Cognito groups
(or any other claim) decide what a JWT *says* — every API call still re-checks
authorization server-side. Never trust a client-presented claim as the sole gate. Same
"don't trust the client" posture already applied to the device's own quarantine state.

---

## 2. Why IoT Core specifically deserves the load-bearing role here

This is worth calling out on its own because it's the single highest-leverage substitution
available: three separate pieces of custom infrastructure implied by `BUILD_SPEC` — the
mTLS ingestion listener, the OTA distribution/rollout tracker, and the remote-support
tunnel broker — collapse into one AWS service (IoT Core plus its Jobs and Secure Tunneling
features) instead of three things Kimi would otherwise build and maintain independently.
step-ca's role doesn't change: it's still the CA that issues each device's identity, exactly
as `BUILD_SPEC` §2 and §8 Phase 1 already specify. IoT Core is registered to trust that CA,
not the other way around — Netbox doesn't hand root trust to AWS.

At Netbox's realistic scale (low-thousands of devices, periodic heartbeats measured in
tens-of-seconds to minutes, not high-frequency streaming), IoT Core's per-message and
per-connection-minute pricing is trivial — this is not a cost tradeoff against Fargate, it's
a strictly cheaper and more capable option than hosting a custom MQTT/HTTPS broker fleet.

---

## 3. Account structure — where "sim" and "backup" actually live, as two different things

Ryan's phrase "built-in sim backup" covers two genuinely different concerns. Keeping them
separate matters, because they solve different failure modes:

**A device simulator ("sim"), for testing releases before they touch a real hospital.**
A dedicated AWS account (not just a separate environment inside the prod account — a real
account boundary, per AWS Organizations best practice) running synthetic "devices" as
scheduled Fargate tasks, each holding its own IoT Core certificate issued by a staging
step-ca instance. Every new device-agent release, every new RAUC bundle, and every
control-plane change gets run against this simulated fleet first. This is the durable,
always-available version of the "test end to end with a single simulated device" step that
already appears at the end of every phase in `BUILD_SPEC` §8 and every Kimi prompt in this
spec set — instead of being an ad hoc manual step each time, it's a standing environment.

**Backup/DR ("backup"), for Netbox's own control-plane resilience.** This is a different
thing from the device-side backup-risk feature in `NETBOX_CONTROLS_AND_IDENTITY.md` §2 —
that feature checks a *hospital's* backup posture; this is about Netbox's own. Multi-AZ RDS,
automated backups with cross-region snapshot copy, and the entire control plane defined as
infrastructure-as-code (Terraform or CDK) so it can be stood up in a second region on short
notice. This matters more than it might for a typical SaaS product: Netbox's core promise is
telling a hospital when its systems are down, so the control plane going dark during a real
regional AWS incident is the one failure mode that undermines the product's entire premise.
A pilot-light or warm-standby posture in a second region is worth the ongoing cost here in a
way it might not be for a lower-stakes product.

**A third account, for the same reason as the other two — isolation, not paranoia.** A
separate security/log-archive account holding the QLDB ledger or S3-Object-Lock audit
export, so that even a full compromise of the prod account's operational credentials
doesn't give an attacker write access to the history that would prove it happened.

Three accounts total: **prod**, **sim/staging**, **security/log-archive**. This is a
one-time AWS Organizations setup, not an ongoing engineering burden.

---

## 4. Compliance note

Hospitals will ask about this regardless of how the rest of this document lands. AWS
publishes a list of HIPAA-eligible services and offers a signed Business Associate
Addendum (BAA) — RDS, ECS/Fargate, S3, IoT Core, and Cognito are all on the current
eligible-services list. Confirm each specific service in use is still on that list at
deploy time (the list changes), and get the BAA signed before any customer data — even
metadata-only telemetry under `phi_mode: false` — touches production. This doesn't change
anything about the `phi_mode` design in `BUILD_SPEC` §4; it's a hosting-layer prerequisite
that sits underneath it.

---

## 5. Build order for this piece

1. **AWS Organization + three accounts** (prod, sim/staging, security/log-archive) — this
   is foundational the same way step-ca/schema was foundational in `BUILD_SPEC` §8 Phase 1;
   everything else in this document assumes account boundaries already exist.
2. **IoT Core + step-ca CA registration**, tested against Phase 1's existing enrollment
   flow (`BUILD_SPEC` §8 Phase 1) — confirm a device enrolling via step-ca is correctly
   recognized by IoT Core's device registry before building anything on top of it.
3. **RDS Multi-AZ + Cognito user pools with the five RBAC groups** — the data and auth
   foundation the control-plane API depends on.
4. **ECS Fargate services for the control-plane API and ingestion processor**, behind an
   ALB, reading/writing the RDS instance from step 3 and validating against IoT Core
   identities from step 2.
5. **IoT Jobs wired to the Configurator's RAUC bundle output** (`BUILD_SPEC` §2, §12) —
   staged rollout tracking, once Phase 3 (the Configurator) is already demoable.
6. **IoT Secure Tunneling + the Action Registry's Lambda/DynamoDB session layer**
   (`CONTROLS_AND_IDENTITY` §2, §4) — build after step 4, since it depends on the
   control-plane API existing to issue the session in the first place.
7. **QLDB or S3-Object-Lock audit export**, and **Step Functions for the escalation
   engine** — these can build in parallel with 5–6, no dependency between them.
8. **The sim/staging device fleet** (Section 3 above) — stand this up as early as
   practical, ideally alongside step 2, so every later step from here on is tested against
   it rather than a single manual test device.

---

## 6. Copy-paste prompt for Kimi — AWS control-plane hosting

```
You are continuing work on "Netbox." Read NETBOX_CLOUD_ARCHITECTURE_AWS.md in full before
starting. This document specifies how the control plane (NETBOX_BUILD_SPEC.md Section 5–7)
gets hosted on AWS — it does not change the event schema, device agent, RBAC roles, or
Action Registry design already specified elsewhere. Follow this document's service choices
exactly (e.g. AWS IoT Core for device ingestion, not a custom MQTT/HTTPS listener) — do not
substitute different AWS services or reintroduce custom infrastructure for something IoT
Core, Cognito, Step Functions, or Secure Tunneling already provides, without flagging why
first.

Build in this order, stopping to report after each numbered step:

1. Set up an AWS Organization with three accounts: prod, sim/staging, and
   security/log-archive. Nothing else in this document should be built before this exists.

2. Stand up AWS IoT Core in the prod account, registered to trust step-ca (already built
   per BUILD_SPEC Phase 1) as a customer-managed CA. Test against the existing device
   enrollment/quarantine flow: a device that completes step-ca enrollment should appear
   correctly in IoT Core's device registry; a device presenting an invalid/unsigned
   identity should be refused at the IoT Core layer too, not just at step-ca.

3. Stand up RDS for PostgreSQL (Multi-AZ) and Amazon Cognito with five user-pool groups
   matching the RBAC roles in BUILD_SPEC Section 5 (support technician, customer IT admin,
   operations manager, security auditor, read-only executive). Confirm TimescaleDB
   extension availability on the target RDS engine version before assuming it — if
   unavailable, use native monthly partitioning on the events table instead and flag this
   back rather than silently choosing one.

4. Build the control-plane API and ingestion processor as ECS Fargate services behind an
   ALB, reading device identity from IoT Core and read/writing RDS from step 3. Every API
   call must re-check authorization server-side against the Cognito group — never trust a
   client-presented claim as the sole gate.

Stop after step 4 is demoable and report back before continuing to IoT Jobs (OTA rollout),
IoT Secure Tunneling (remote-support/Action Registry transport), the QLDB or S3-Object-Lock
audit log, and the Step Functions escalation engine — all covered in Sections 1 and 5 of
this document for when that phase starts.
```

Hand Kimi this document alongside the other three — it depends on Phase 1's step-ca/
enrollment flow and Phase 3's Configurator/RAUC output already existing, so it slots in
after those, not before.
