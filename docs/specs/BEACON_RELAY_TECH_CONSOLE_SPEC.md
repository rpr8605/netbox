# Beacon Relay Tech Console: Build Spec (v1)

**Status:** Design approved by Ryan, 2026-09-23. Ready to build after the prerequisites below.
**Design references:** `docs/design/tech-console/*.dc.html` (read `docs/design/tech-console/README.md` first).
**Replaces:** `control-plane/public/index.html`, `topology.html`, `fleet.html` once the new console reaches parity.
**Does not replace:** the on-device downtime page (`beacon-relay-agent/lib/downtime.js`). That stays as is.

---

## 0. Read this first (for the build agent)

1. **Prerequisites, in order. Do not skip.**
   - Security review Batch 1 (`docs/reviews/2026-09-23-independent-review.md`) must be closed first.
   - **Operator login + MFA (review finding C1) must exist before this console runs anywhere except
     localhost.** Until C1 lands, build behind a clearly named dev-only auth stub
     (`CONSOLE_DEV_AUTH=1`, refuses to start if `NODE_ENV=production` or if `BIND_HOST` is not
     `127.0.0.1`). The console shows every hospital, so it must never be exposed without real auth.
2. **Build screen by screen** in the order in section 9. Checkpoint after each screen.
3. **Every new API route declares an auth policy** and is covered by the route-policy test from review finding H3.
4. **PHI rule, everywhere:** the console only ever shows metadata (site, service, status, times, counts,
   device IDs). No patient names, MRNs, message content, or free text from HL7. Free-text fields that
   humans type (support log notes, resolution notes) go through `control-plane/src/phi_guard.js` on the
   server, with the "no patient identifiers" warning in the UI.
5. **Never guess.** If this spec and the design disagree, the design wins for visuals and this spec wins
   for behavior and data. If something is still unclear, log it to `.agent/open-questions.md` and move on.

---

## 1. Tech choice and file layout

- **Stack:** React 18 + TypeScript + Vite. Plain CSS with CSS variables (tokens in section 2). No UI kit.
- **Location:** new package at `control-plane/console/`.
  ```
  control-plane/console/
    package.json, vite.config.ts, tsconfig.json, index.html
    src/
      main.tsx, App.tsx, routes.tsx
      api/            # typed fetch client, one module per resource
      components/     # Sidebar, StatusCell, StatusPill, SeverityBadge, Tabs, MetricTile, etc.
      screens/        # Board, Alerts, AlertDetail, Fleet, SiteOverview, SiteSupport, SiteTopology, Routing
      theme/tokens.css
      status.ts       # the single status mapping (section 3)
    test/
  ```
- **Serving:** `vite build` outputs to `control-plane/console/dist/`. Fastify serves it at `/console/`
  (static, with SPA fallback to `index.html` for `/console/*`). Add the build to the control-plane Dockerfile.
- **Data refresh:** poll every 10 s on the Master board and Alerts screens, 30 s elsewhere. (Server-sent
  events can come later; not in v1.)
- **Demo mode:** when `GET /api/demo` returns `{demo:true}`, show the "Sample data" badge in each header
  (as in the design). Never show it otherwise.

---

## 2. Design tokens (copy exactly into `src/theme/tokens.css`)

| Token | Value | Use |
|---|---|---|
| `--ground` | `#F2F3F0` | page background |
| `--surface` | `#FFFFFF` | cards, panels, headers |
| `--surface-muted` | `#F4F6F2` | table headers, map background |
| `--line` | `#DCDFD8` | card borders, dividers |
| `--line-soft` | `#EEF0EC` | row dividers |
| `--control-border` | `#C5CAC3` | buttons, inputs |
| `--ink` | `#17201C` | primary text |
| `--ink-2` | `#3E4742` | secondary text |
| `--muted` | `#5A635E` | labels, captions |
| `--accent` | `#1F4FB8` | links, primary buttons, selection |
| `--accent-bg` | `#EEF3FD` | selected row/node background |
| `--sidebar` | `#17201C` | sidebar background |
| `--sidebar-active` | `#2A3831` | active nav item |
| `--sidebar-text` | `#C9D0CB` | nav text |
| `--ok` / `--ok-bg` / `--ok-cell` | `#1E7042` / `#E3F1E8` / `#CFE8D8` | Working |
| `--warn` / `--warn-bg` / `--warn-cell` | `#8A5A00` / `#FBF0D9` / `#F5C66B` | Degraded |
| `--down` / `--down-bg` | `#A8261B` / `#FBE4E1` | Down (cells use solid `--down` with white glyph) |
| `--unknown` / `--unknown-bg` | `#555E66` / `#E4E6E8` | No data / not reporting |
| `--standby` / `--standby-bg` | `#1F4FB8` / `#E6EEFB` | Standby, passive (LTE backup, Beacon Link) |
| `--reported` / `--reported-bg` | `#6A3FB0` / `#EFE8FA` | "Reported by hospital" tag |

- **Fonts:** IBM Plex Sans (400/500/600) for everything; IBM Plex Mono (400/500) for times, IDs, counts.
  Self-host the font files in `control-plane/console/public/fonts/` (hospital networks may block Google Fonts).
- **Radii:** 12 px cards, 10 px inner boxes and nodes, 8 px buttons and inputs, 6 px pills.
- **Buttons and clickable rows:** minimum 44 px tall (36 px allowed only for filter chips).
- **Sidebar:** 240 px fixed. **Content** min width 1200 px (desktop tool; a tablet/phone layout is out of scope for v1).

---

## 3. Status vocabulary (one mapping, `src/status.ts`)

The canonical event schema statuses map to exactly five UI states. Use this everywhere; never invent another.

| Schema `status` | UI state | Label | Cell glyph | Color tokens |
|---|---|---|---|---|
| `active`, `verified_ready` | working | Working | (none) | ok |
| `reachable` | working | Working (shows tier note, e.g. "L0 reachable only") | (none) | ok |
| `degraded` | degraded | Degraded | `~` | warn |
| `down` | down | Down | `!` | down |
| `unknown` or no events | nodata | No data | `?` | unknown |
| service not configured for site | notmonitored | Not monitored | `·` | surface-muted / `#8A918C` |

**Never rely on color alone.** Every status shows a glyph or a word as well (accessibility requirement).

**Site rollup** (for the Master board, Fleet, sidebar counts): worst state across the site's configured
services. A site whose device has never heartbeated or is quarantined is **Not reporting**.

**Response state** (per site and per alert), shown in the Master board "Response" column and Alerts list:

| Condition | Label | Color |
|---|---|---|
| No open alerts | All working | ok |
| Open alert(s), all acknowledged | Responding · `<who>` ack `<time>` | accent |
| Any open alert unacknowledged | No response · `<minutes>` min · `<tier>` paged | down (row tinted `#FDF3F1`) |
| Device not reporting | Not reporting · `<reason>` | unknown |

---

## 4. Service groups (the 20 critical services)

Order and abbreviations used by the Master board grid and Site Overview. Enum names are from
`schemas/beacon_relay_event.schema.json` / `CRITICAL_SERVICES` in `topology_view.js`.

| Group | Services (enum → label → grid abbreviation) |
|---|---|
| Clinical systems | `ehr` EHR `EHR` · `adt` ADT `ADT` · `lab` Lab `LAB` · `pharmacy` Pharmacy `RX` · `imaging` Imaging `IMG` · `eprescribe` e-Prescribing `eRX` |
| Interfaces | all channels for the site, rolled up into one cell `IF` (worst channel state) |
| Network and site | `internet` Internet `NET` · `wan` WAN circuit `WAN` · `firewall` Firewall `FW` · `dns` DNS `DNS` · `dhcp_health` DHCP `DHCP` · `wireless_ap_health` Wireless `WIFI` · `vpn_tunnel_health` VPN `VPN` · `phone` Phones `TEL` · `printing` Printing `PRN` |
| Security and identity | `cert_expiration` Certificates `CERT` · `m365_account_health` Microsoft 365 `M365` · `backup_dr_status` Backups `BKUP` · `av_edr_checkin` Antivirus/EDR `EDR` |
| (not shown in grid) | `custom` Custom check: shown on Site Overview under Interfaces only if configured |

If a new service enum is added later, it **must** be added to this table and `status.ts` in the same
change, or the route/UI test fails (add a test that every enum in the schema is mapped to a group).

---

## 5. Screens

Sidebar on every screen (design: any file, `<nav>`): logo + "Service desk"; items **Master board**,
**Alerts** (red badge = count of unacknowledged open alerts), **Fleet** (site count), **Sites**,
**Alert routing**, **Support sessions**, **Audit log**; footer shows the signed-in user's name, role, and
"MFA verified" (from the auth session; hide the MFA line until C1 exists). Items the user's role can't
access are hidden, not disabled (RBAC map in `control-plane/src/rbac.js`).

### 5.1 Master board: `/console/` (design: `Board.dc.html`)
**Job:** answer "is everything OK, and if not, is someone on it?" in under 3 seconds.
- **Verdict bar:** icon + headline ("All 8 sites working" / "2 of 8 sites have issues") + sentence
  ("1 is being worked by the service desk. 1 has no response yet (9 min). 5 sites are fully working.")
  + "Updated hh:mm:ss · refreshes every 10 s" + **Wall display mode** button.
  - All working: green icon and ok colors. Any "no response": red. Otherwise amber.
- **Totals row (5 tiles):** Fully working · Issue, responding · Issue, no response (tinted red when > 0) ·
  Not reporting · Longest unacknowledged (mm:ss, live).
- **Grid "Every site, every service":** one row per site; columns: Site (status dot, name link, meta
  "ST · N beds · Tier"), Response (section 3), then the service cells grouped per section 4, then Heartbeat.
  - **Sort:** no-response first, then responding, then not reporting, then working; alphabetical within.
  - **Clicks:** site name → Site Overview. A degraded/down cell → that alert's detail
    (`/console/alerts/:id`). A working/no-data cell → Site Overview scrolled to that service.
  - Every cell has a tooltip and `aria-label`: "`<site>` · `<service>`: `<state>`".
  - **Filter chips:** All sites / Issues only.
  - **Legend** row under the grid with glyphs.
- **Wall display mode:** hides the sidebar, enlarges type ~1.4×, keeps auto-refresh, exits with Esc or a
  visible Exit button. For a TV in the service desk.
- **Scale:** must stay readable at 60 sites (rows stay 42 px; grid body scrolls; header row sticky).

### 5.2 Alerts inbox + detail: `/console/alerts`, `/console/alerts/:id` (design: `Main.dc.html`)
- **Header:** title, state chips (Open · n / Acknowledged · n / Resolved today · n), search (site, service, device).
- **List (left, 520 px):** cards with severity badge (P1 solid red, P2 amber, P3 gray), site, age (mono),
  title, one-line plain-language impact (from the alert rule's `impact_stmt`), response line with dot.
  Selected card: accent border + accent-bg.
- **Detail (right):** severity + "site · service · channel/device" line, headline, impact paragraph,
  response status and escalation time (top right).
  - **Actions:** Acknowledge (primary, requires `alerts:ack`), Open site, Start support session
    (requires `support:request`; opens the existing broker flow), Copy ticket text (uses existing
    `GET /api/alerts/:id/ticket`).
  - **What we see:** last good message / errors in 15 min / check depth (tier meaning) / also affected at
    this site (co-occurring issues, labeled "may be unrelated"; never implies cause).
  - **Confirmed before paging:** the outage-confirmation steps recorded by `outage_confirm.js`
    (retry, second dependency, WAN, LTE). Needs to be persisted with the alert (section 6).
  - **Runbook link** from the rule's `runbook_url`.
  - **Similar past incidents:** from existing `GET /api/alerts/:id/similar` (date · site, root cause, fix,
    time to resolve, match score). Keep the existing honest empty state.
  - **Who's been paged:** each tier: who, channel, time paged, ack state, and "at hh:mm if no ack" for the next tier.
  - Footer line: "Facts only: recorded check results and timestamps. Beacon Relay never shows patient data here."

### 5.3 Fleet overview: `/console/fleet` (design: `Fleet.dc.html`)
- 4 tiles: Sites monitored / All systems working / Need attention / Devices awaiting confirmation.
- **Map:** real basemap of the states that have sites (start with Kansas + Missouri). Use a US states
  TopoJSON **bundled in the repo** (no external tile servers or runtime CDN; hospital networks may block
  them). Pins colored by site rollup, labeled with hospital name, clickable to Site Overview.
  Replaces the current world-projection map where all pins collapse into one point.
- **Table:** Site (name link + "ST · beds · device id"), Service tier, Status pill, Open alerts, Last heartbeat.
- Awaiting-confirmation devices show a **Confirm device** action (requires `devices:write`), which calls the
  existing confirm endpoint (only after the device has presented a valid cert, as today).

### 5.4 Site: shared header and tabs
- Header: breadcrumb "Fleet /", hospital name, meta line ("Critical access hospital · 25 beds ·
  city, ST · Tier 2 managed service"), status pills (n working / n degraded / n down), **Topology** button.
- Tabs: **Overview** | **Support** (badge "n open" when > 0) | **Topology**. Real URLs per tab.

### 5.5 Site Overview: `/console/sites/:id` (design: `Site.dc.html`)
- Four group cards (section 4), each row: status dot, service label, short fact
  (e.g. "MEDITECH Expanse · L3 read OK", "14 of 14 up", "Last success 02:10"), state word.
  Interfaces card lists each channel with engine and last message / error count.
- Right column: **Beacon Link** card (device id, online + last heartbeat, connection incl. LTE backup
  readiness, software version + "current"/"update pending", certificate auto-renew time),
  **Who gets paged** (summary of this site's routing, Edit → Routing), **Recent incidents** (last 4,
  open ones marked), buttons Topology / Downtime page (link to a read-only copy of that device's downtime
  bundle as last synced; if not synced, say so).

### 5.6 Site Support tab: `/console/sites/:id/support` (design: `SiteSupport.dc.html`)
**Job:** one running log of every issue at the site, whether Beacon Relay detected it or the hospital
reported it, so the team sees history and the hospital sees proof of value.
- **Tiles (last 30 days):** Issues · Caught before anyone called · Reported by hospital staff ·
  Median time to resolve · Open now.
- **Filter chips:** All / Open / Detected by us / Reported by hospital.
- **Table columns:** When (mono) · Issue (title link + one-line note) · How we found out (tag:
  "Detected by Beacon Relay", "Reported by hospital", "Detected, then reported"; sub-line e.g. "Call from
  2 West nurse station", "No one has reported it yet") · Status (Open / Monitoring / Resolved) · Owner ·
  Time (open duration or time to resolve).
- **Log a reported issue** (primary button): form with system/service (dropdown incl. "Other / not
  monitored"), symptom (free text, **PHI-guarded, 500 char cap**), who reported (role, e.g. "2 West
  nurse station"; **no personal names required**), how (call/email/ticket/in person), owner, optional
  link to an existing alert. If an open alert exists for the same site + service, offer to link it
  (that makes the entry "Detected, then reported").
- Entries created from alerts appear automatically (source = detected). Resolving an alert with a
  resolution record updates the linked entry.
- Footer: "When logging a call, record the system and symptom only. Never enter patient names, MRNs or
  other patient details."

### 5.7 Site Topology tab: `/console/sites/:id/topology` (design: `Topology.dc.html`)
- Toggle **Network** | **Interfaces**.
- **Network layer:** internet/WAN (primary + LTE backup, standby shown dashed/blue) → firewall →
  core switch → clinical systems row and site services row; Beacon Link attached to the switch on a
  dashed "passive tap (read only)" link; VPN tunnels off the firewall. Built from the site asset
  inventory (section 6.4). Edge color/dash = worst state of its two ends.
- **Interfaces layer:** systems (EHR, interface engine, LIS, pharmacy, PACS, external e.g. Surescripts)
  with directed edges per channel, and a channel pill on each edge (name, last message or error count).
  Built from the existing channel registry (`source_system`, `destination_system`, engine).
- **Detail panel (right, 330 px):** kind, name, state pill, recorded facts list; "Open this issue"
  button when degraded/down. Caption: facts are recorded check results; related problems are shown side
  by side, never guessed as causes.
- Nodes are real `<button>`s (keyboard reachable). Layout: deterministic layered layout computed on the
  client (no physics). Must stay readable for a site with 25 network nodes and 12 channels.
- Retire `control-plane/public/topology.html` after this reaches parity.

### 5.8 Alert routing: `/console/routing/:siteId` (design: `Routing.dc.html`)
- Site selector (only sites the user may manage), **Send test page**, **Save changes** (requires
  `alerts:rules:write`; every save audit-logged with before/after).
- **Escalation ladders**, one card per severity (P1, P2, P3): title, hours scope ("Any time" / "Business
  hours only"), up to 3 tier boxes: tier, who (contact or role), how (channels), ack window.
- Side cards: **Severity by service** (per-site mapping of services to P1/P2/P3), **Hours and on-call**
  (business hours with timezone, after-hours rule, on-call engineer for the current week),
  **Maintenance windows** (recurring, per site, optional service scope; alerts during a window are
  logged, not paged).
- Footer: "Alert messages carry site, service, severity, time and a link. They never include patient information."
- **Send test page** sends a clearly labeled TEST message through the real channels to Tier 1 only,
  audit-logged, rate-limited (1 per minute per site).

---

## 6. Backend additions needed (none of these exist today)

All new tables go into `control-plane/src/schema.js` (Postgres) with a migration; all routes get RBAC +
auth-policy declarations and tests; all human free text is PHI-guarded.

### 6.1 Site profile
Extend `sites`: `name`, `facility_type` (e.g. critical_access), `city`, `state`, `beds` (int),
`service_tier` (`tier1_watch` | `tier2_managed` | `tier3_software`), `timezone`, `lat`, `lng`.
Routes: `GET /api/sites`, `GET /api/sites/:id`, `PUT /api/sites/:id` (ops only).

### 6.2 Per-site alert routing (replaces fleet-wide `alert_contacts` for escalation)
- `routing_ladders` (site_id, severity, hours_scope `always`|`business`), `routing_tiers` (ladder_id,
  tier 1..3, contact_id or role, channels[], ack_window_s), `site_hours` (site_id, business hours,
  timezone, after_hours_rule), `service_severity` (site_id, service, severity), `maintenance_windows`
  (site_id, recurrence, start, end, services[] optional), `oncall` (week_start, engineer contact).
- `alerting.js` escalation reads the **site's** ladder for the alert's severity and time of day instead
  of the global contact list. Existing behavior (required ack, auto-escalate on timeout, suppression) is
  kept; existing tests must still pass, plus new tests for per-site routing, business-hours scoping,
  after-hours rule, and maintenance suppression.
- Routes: `GET /api/sites/:id/routing`, `PUT /api/sites/:id/routing`, `POST /api/sites/:id/routing/test-page`.

### 6.3 Support log
- `support_log` (id, site_id, opened_at, title, note, service, source `detected`|`reported`|`detected_then_reported`,
  reported_by_role, reported_via `call`|`email`|`ticket`|`in_person`, status `open`|`monitoring`|`resolved`,
  owner, resolved_at, alert_id nullable). `title`/`note`/`reported_by_role` are PHI-guarded, 500 char cap.
- Alert fire creates a `detected` entry; logging a report against an open alert flips it to
  `detected_then_reported`; alert close/resolution updates status and resolved_at.
- Routes: `GET /api/sites/:id/support-log?filter=`, `POST /api/sites/:id/support-log`,
  `PATCH /api/support-log/:id`. Summary tiles computed server-side:
  `GET /api/sites/:id/support-log/summary?days=30`.

### 6.4 Site asset inventory (for the Network topology)
- `site_assets` (id, site_id, kind `wan`|`lte`|`firewall`|`switch`|`server`|`service`|`vpn`|`device`,
  label, parent_id, service enum nullable, layer_row int, notes). Status comes from the linked service's
  latest check result; assets with no linked service show No data.
- Seed from the existing site profile/config where possible; editable by ops.
- Route: `GET /api/sites/:id/topology?layer=network|interfaces` (interfaces layer = existing channel
  registry + systems; network layer = assets + statuses).

### 6.5 Alerts: response state and confirmation record
- Add `confirmation_steps` (JSON array of {step, result, at}) captured from `outage_confirm.js` when the
  alert fires; add `pages` history (tier, contact, channel, paged_at, acked_at).
- `GET /api/alerts?state=open|acknowledged|resolved_today&site_id=`, `GET /api/alerts/:id` returns
  everything the detail panel needs in one call.

### 6.6 Master board aggregate
- `GET /api/board` returns, in one call: verdict counts, longest unacknowledged seconds, and per site:
  id, name, meta, rollup, response state (section 3), per-service states for the 20 services + interface
  rollup, and last heartbeat. Must answer in < 300 ms for 60 sites (add the indexes it needs).
- RBAC: ops/support see all sites; `customer-it-admin` sees only their own site(s); executive read-only.

---

## 7. Demo data
Update `scripts/demo_seed.js` so demo mode matches the design: 8 fictional sites (Demo County Memorial,
Osage Creek Medical Center, Prairie Ridge Hospital, Flint Hills Community Hospital, Cedar Bluff Regional,
Smoky Valley Hospital, Big Spring Memorial, Red Hills Health), with the design's states, a support log
history, routing ladders, and site assets. All names fictional; no PHI-shaped data. Update `DEMO.md`'s
click-through to start on the Master board.

---

## 8. Tests and acceptance
- Unit: `status.ts` mapping; site rollup; response state; every schema service enum mapped to a group.
- API: each new route (auth policy, RBAC allow/deny incl. customer-it-admin site scoping, PHI guard
  rejects MRN/SSN/DOB/phone patterns on support-log and routing free text).
- Escalation: per-site ladder, business-hours scoping, maintenance suppression, test page rate limit.
- UI: Playwright smoke per screen in demo mode: renders, key numbers match `/api/board`, clicking a
  degraded cell lands on the right alert, tabs route correctly, Wall display mode toggles.
  Save a screenshot per screen to `.agent/console-screens/` for design review.
- Accessibility: all interactive elements keyboard reachable with visible focus; statuses never color-only;
  44 px targets.
- **Acceptance per screen:** matches its design file for layout, copy and colors; uses live API data
  (no hardcoded sample data outside demo seed); tests green.

---

## 9. Build order (checkpoint after each)
1. Console scaffold (Vite/React/TS, tokens, fonts, sidebar, routing, dev auth stub guarded as in section 0), served at `/console/`.
2. Backend 6.1 site profile + 6.6 board endpoint → **Master board** screen.
3. Backend 6.5 → **Alerts inbox + detail**.
4. **Site Overview** + shared site header/tabs.
5. Backend 6.3 → **Support tab**.
6. Backend 6.4 → **Topology tab** (then retire `public/topology.html`).
7. Backend 6.2 per-site routing (escalation engine change) → **Routing** screen.
8. **Fleet** with bundled basemap (then retire `public/fleet.html` and `public/index.html`).
9. Demo seed + `DEMO.md` update; full test pass; screenshots for review.

---

## Appendix A. Other change in this drop
- `hardware/bom.json`: the primary compute part `PROTECTLI-VP2410-4` is out of stock at the vendor
  (and recertified units are sold out). Make **Protectli VP2420e** (Celeron J6412, 4× 2.5 GbE, fanless,
  add-on TPM-02 module) the primary; keep VP2410 as an alternate "if available"; keep the N100 alternate.
  Required features are unchanged. Also add a `dev_test` role entry: Dell Wyse 5070 (J4105/J5005,
  TPM 2.0, fanless) + USB 3 gigabit Ethernet adapter for the second NIC + 128 GB M.2 SATA SSD,
  marked "desk testing only, not for customer sites".
