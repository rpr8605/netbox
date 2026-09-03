# Netbox — Network Controls, Action Registry, and Identity-Provider Visibility

This is a companion document to `NETBOX_BUILD_SPEC.md` and `NETBOX_EHR_INTEGRATIONS.md`. It
does not replace anything in either — architecture, tech stack, schema, and build order are
still governed there. This file covers three things Ryan asked to think through together,
because they're actually one design decision, not three separate features:

1. Expanding the critical-service register to cover site network health (not general
   facilities), decided in the prior conversation.
2. A cheap, safe way to both monitor *and* eventually take limited remote action, without
   building a second control channel or a new attack surface.
3. Baking in Microsoft 365 / Entra ID account-health visibility, since a large share of
   real-world hospital IT problems are account problems, not application problems — with
   a phased, deliberately conservative approach to how much write access that actually
   means, based on real research into what Microsoft's own permission model allows.

Hand this to Kimi alongside the other two documents when this phase of work starts.

---

## 1. Scope decision, restated plainly

**In scope — site network controls, because they explain *why* a critical service is down:**
WAN/ISP circuit health (including failover detection where a backup circuit exists), core
firewall/router reachability, DNS/DHCP health where the hospital runs its own, wireless AP
health (bedside scanning and mobile carts depend on this — patient-safety-adjacent, not a
generic IT nicety), site-to-site VPN tunnel health, backup/DR job success status for EHR
and pharmacy systems, Active Directory / identity-provider health, TLS certificate
expiration on internal systems, antivirus/EDR agent check-in status.

**Out of scope, deliberately — general facilities:** HVAC comfort systems, door access
control, cameras, generator/emergency power beyond the IT closet, fire/life-safety systems.
Different buyer, different protocols (BACnet, Modbus, proprietary access-control APIs),
and a market already served by mature, cheap competitors. Building toward this dilutes the
thing that actually makes Netbox defensible — deep healthcare-IT and EHR knowledge, not
generic building automation.

**Narrow exception, later, not now:** server room / IT closet environmental monitoring
(temperature, humidity, water leak, UPS/battery status for the room housing the appliance
and core network gear). This protects the IT stack Netbox already depends on rather than
managing the building. Needs a small hardware sensor add-on, so it's a separate, later
phase — noted here so it isn't forgotten, not built in this pass.

---

## 2. The Action Registry — how monitoring and control share one cheap, safe transport

Netbox already has the right pattern for taking any remote action safely: the **remote
support session broker** in `NETBOX_BUILD_SPEC.md` Section 7. The device holds an
outbound, mutually-authenticated connection at all times. An authorized person requests a
session; the device picks up a time-limited, scoped token over that existing connection and
opens an *outbound* tunnel for the action. No standing inbound port, no shared credential,
every session is itself an audit-logged event.

**Generalize that exact pattern into an Action Registry, rather than building a second
channel for "control" separate from "monitoring."** This keeps cost down (no new
infrastructure) and keeps the security story simple (one reviewed mechanism, not two).

The Action Registry is a small, explicit, per-site whitelist of approved action types —
not general remote code execution, not a shell, not an open API a device could be tricked
into calling arbitrarily. Each entry looks like:

```json
{
  "action_id": "restart-service | toggle-port | ms365-password-reset-nonadmin | ...",
  "site_id": "client-scoped-uuid",
  "requires_role": "support_technician | operations_manager | customer_it_admin",
  "requires_session": true,
  "max_scope": "description of exactly what this action can touch and nothing else"
}
```

Every action execution: requires a live, human-initiated session (never autonomous, never
triggered by an alert firing on its own), is scoped to exactly one pre-registered action
type per invocation, and is written to the same append-only audit log as everything else in
Section 5 of the main spec. If a new action type isn't on the registry for that site, it
cannot be performed — adding a new action type is a deliberate config change, not something
a session can improvise.

**What this buys you concretely:** the network-control items above start read-only (that's
most of their value — knowing the firewall is down versus the ISP circuit is down is
already the win). Where a genuinely safe, narrow action exists later (restart a specific
monitored service, toggle a specific port), it's added to the registry as its own reviewed
entry, not as a side effect of "we already have the tunnel, might as well."

---

## 3. Network controls — technical approach per item

| Control | Read-only visibility (build now) | Possible future action (Action Registry entry, not built yet) |
|---|---|---|
| WAN/ISP circuit health | Dual-path ping/traceroute against known-good external targets from both primary and backup circuits if present; detect failover events | None planned — failover is usually automatic hardware behavior, not something to trigger remotely |
| Core firewall/router reachability | Existing generic network-check adapters (ICMP/TCP/TLS) against the gateway IP, now registered as a first-class critical service instead of an incidental target | None planned |
| DNS/DHCP health | DNS: resolve a known-good hostname against the site's configured resolver, alert on failure/timeout. DHCP: only where the hospital's DHCP server exposes a health check; otherwise infer from lease-renewal failures reported by monitored endpoints | None planned |
| Wireless AP health | Where the AP controller exposes a status API (most enterprise Wi-Fi controllers do), read-only poll of AP up/down and client-count anomalies | None planned |
| Site-to-site VPN tunnel | Tunnel-interface-up check plus a ping through the tunnel to a known endpoint on the other side | None planned |
| Backup/DR job status | Read the vendor's own backup-completion log or status API where accessible (read-only) — do not build backup software, just report on what's already there | None planned |
| TLS certificate expiration | Periodic cert inspection (expiry date, issuer, chain validity) on every endpoint Netbox already checks — this is nearly free, since the TLS handshake step (L2) already exists | None planned |
| AV/EDR agent check-in | Read local agent status file or vendor API where accessible, report last-check-in time and definition freshness | None planned |
| Active Directory / identity provider health | Covered in full in Section 4 below | Covered in full in Section 4 below |

Every row above reuses adapters and check tiers that already exist in the main spec (L0-L2
generic network checks, the existing TLS handshake step) or reads a status source that's
already there rather than requiring new hardware or new vendor certification — consistent
with the "don't build fifteen deep integrations" discipline from the EHR document.

---

## 4. Microsoft 365 / Entra ID — what's actually safe to build, based on real permission research

Before writing anything here, the actual Microsoft Entra ID built-in role permissions were
checked directly rather than assumed, because "just bake in account management" undersells
how much privilege that phrase implies. Two findings changed the design:

**Finding 1 — no built-in Entra role can unlock an account or revoke a sign-in session.**
Not Helpdesk Administrator, not Password Administrator, not Authentication Administrator.
Those actions require Global Administrator or Privileged Role Administrator — effectively
full tenant-admin-adjacent access. That is not a grant a third-party on-prem appliance
should ever hold at a hospital, full stop.

**Finding 2 — a lot of this customer base is hybrid, not cloud-native.** Many rural
hospitals still run on-prem Active Directory as the source of truth, synced to Entra ID via
AD Connect. "Account locked" in that environment usually means locked in the on-prem
domain, which needs domain credentials and PowerShell/LDAP access to fix — a categorically
bigger and riskier integration than a Graph API call, and not one this document
recommends building. A compromised or buggy appliance holding domain-admin-adjacent write
access is the kind of incident that ends a small vendor's hospital contracts.

**What to actually build, in two phases:**

### Phase 1 — read-only account health visibility (build this)

App-only Graph API access via a registered Entra ID application, granted exactly these
scopes and nothing broader, admin-consented once per customer tenant during onboarding:

- `User.Read.All` — account status, lockout state, basic profile
- `AuditLog.Read.All` — recent sign-in failures and patterns
- `Organization.Read.All` — AD Connect / directory sync health
- `Reports.Read.All` — license assignment and MFA enrollment status

This alone answers the question that actually matters most of the time: "is this an
account problem, not an application problem." Surface it in the Fleet Console as another
row in the per-site status view (same pattern as the interface-topology work) — account
sync health, recent sign-in failure spikes, license/MFA gaps — with no write capability
anywhere in this phase.

### Phase 2 — account remediation as a support service, not a standing app credential

Revised after checking Microsoft's own recommended pattern for exactly this situation
(an outside vendor providing account support into a customer's tenant): don't have Netbox,
or any always-on app registration tied to it, hold write credentials into a customer's
tenant at all, even scoped ones. Microsoft has a purpose-built mechanism for this that is
safer and a better sales story:

**Cloud-native Entra ID tenants — become a Microsoft CSP indirect reseller and use GDAP
(Granular Delegated Admin Privileges).** GDAP requests are per-customer, require the
hospital's explicit approval, are scoped to specific narrow Entra roles (Password
Administrator, for instance, never Global Administrator), and the hospital can see and
revoke the grant themselves at any time. Layer Microsoft Entra PIM on top so that even
inside an approved GDAP relationship, a support technician has to actively request
elevation for a specific incident, with a justification and a time limit, fully logged. No
standing credential exists on an ordinary day — access only exists for the duration of an
approved, logged support action. Indirect reseller status has no minimum size or fee
requirement per Microsoft's own documentation, so this is a realistic path for a small
vendor, not something that requires being a large Microsoft partner.

**Hybrid or on-prem Active Directory tenants — guided support, not credentialed access.**
Don't attempt remote domain credentials at all; the blast radius if that ever went wrong is
too severe for a small vendor to carry. Instead, reuse the remote-support session broker
(Section 2 above / `NETBOX_BUILD_SPEC.md` Section 7) as a guided-support channel: a support
technician opens a time-limited, audit-logged session over the existing outbound tunnel and
walks the hospital's own IT person through the fix, or screen-shares while the hospital's
own already-logged-in domain account performs the action. The expertise is yours; the
credential and the action stay theirs.

**Commercial framing:** package this as a support tier ("Managed Account Support" or
similar), sold as an add-on to Netbox, not a feature of the appliance's software. This is
both the safer architecture and the better story in a hospital security review — "our
support team can assist through Microsoft's own vetted, revocable, fully-auditable partner
access model" instead of "our appliance holds account-management credentials."

No unlock, no session revocation, no admin-account actions, on any tenant, cloud or hybrid
— those stay out of scope per Finding 1 above regardless of which access model is used.

### Other identity providers — later, same adapter philosophy as the EHR work

Don't build three parallel identity integrations. Build one generic identity-provider
adapter interface, with Microsoft Graph as the first real implementation. Okta and Google
Workspace both expose comparable admin APIs with similarly tiered read/write scopes —
worth a real look once the Microsoft piece is live and proven with an actual customer, not
before. This is explicitly a "don't build ahead of demand" item.

---

## 5. Build order for this piece

1. Register the four network-control read-only items (WAN/ISP, firewall/router, DNS/DHCP,
   TLS cert expiration) as first-class critical services in the schema's `service` enum and
   config-profile model — these reuse existing adapters entirely, lowest-effort, do first.
2. Wireless AP health and VPN tunnel health — same read-only pattern, slightly more
   variable per-site (controller APIs differ), so these come second.
3. Backup/DR job status and AV/EDR check-in — read-only, but depend on what each site's
   specific backup/AV vendor exposes, so build the generic "read a status source" pattern
   once and confirm per site rather than assuming a universal API.
4. The Action Registry itself (Section 2) — build the whitelist/session-gating mechanism
   as its own piece of infrastructure before any specific action uses it.
5. Microsoft Graph Phase 1 (read-only account health) — build against a real Entra ID test
   tenant, not a hospital's real tenant, same "no real hospital data" discipline as
   everything else in this project.
6. Stop. Microsoft Graph Phase 2 is now explicitly a business/access-management process
   (Microsoft CSP + GDAP + PIM for cloud tenants, guided support sessions for hybrid/on-prem
   AD), not appliance code — see Section 4. There is no Phase 2 engineering task for Kimi to
   build. Any other-provider work (Okta, Google Workspace) is a separate, later, unstarted
   phase.

---

## 6. Copy-paste prompt for Kimi — network controls + Action Registry + Microsoft Graph Phase 1

```
You are continuing work on "Netbox." Read NETBOX_CONTROLS_AND_IDENTITY.md in full before
starting. This is new scope, not a continuation of the EHR/interface work — confirm you
understand the distinction in this document between "network controls" (in scope) and
general facilities monitoring (explicitly out of scope) before writing anything.

Build in this order, stopping to report after each numbered step:

1. Add WAN/ISP circuit health, core firewall/router reachability, DNS/DHCP health, and TLS
   certificate expiration as first-class entries in the critical-service register and
   config-profile schema. These reuse the existing generic network-check adapters and the
   existing TLS handshake step — do not build new adapters for these four.

2. Add wireless AP health and site-to-site VPN tunnel health, read-only, via each site's
   controller/tunnel status where exposed. Confirm per simulated site rather than assuming
   a universal API shape.

3. Add backup/DR job status and AV/EDR agent check-in as a generic "read an external status
   source" pattern (log file or vendor API), read-only, confirmed per site.

4. Build the Action Registry as its own piece of infrastructure: a per-site whitelist of
   approved action types, each requiring a live human-initiated session issued through the
   existing remote-support session broker (NETBOX_BUILD_SPEC.md Section 7), audit-logged
   on every execution. No action type should be callable unless it is explicitly registered
   for that site. Do not build any actual action yet — just the registry and session-gating
   mechanism, tested with a single harmless dummy action type to prove the flow end to end.

5. Build Microsoft Graph Phase 1 only: read-only account-health visibility via a registered
   Entra ID app scoped to exactly User.Read.All, AuditLog.Read.All, Organization.Read.All,
   and Reports.Read.All — nothing broader. Surface account sync health, sign-in failure
   spikes, and license/MFA gaps in the Fleet Console per-site view. Test against a real
   test Entra ID tenant, never a real hospital's tenant.

Do not build any Microsoft Graph write action, password reset included, account unlock,
session revocation, or any other identity provider (Okta, Google Workspace) as part of
this pass. Per Section 4, account remediation beyond Phase 1 is now a business/access
process (Microsoft CSP + GDAP + PIM for cloud tenants, guided support sessions for
hybrid/on-prem AD), not appliance code — there is nothing here for you to build. Unlock and
session revocation specifically should never be built into the appliance at all, regardless
of access model, given the privilege level Microsoft's own role model requires for those
actions.

Stop after step 5 is demoable and report back.
```
