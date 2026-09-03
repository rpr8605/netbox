# Netbox — Fleet Topology Views & Troubleshooting Memory

This is a companion document to the other four Netbox spec files. It does not replace
anything in them — the canonical event schema, incident records, RBAC, and the Alerting &
Escalation Engine's runbook concept are still governed by `NETBOX_BUILD_SPEC.md`. This
document covers three things Ryan asked for together, in dependency order — each one
builds on data the previous one produces:

1. Richer Fleet Console visualization — a geographic fleet map, plus confirming/extending
   the per-site interface topology view already speced in `NETBOX_EHR_INTEGRATIONS.md`
   Section 11.
2. A **troubleshooting memory** — deterministic, evidence-linked matching of a new incident
   against past incidents and their recorded resolutions. Explicitly **not** generative AI:
   no LLM, no narration, no guessing. This is case-based reasoning — a decades-old,
   fully transparent technique: match a new case's structured signature against a library of
   past cases, rank by similarity, show the evidence. Same discipline already applied to
   MsJaneHH's zero-AI compliance logic, carried over here.
3. **Ticketing system export** — not a ticketing system of Netbox's own, but a way to get a
   well-formed incident record into whatever ticketing system (or plain inbox) a hospital
   already uses, so Netbox never asks IT staff to adopt a second system.

---

## 1. Fleet Console visualization — three views, not one

Netbox's Fleet Console already has a per-site interface topology view and a cross-site
rollup list, speced in `NETBOX_EHR_INTEGRATIONS.md` Section 11. This document adds a third:

| View | Scope | Status | Shows |
|---|---|---|---|
| Per-site interface topology | One site | Already speced (§11) | Nodes = systems, edges = interface-engine channels, edge color = live status |
| Cross-site rollup | Every site, list form | Already speced (§11) | Sortable list, worst channel status + degraded count per site |
| **Geographic fleet map** (new) | Every site, map form | New in this document | Every monitored site plotted by location, pin color = overall site status |

The geographic map is genuinely cheap: it needs one new field (`lat`, `lng`) on each site's
config profile, and reuses the exact same status enum (`reachable/verified_ready/active/
degraded/down/unknown`) already computed for every other view. No new backend logic —
this is a rendering choice over data that already exists, same as the cross-site rollup.
RBAC applies identically to the existing rollup view: customer IT admin sees only their own
site's pin; operations manager and support technician see the whole fleet.

**What this is not:** a physical-network diagram (routers, switches, cabling). That's a
different, much heavier scope (network discovery, SNMP topology mapping) that isn't asked
for here and isn't in scope per the existing "no general facilities" boundary in
`NETBOX_CONTROLS_AND_IDENTITY.md` §1. This is "where are my sites, and are they healthy" —
a fleet-management view, not a network-engineering tool.

---

## 2. Troubleshooting memory — the actual mechanism

### 2.1 Why this is case-based reasoning, not AI narration

`NETBOX_EHR_INTEGRATIONS.md` §11 explicitly rules out "AI-generated explanation of what a
broken interface means" as out of scope for Netbox — that line stands. What's speced here
is different in kind, not just in degree: no model generates text about an incident. A
structured comparison runs against a library of past, human-confirmed cases, and the output
is a ranked list of prior matches with their outcomes — never a generated sentence claiming
to know what's wrong. If a future engineer is ever tempted to swap the matching logic for an
LLM call "to make the suggestions better," that's the line to point at and say no.

### 2.2 Data model additions

Two additions to the schema already in `BUILD_SPEC` §4, both append-only, both keyed to an
existing `incident` record:

```json
// incident_signature — captured automatically the moment an incident opens
{
  "incident_id": "uuid-v4",
  "site_id": "client-scoped-uuid",
  "service": "ehr | adt | lab | pharmacy | ...",
  "tier_at_failure": "L0 | L1 | L2 | L3 | L4",
  "status_transition": "reachable->down | verified_ready->degraded | ...",
  "vendor": "MEDITECH Client-Server | Epic Community Connect | ...",
  "interface_engine": "mirth | nextgen | rhapsody | cloverleaf | iguana | none",
  "co_occurring_signals": ["security_signal:after-hours-signin", "backup_risk:tier1-flag"],
  "time_of_day_bucket": "overnight | business-hours | after-hours",
  "opened_at": "2026-09-02T03:14:00Z"
}

// resolution_record — filled in by a human when the incident closes, never inferred
{
  "incident_id": "uuid-v4",
  "root_cause_category": "isp-circuit-failure | interface-engine-deadlock |
    vendor-maintenance-window | expired-cert | credential-lockout | other",
  "root_cause_note": "free text, optional",
  "action_taken": "restarted HL7 listener via Action Registry entry X | manual vendor call | ...",
  "time_to_resolve_min": 12,
  "closed_by": "support-technician-user-id",
  "closed_at": "2026-09-02T03:26:00Z"
}
```

`root_cause_category` starts as a short, deliberately narrow controlled list — resist the
urge to make this free-text-only or infinitely open-ended, since the matching in 2.3 depends
on categories repeating across incidents. Add new categories as real incidents demand them;
don't pre-populate a long guessed list before there's real data.

### 2.3 The matching logic — deterministic, ranked, evidence-linked

When a new incident opens, compute its `incident_signature` the same way, then query past
`incident_signature` + `resolution_record` pairs (fleet-wide, not just this site) for
matches, weighted roughly:

1. Exact match on `service` + `vendor` + `status_transition` — highest weight.
2. Match on `service` + `status_transition` only (different vendor) — medium weight.
3. Match on `co_occurring_signals` overlap — adds weight to either of the above, doesn't
   stand alone as a match basis.

This is a plain weighted-overlap score, not a trained model — implement it as a real,
readable scoring function Kimi can hand-trace, not a black box. Rank matches by score, take
the top N (5 is a reasonable start), and surface:

- How many past incidents matched, and how closely.
- The distribution of `root_cause_category` among them (e.g., "3 of 4 were interface-engine
  deadlock").
- The distribution of `action_taken` among successful resolutions, with median
  `time_to_resolve_min`.
- **A link to each matched incident**, so a technician can open the actual past case and
  verify the match makes sense rather than trusting the ranking blindly.

**Cold-start honesty, non-negotiable:** if there are zero matches above a minimum
similarity threshold, the console shows "No matching incident history yet" — not a weak
guess, not a generic runbook link dressed up as a match. A new site's first incident, or a
genuinely novel failure mode, should look exactly like what it is: uncharted.

### 2.4 Where this shows up in the Fleet Console

On an open incident's detail view (a new panel, not a replacement for the existing runbook
attachment from `BUILD_SPEC` §6): "Similar past incidents" — the ranked list from 2.3.
This sits alongside, not instead of, the client-approved runbook already attached to the
alert. The runbook is the customer-approved standard response; this panel is "here's what
actually worked before, and how often," which is a different and complementary kind of
information a support technician uses to decide how to act.

---

## 3. Ticketing system integration — don't build a ticketing system

Netbox does not build a ticketing/ITSM system, full stop. Every target hospital already has
one (or at minimum an IT inbox), and hospital IT staff already live inside it — asking them
to also check a second system is a real adoption cost, not a neutral addition. Netbox's job
is to make it trivial to get a well-formed incident record **into** whatever the hospital
already uses, using the exact same "adapter, not reinvention" philosophy already applied to
EHRs (`NETBOX_EHR_INTEGRATIONS.md` §2) and identity providers (`NETBOX_CONTROLS_AND_IDENTITY.md`
§4). Two tiers, in build order:

**Tier 0 — universal, build first, zero integration risk.** Every incident already carries,
or will once Section 2 above is built: a title, severity, the plain-language impact
statement (`BUILD_SPEC` §6), affected service and site, the attached runbook, and the ranked
"similar past incidents" match with its suggested action. Render this as one clean,
copy-paste-ready block (plain text, and Markdown for systems that render it) in the Fleet
Console with a one-click "Copy" button. Pair it with a "Send as email" action, reusing the
Alerting Engine's existing SES/SendGrid pipe (`BUILD_SPEC` §6) — addressed to whatever inbox
the hospital configures at onboarding, whether that's their ticketing system's own inbound
address or just their IT team's mailbox. This alone works with **any** ticketing system,
including ones with no API at all, because essentially every ticketing tool — and every
plain inbox — can turn an email into a ticket. No vendor integration, no API credentials, no
per-vendor certification, and it covers the hospital running nothing more formal than a
shared inbox just as well as one running a real ITSM platform. Build this well — it's the
floor every site gets, not a placeholder for something better later.

**Tier 1 — optional, per-site, build only once a real customer asks.** A generic outbound
REST ticket-creation adapter: one piece of code, config-profile-driven per vendor (endpoint
URL, auth header or API key, field-name mapping) — same pattern as the EHR config-profile
approach, not a bespoke integration per ticketing platform. Don't guess at which vendors
(ServiceNow, Freshservice, Jira Service Management, Zendesk, or something smaller and
cheaper, which is plausible given this customer base's budgets) are actually prevalent here
— confirm per real customer before building a named field-mapping for any of them, same
"don't build ahead of demand" discipline as the rest of this project. Ticket creation is a
write to a system outside Netbox's own control plane, so it gets the same treatment as any
other outbound action: opt-in per site during onboarding, credentials scoped to
ticket-creation only (nothing broader), and every creation logged to the same audit trail as
everything else in `BUILD_SPEC` §5.

---

## 4. Build order for this piece

1. Geographic fleet map — add `lat`/`lng` to the site config profile, build the map view.
   No dependency on anything else in this document; can build any time.
2. `incident_signature` capture, wired to fire automatically the moment an incident opens
   (reuses fields already on the canonical event/incident shape from `BUILD_SPEC` §4).
3. `resolution_record` — the close-incident UI flow where a technician picks a
   `root_cause_category` and records `action_taken`. This is the piece the whole feature
   depends on having real data in, so get the UX for filling it in right — if it's tedious,
   technicians will skip it and the memory stays empty.
4. The matching function (2.3) and the "Similar past incidents" panel (2.4). Build and test
   this against a seeded synthetic incident history (at least 15-20 fake past incidents
   across a few sites/vendors/categories) so the ranking logic can actually be exercised
   before there's real fleet history to test against.
5. Confirm the per-site interface topology view from `NETBOX_EHR_INTEGRATIONS.md` §11 is
   still on track separately — this document doesn't change that work, just sits next to it.
6. Ticketing Tier 0 (Section 3) — the copy-paste block and "Send as email" action. Build
   this once the incident detail view exists (step 4), since it renders the same content
   that view already assembles. No dependency on Tier 1.
7. Ticketing Tier 1 (Section 3) — the generic REST adapter — stays unbuilt until a real
   customer names a specific system to support.

---

## 5. Copy-paste prompt for Kimi — fleet map + troubleshooting memory + ticketing export

```
You are continuing work on "Netbox." Read NETBOX_TOPOLOGY_AND_TROUBLESHOOTING_MEMORY.md in
full before starting. This adds a geographic fleet map to the Fleet Console and a
troubleshooting memory feature. The troubleshooting memory is explicitly NOT AI — no LLM
call, no generated narration, anywhere in this feature. It is a deterministic, hand-tracable
matching function over structured past-incident data, with every suggestion linked back to
the real past incidents it matched. If you find yourself reaching for a model call to
"improve" a suggestion, stop and flag it instead — that's out of scope here, not an
implementation detail to fill in.

Build in this order, stopping to report after each numbered step:

1. Add lat/lng to the site config profile and build the geographic fleet map view in the
   Fleet Console — pins colored by the existing overall site status enum, same RBAC scoping
   as the existing cross-site rollup view (customer IT admin sees only their own site).

2. Add incident_signature capture, firing automatically when an incident opens, using the
   exact shape in Section 2.2. Add resolution_record, filled in by a human when an incident
   closes via a simple close-incident UI flow — root_cause_category from a short controlled
   list (start with the categories listed in Section 2.2), action_taken, time_to_resolve_min.

3. Build the matching function from Section 2.3 as a plain, readable weighted-scoring
   function — not a trained model, not an external call. Seed a synthetic incident history
   (15-20 fake past incidents across a few sites, vendors, and root-cause categories) to
   exercise it, since there's no real fleet history yet.

4. Build the "Similar past incidents" panel on the incident detail view (Section 2.4): the
   ranked match list, the root-cause and action-taken distributions, and a link to each
   matched incident. When there are zero matches above threshold, show "No matching incident
   history yet" — do not show a weak or generic match dressed up as a real one.

5. Build ticketing Tier 0 only (Section 3): a copy-paste-ready formatted block of the
   incident's title, severity, plain-language impact, affected service/site, attached
   runbook, and (if present) the similar-past-incidents match — with a one-click Copy
   button — plus a "Send as email" action reusing the existing SES/SendGrid pipe, addressed
   to a per-site configurable inbox. Do not build a REST ticket-creation adapter for any
   named vendor (ServiceNow, Freshservice, Jira, Zendesk, or otherwise) as part of this pass
   — that is Tier 1, explicitly deferred until a real customer names a system, per Section 3.

Use synthetic data throughout, same rule as every earlier phase. Stop after step 5 is
demoable and report back.
```
