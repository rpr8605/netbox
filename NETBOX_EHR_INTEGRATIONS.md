# Netbox — EHR/EMR Integration Reference & Configurator Pre-Read (for Kimi)

This is a companion document to `NETBOX_BUILD_SPEC.md`. It does not replace anything in
that spec — architecture, tech stack, schema, and build order are still governed by
Sections 1–11 there. This file exists so Kimi has one self-contained document to read
**before** two specific pieces of work: the Configurator (build order Phase 3), and the
part of the Device Agent / HL7 sidecar work (Phases 4–5) that decides which real-world
hospital systems Netbox needs to recognize and check.

Hand Kimi both documents together. This one is the "who are we actually plugging into"
reference; the main spec is the "how the appliance itself is built" reference.

---

## 1. Configurator — Phase 3 build prompt (reproduced from main spec, Section 12)

This is unchanged from the main spec — reproduced here so it's readable without cross-
referencing section numbers. Use this once Phase 1 (schema & PKI) and Phase 2 (minimal
control plane) are demoable.

```
You are continuing work on "Netbox," the remote hospital infrastructure monitoring
appliance. Phase 1 (canonical schema + step-ca + device enrollment/quarantine flow) and
Phase 2 (device registry, ingestion API, bare-bones console) from Section 8 of the
attached build spec are already built and demoable. Follow the attached spec exactly for
architecture and tool choices — do not substitute different tools (e.g. do not replace
RAUC or LUKS with a custom-built equivalent) without flagging why first.

DOCUMENTATION REQUIREMENT: apply Section 10's standard to every file — header comments,
docstrings explaining what AND when/why, and inline comments on every deliberate safety
decision (full-disk encryption as non-optional, the quarantine gate on first boot, why the
image artifact is signed before it ever touches a drive).

Do not use any real hospital data, real patient identifiers, or a real HL7 feed at any
point in this build.

Build Phase 3 only (Section 8, Section 2):

1. Base image build — minimal Debian/Ubuntu Server, stripped, read-only root FS where
   practical, small explicit writable data partition.
2. RAUC bundle pipeline — one build, signed, producing both the flashable artifact and
   its RAUC bundle for later OTA.
3. LUKS full-disk encryption, standard on every build, not optional.
4. First-boot provisioning script wired into the existing Phase 1 enrollment flow:
   keypair (TPM-sealed or LUKS-sealed fallback), short-lived cert from step-ca, quarantine
   until Phase 2 control plane confirms identity.
5. The Configurator tool itself — CLI (or GUI if genuinely faster) that lists
   releases/configs, detects attached drives with an unmissable confirm-target step,
   writes the signed image with a progress indicator, verifies the write afterward, and
   separately supports "save as standalone install file" — same artifact, two paths.
6. End-to-end test: build → flash via the tool → boot → confirm enrollment clears
   quarantine against the real Phase 1/2 control plane. Confirm the saved-file path
   flashes and boots identically via an independent method (e.g. dd).

Stop after Phase 3 is demoable and report back before continuing to Phase 4.
```

---

## 2. The core decision: don't build fifteen EHR integrations

Before laying out the vendor list, the architectural call this document is really making:

**Netbox does not build fifteen deep, vendor-certified EHR integrations.** That would mean
fifteen sets of vendor partnership agreements, interface certification processes, and
ongoing maintenance as each vendor revs its API — completely disproportionate to what a
monitoring appliance needs, and not something a small vendor selling into small, poor
hospitals can realistically sustain.

Instead, Netbox builds a **small number of protocol-level adapters**, plus a **per-site
config profile** that tells the device agent which adapter to point at which endpoint for
a given hospital. This is already implied by the main spec's design — the canonical event
schema's `service` field (Section 4) is a generic enum (`ehr | adt | lab | pharmacy |
imaging | eprescribe | ...`), and the L0–L4 tiers (Section 3) are defined by *check
depth*, not by vendor. This document just makes explicit what should sit behind that
generic layer.

The adapters to build, in priority order:

1. **HL7v2 passive tap** (already speced — the Python sidecar, Section 3). This alone
   covers ADT/ORU/ORM visibility for the large majority of target hospitals, because
   almost every one of the systems in Section 5 below still speaks HL7v2 for real-time
   clinical messaging even where it also offers a newer API.
2. **FHIR R4 read-only polling client.** A generic client that does an authenticated
   (SMART on FHIR / OAuth2 client-credentials or backend-services flow) read against a
   small, fixed set of low-risk endpoints — enough to prove the connection is live and
   measure latency, not to pull clinical data. This becomes universally useful in 2026 —
   see Section 7.
3. **Generic network checks** — already speced (L0 ICMP, L1 TCP port, L2 TLS handshake).
   Reused as-is against whatever host:port a given site's EHR, interface engine, or
   pharmacy gateway lives at.
4. **Interface-engine admin API reader** (new, see Section 4) — a read-only client against
   the local interface engine's own status API, where the hospital runs one.

A given hospital's config profile then just says, in effect: "this site's HL7 MLLP feed
listens on 10.20.0.12:2575, its FHIR base URL is https://ehr.example-hospital.org/fhir/r4,
its interface engine is Mirth Connect with an admin API at :8443, and its EHR vendor is
MEDITECH Expanse" — and the device agent picks the right adapter combination
automatically. Adding hospital #16 with a system not in the list below should mean
**writing a config profile, not writing new code**, unless that vendor genuinely uses a
transport none of the four adapters above can speak.

---

## 3. What Netbox watches, mapped to L0–L4

| Tier | Generic meaning (Section 3) | HL7v2-only system (older MEDITECH, Healthland, Client-Server tiers) | FHIR R4-capable system (Expanse, Community Connect, CommunityWorks, athenahealth, most 2026-current vendors) |
|---|---|---|---|
| L0 | ICMP/basic reachability | Ping the interface engine or EHR app server host | Ping the FHIR gateway host |
| L1 | TCP port open | MLLP port (commonly 2575 or site-specific) accepts a connection | HTTPS port accepts a connection |
| L2 | TLS handshake / cert valid | TLS on the MLLP listener if the site has it enabled (not universal — flag sites that don't) | TLS handshake against the FHIR base URL, cert validity |
| L3 | Authenticated synthetic transaction (customer-approved, non-disruptive only) | N/A for most HL7v2-only sites — there's no safe synthetic HL7 transaction to originate from a passive tap without risking being mistaken for real traffic, so L3 is usually skipped for these sites, not faked | A scoped, read-only FHIR query (e.g. `Patient/$read` on a known synthetic/test resource, or a metadata/capability-statement fetch) with a valid short-lived token |
| L4 | Confirmed real traffic observed | A real ADT/ORU/ORM message with a valid ACK seen recently on the passive tap | A real, successful FHIR transaction observed via passive proxy logging if available, otherwise fall back to L3 confirmation on a schedule |

The right-hand columns are guidance for Kimi when writing the per-vendor notes in Section
5 — they are not a new set of fields in the canonical schema. `tier_observed` stays exactly
the enum already defined in the main spec.

---

## 4. Interface engines — build against these first, before any EHR-specific work

Most target hospitals don't hand Netbox a raw feed from the EHR itself — they run a
**local interface engine** that already brokers HL7 traffic between the EHR, lab, pharmacy,
and other systems. Whoever runs that engine is often the single highest-leverage
integration point, because it's already terminating and routing every HL7 feed on site.

- **Mirth Connect / NextGen Connect** — free, open-source, and by a wide margin the most
  commonly deployed interface engine in exactly this market segment, because it's the only
  option a critical-access hospital's budget can absorb without a Rhapsody/Cloverleaf-class
  license. Build the read-only integration against **this one first**. It exposes a REST
  admin API that can report per-channel connector status (connected/idle/errored) without
  Netbox needing to see message contents — this is a legitimate, low-risk read that adds
  real signal for a large fraction of sites with one piece of code.
- **Rhapsody, Cloverleaf, Iguana** — present mainly at better-funded regional systems or
  larger CAH networks. Support these opportunistically (same admin-API-read pattern where
  the product exposes one) rather than building for them first — lower prevalence in this
  specific customer segment.
- **No interface engine at all.** Some smaller sites route HL7 directly between two or
  three systems with no broker in the middle. Here the HL7v2 passive tap (Section 2, #1)
  is the only signal source, and that's fine — it's what it was speced for.

---

## 5. Target system list

The systems below are what "10–15 EHRs/EMRs" concretely means for a rural/critical-access
/ small-hospital customer base, based on current (2026) market data. Ownership and
branding in this space has moved around a lot in the last few years — the notes column
flags that explicitly so nobody builds against a name that no longer owns the product.

| # | System | Current owner / brand | What it is | Why it's in scope here | Integration available | Realistic Netbox tier |
|---|---|---|---|---|---|---|
| 1 | **Epic** (Community Connect) | Epic Systems | Dominant inpatient EHR overall (~44% of all hospitals); reaches small hospitals via the Community Connect affiliate model, where a small hospital runs on a shared instance hosted by a larger Epic-using health system | Explicit ask; ~20% of rural EHR deployments run this model | FHIR R4 via the affiliate's sandbox, though parent-instance constraints apply (a Community Connect site often can't get its own isolated API credentials — flag this during site onboarding, don't assume it works like a standalone Epic install) | L0–L2 always; L3/L4 depends on whether the parent org grants API access |
| 2 | **Oracle Health** (Cerner, CommunityWorks tier) | Oracle (acquired Cerner in 2022) | Second-largest inpatient EHR (~19%); CommunityWorks is the small-hospital-specific deployment tier | Explicit ask; ~18% of rural EHR deployments | HL7v2 broadly available; FHIR R4 support present and improving | L0–L4 achievable |
| 3 | **MEDITECH** — three distinct product tiers, treat separately | MEDITECH (independent) | Largest single inpatient EHR footprint at small/rural hospitals (~22% of rural deployments; ~11% of all hospitals) | Single biggest rural segment — worth the extra care to get the tier distinction right | **Expanse**: FHIR-capable, modern. **Magic**: proprietary MTI-style APIs, not HL7-native in all deployments. **Client-Server (legacy 6.x)**: HL7v2 only, no modern API — many CAHs still run this | Expanse: L0–L4. Magic: L0–L2, HL7v2 tap if enabled. Client-Server: L0–L2 + HL7v2 tap, no FHIR |
| 4 | **TruBridge — Evident (Thrive)** | TruBridge (renamed from CPSI in 2023; Evident is CPSI's inpatient EHR brand) | Top-rated EHR vendor for small/rural hospitals for multiple consecutive years (Black Book survey) | Explicitly rural-focused vendor, high prevalence in target segment | HL7v2 standard; FHIR support varies by deployment vintage — confirm per site | L0–L2 guaranteed, L3/L4 where FHIR is present |
| 5 | **Healthland** | Folded into CPSI/TruBridge in 2016; legacy brand, no longer sold new | Older inpatient system still running at a meaningful number of smaller CAHs that haven't migrated off it | Legacy footprint — a real device will hit this even though it's not being sold anymore | HL7v2 only in essentially all remaining deployments | L0–L2 + HL7v2 tap; do not expect FHIR |
| 6 | **MEDHOST** | MEDHOST (independent) | Inpatient/ED-focused EHR with an explicit, active rural-hospital go-to-market (NRHA partner) | Explicit current rural-market positioning | HL7v2; increasing FHIR/cloud interoperability push per vendor's own 2026 messaging — confirm per site rather than assuming | L0–L2 always, L3/L4 where confirmed |
| 7 | **Altera Digital Health — Paragon / Sunrise** | Altera Digital Health (Harris/Constellation Software bought Allscripts' hospital business in 2022) | Paragon in particular was historically positioned as Allscripts' community/small-hospital tier product; Sunrise skews larger | Legacy Allscripts hospital footprint still present at smaller sites | HL7v2 standard | L0–L2 + HL7v2 tap |
| 8 | **athenahealth** | athenahealth (independent) | Cloud-native, strongest modern REST API maturity of any vendor in this list | ~15% of rural deployments, growing due to cloud-hosted model fitting IT-constrained hospitals | FHIR R4 native, well-documented | L0–L4 realistic |
| 9 | **NextGen Healthcare** | NextGen Healthcare (independent) | Ambulatory-heavy EHR, often the system running the hospital's attached rural health clinics even when the inpatient side runs something else | Very common pairing at CAHs with an RHC network | FHIR R4 available | L0–L4 realistic for the ambulatory side |
| 10 | **Veradigm** (formerly Allscripts, ambulatory side) | Veradigm (Allscripts' remaining ambulatory/data business, rebranded 2023) | Ambulatory EHR, distinct now from the hospital business sold off as Altera (#7) — don't conflate the two | Common at attached outpatient clinics | FHIR support present | L0–L3 realistic |
| 11 | **Azalea Health** | Azalea Health (independent) | Cloud-based, markets explicitly and specifically to critical access hospitals and rural health clinics | Explicit CAH/RHC positioning, appeared directly in rural-vendor research | FHIR-capable per vendor | L0–L3 |
| 12 | **Juno Health** | Juno Health (independent) | EHR positioned explicitly for rural, critical-access, and mid-size hospitals | Explicit CAH positioning | Confirm per deployment — newer/smaller vendor, verify FHIR maturity at each site rather than assuming | L0–L2 baseline, more if confirmed |
| 13 | **Netsmart** | Netsmart (independent) | Behavioral health EHR — many CAHs run an integrated behavioral health or substance-use unit on a separate system from the main inpatient EHR | Behavioral health is a common CAH service line requiring its own critical-service entry | HL7v2 typical | L0–L2 + HL7v2 tap |
| 14 | **WellSky** (also relevant: PointClickCare) | WellSky (independent) | Post-acute/long-term-care and swing-bed system — most CAHs operate swing beds (acute-to-long-term-care conversion), which runs on a system distinct from the main EHR | Swing beds are a defining CAH operational feature, not an edge case | HL7v2 typical for census/ADT feeds | L0–L2 + HL7v2 tap |
| 15 | **Sunquest / SCC Soft Computer** | Sunquest (independent); SCC Soft Computer (independent) | Laboratory information systems (LIS) — the actual system behind the "lab" critical-service entry in most hospitals; the EHR usually isn't where lab result flow originates | The canonical schema already has `service: "lab"` — this is what that maps to in the real world at most target sites | HL7v2 (ORU) standard | L0–L2 + HL7v2 tap, L4 via observed ORU/ACK |

**Smaller/niche mentions worth knowing about but not building a named profile for yet:**
Praxis EMR (concept-processing, template-free, small ambulatory practices) and a handful
of single-state or single-region vendors turn up in rural-market research but at low
enough prevalence that the generic adapters plus a config profile should cover them
without a dedicated row — revisit if a specific customer needs one.

---

## 6. Surescripts and the "and others" the user asked about

**Surescripts is not an EHR** — it's the national e-prescribing and medication-history
network that essentially every EHR in Section 5 connects through for e-prescribing,
prior authorization, and medication history. It uses the **NCPDP SCRIPT standard**
(the industry has been migrating deployments to SCRIPT v2017071 and later revisions) for
the actual prescription transactions, layered under Surescripts' own network
connectivity.

What "monitoring Surescripts connectivity" concretely means for Netbox, given the
passive/read-only design constraint: Netbox is never going to be the thing that
originates or intercepts a real prescription transaction — that stays entirely inside the
EHR's own certified e-prescribing module. What Netbox *can* legitimately check:

- Network path health to the EHR's configured Surescripts gateway endpoint (L0–L2, same
  generic checks as everything else).
- Passive observation, where the EHR's interface engine logs it, of e-prescribing
  transaction success/failure counts and timing — without ever seeing prescription content
  — mapped onto the existing `service: "eprescribe"` enum value.
- Do **not** build a native Surescripts network integration (it requires Surescripts'
  own vendor certification process and is squarely the EHR vendor's responsibility, not a
  monitoring appliance's). Netbox watches the connection from the outside; it doesn't
  join the network.

**Explicitly out of scope for now, noted for later if a customer needs it:** claims/
eligibility clearinghouses (Change Healthcare/Optum, Availity) sit adjacent to this same
space but serve billing/RCM rather than clinical or e-prescribing flow — don't build
toward these until there's a real customer requirement, per the same "don't build ahead of
demand" discipline as the rest of the spec.

---

## 7. The July 2026 interoperability mandate — this makes the job easier, not harder

As of **July 1, 2026, ONC USCDI v3 compliance is mandatory** for certified health IT —
certified EHRs must expose USCDI v3 data classes via FHIR R4 APIs, enforced through
information-blocking rules, and state Rural Health Transformation Program funding is
scoring vendors partly on USCDI v3 readiness. This is directly useful for Netbox: it means
the FHIR R4 read-only adapter (Section 2, #2) will increasingly have *something* to poll
even at hospitals running an otherwise-legacy EHR tier, closing the gap for sites that
would previously have been HL7v2-only. Build the FHIR adapter as a first-class citizen,
not an afterthought bolted onto the HL7 work — by the time Netbox is shipping devices in
volume, it should be the more broadly available signal, not the exception.

---

## 8. What Netbox does not do here (guardrails, restating the main spec's design)

This document adds vendor names and transport details; it does not loosen any constraint
already set in `NETBOX_BUILD_SPEC.md`:

- No PHI in the default `phi_mode: false` path, ever — metadata only, exactly as Section 4
  specifies, regardless of which vendor's feed it's reading.
- No write-back to any EHR, interface engine, or pharmacy network. Every integration in
  this document is read-only or passive-tap-only. Netbox never originates a clinical
  transaction, never places an order, never touches CPOE.
- No vendor substitution without flagging it — same rule as the main spec's Section 11/12
  prompts. If a target hospital's actual system isn't in Section 5 above, that's a config
  profile question first, a "build a new adapter" question only if none of the four
  protocol adapters can reach it at all.

---

## 9. Suggested build order for this piece specifically

Don't build all fifteen vendor profiles at once. Suggested sequence, layered into the main
spec's Phases 4–5 (device agent checks, HL7/MLLP sidecar):

1. Build the four generic adapters (Section 2) against a synthetic/test HL7 feed and a
   public FHIR R4 sandbox (e.g. a reference test server) — no real vendor system needed
   yet, same "no real hospital data or real HL7 feed" rule as Phase 1.
2. Write config profiles for the three highest-prevalence targets first — **MEDITECH
   (all three tiers)**, **TruBridge/Evident**, and **Epic Community Connect** — since
   together these cover roughly 60% of the rural EHR deployment landscape per current
   market data. Getting these three genuinely solid matters more than shallow coverage of
   all fifteen.
3. Add the Mirth Connect/NextGen Connect interface-engine reader (Section 4) — high
   leverage, low incremental cost, benefits most sites regardless of which EHR they run.
4. Layer in the remaining vendors from Section 5 as config profiles, roughly in the order
   listed, confirming actual FHIR/HL7 maturity per real customer site rather than trusting
   vendor marketing claims — the table above flags where "confirm per site" applies.
5. Surescripts connectivity monitoring (Section 6) can be built any time after the generic
   network-check adapter exists — it doesn't depend on any specific EHR profile.

---

## 10. Copy-paste prompt for Kimi — EHR/EMR integration layer

```
You are continuing work on "Netbox." Phases 1-3 from the main build spec (schema/PKI,
minimal control plane, Configurator) are done. You are now extending the Device Agent and
HL7/MLLP sidecar (Phases 4-5) to recognize real-world hospital systems. Read both
NETBOX_BUILD_SPEC.md and this document (NETBOX_EHR_INTEGRATIONS.md) in full before
starting — the second document is the "who are we plugging into" reference the first one
doesn't cover.

Do not build fifteen separate EHR integrations. Build exactly four protocol-level
adapters — HL7v2 passive tap (already speced), FHIR R4 read-only polling client, generic
network checks (already speced), and a Mirth Connect/NextGen Connect admin-API reader —
plus a per-site config profile schema that maps a hospital's real systems onto those four
adapters. Section 2 of NETBOX_EHR_INTEGRATIONS.md explains why.

Build order for this piece:
1. The FHIR R4 read-only adapter, tested against a public FHIR R4 sandbox — auth
   (SMART on FHIR backend-services flow), a capability-statement fetch, and one scoped
   synthetic-resource read, wired into the existing L0-L4 tiers and canonical schema.
2. The Mirth Connect / NextGen Connect admin API reader — read-only channel/connector
   status, no message content.
3. Config profiles for MEDITECH (all three tiers — Expanse, Magic, Client-Server),
   TruBridge/Evident, and Epic Community Connect, per Section 5's integration-method
   column. Use synthetic test data throughout; no real hospital data or real HL7 feed, per
   the same rule as every earlier phase.
4. Confirm end to end: a simulated site running each of the three profiles above reports
   accurate status through the full stack (device agent -> control plane -> console),
   including a deliberately-broken case (feed down) correctly showing degraded/down status
   rather than stale "last known good."

Stop after step 4 is demoable and report back before adding the remaining vendor profiles
from Section 5.
```
