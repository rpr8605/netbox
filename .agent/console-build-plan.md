# Console Build Plan

React rewrite of the Beacon Relay Fleet Console. Approved per `docs/specs/BEACON_RELAY_TECH_CONSOLE_SPEC.md`.

## Goal

Replace `control-plane/public/index.html`, `topology.html`, and `fleet.html` with a React 18 + TypeScript + Vite SPA served at `/console/`, while keeping the on-device downtime page unchanged.

## Constraints

- **Localhost-only until C1 auth is merged and tested.** The console shows every hospital; it must never be exposed without real operator login + MFA.
- **Dev auth stub:** `CONSOLE_DEV_AUTH=1` is allowed only when `NODE_ENV !== 'production'` and `BIND_HOST === '127.0.0.1'`. Otherwise the server refuses to start with a clear error.
- **Every new API route declares an auth policy** and is covered by `control-plane/test/route-auth.test.js`.
- **PHI rule:** the console only shows metadata. All human free text goes through `phi_guard.js` on the server.
- **Nothing is exposed beyond localhost until C1 lands.**

## File layout

```
control-plane/console/
  package.json          # React 18, Vite, TypeScript, React Router, dev deps
  vite.config.ts
  tsconfig.json
  index.html
  src/
    main.tsx
    App.tsx
    routes.tsx          # /, /alerts, /alerts/:id, /fleet, /sites/:id, /sites/:id/support, /sites/:id/topology, /routing/:siteId
    status.ts           # single canonical status mapping
    theme/tokens.css    # copy tokens from spec section 2
    api/                # typed fetch client, one module per resource
    components/         # Sidebar, StatusCell, StatusPill, SeverityBadge, Tabs, MetricTile, etc.
    screens/            # Board, Alerts, AlertDetail, Fleet, SiteOverview, SiteSupport, SiteTopology, Routing
  test/                 # unit tests for status.ts, rollup, response state
  e2e/                  # Playwright smoke tests in demo mode
  dist/                 # vite build output (gitignored)
```

Fastify serves `dist/` at `/console/` with SPA fallback. The build step is added to the control-plane Dockerfile.

## Stack

- React 18
- TypeScript
- Vite
- React Router
- Plain CSS with CSS variables (no UI kit)
- Self-hosted IBM Plex Sans / Mono fonts
- Playwright for UI smoke tests
- Bundled US states TopoJSON for the Fleet map (no external tiles)

## Dev auth stub

A minimal `devAuth` preHandler used only when `CONSOLE_DEV_AUTH=1`:

- Sets `req.user = { id: 'dev', role: 'operations-manager', mfaVerified: false }`.
- Refuses to start if `NODE_ENV === 'production'`.
- Refuses to start if `BIND_HOST !== '127.0.0.1'`.
- Logs a warning on every server start: "Console running in dev-auth mode. Not for production."

After C1 lands, this stub is removed and the real Cognito/JWT preHandler is used everywhere.

## Backend additions

All new tables go through `control-plane/src/schema.js` with migrations; all routes declare `config.auth`.

1. **Site profile** (`sites` table extension): `facility_type`, `city`, `state`, `beds`, `service_tier`, `timezone`, `lat`, `lng`.
2. **Board endpoint** (`GET /api/board`): one-call aggregate for Master board, < 300 ms for 60 sites.
3. **Alert response + confirmation record**: `confirmation_steps`, `pages` history; `GET /api/alerts` and `GET /api/alerts/:id` extended.
4. **Support log** (`support_log` table): detected/reported issues, PHI-guarded free text, summary tiles.
5. **Site asset inventory** (`site_assets` table): network topology assets.
6. **Per-site alert routing** (`routing_ladders`, `routing_tiers`, `site_hours`, `service_severity`, `maintenance_windows`, `oncall`): replaces fleet-wide `alert_contacts`; escalation engine updated.

## Build order (one screen / one backend addition per checkpoint)

1. **Scaffold:** Vite/React/TS, tokens, fonts, sidebar, routing, dev auth stub, `/console/` static serve, Dockerfile update.
2. **Site profile + board endpoint → Master board** (`/console/`).
3. **Alert response/confirmation → Alerts inbox + detail** (`/console/alerts`, `/console/alerts/:id`).
4. **Site header/tabs + Site Overview** (`/console/sites/:id`).
5. **Support log → Site Support tab** (`/console/sites/:id/support`).
6. **Site asset inventory → Site Topology tab** (`/console/sites/:id/topology`); retire `public/topology.html`.
7. **Per-site routing → Routing screen** (`/console/routing/:siteId`).
8. **Bundled basemap → Fleet screen** (`/console/fleet`); retire `public/fleet.html` and `public/index.html`.
9. **Demo seed update + `DEMO.md` + screenshots + full test pass.**

## Tests

- **Unit:** `status.ts` mapping, site rollup, response state, schema enum → service group coverage.
- **API:** auth policy, RBAC allow/deny, customer-it-admin site scoping, PHI guard on support-log/routing free text.
- **Escalation:** per-site ladder, business-hours scoping, maintenance suppression, test-page rate limit.
- **UI:** Playwright smoke per screen in demo mode: renders, key numbers match `/api/board`, degraded cell links to alert, tabs route correctly, Wall display mode toggles.
- **Accessibility:** keyboard focus, non-color-only statuses, 44 px targets.

## Security / rollout

- Branch: `agent/md-sync-2026-09-22` (same branch as current work).
- Each screen is one or more commits; `npm test` green after each.
- Keep the existing vanilla HTML consoles until the React screen reaches parity, then delete the old file in the same commit that replaces it.
- The dev auth stub is committed first and removed only after C1 is merged and the real auth preHandler is wired.
- CI builds the console and runs the new unit/API tests; Playwright UI tests run locally or in CI if headless setup is straightforward.

## Open questions to resolve during build

1. Do we keep the existing `public/index.html` as a redirect to `/console/` or delete it outright after Fleet parity?
2. Should the board endpoint be a new route or an aggregation of existing endpoints? Recommendation: new route for performance.
3. Where does the bundled TopoJSON come from? Recommendation: `us-atlas` package or a checked-in lightweight file.

## Blockers

- C1 operator authentication must be merged before this runs outside localhost.
- Existing `control-plane/public/*.html` files stay in place until their React replacements reach parity.
