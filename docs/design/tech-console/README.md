# Tech console design references

These seven files are the approved design for the Beacon Relay tech console (v1, 2026-09-23).
They are **reference markup, not production code**. They were authored in a design canvas and use a
design runtime (`support.js`, `<x-dc>`, `<sc-for>`, `{{holes}}`) that is not part of this repo, so they
will not render correctly if opened directly in a browser.

How to use them:
- Read them for exact layout, spacing, colors, copy, and which data each screen shows.
- Inline `style="..."` attributes are the source of truth for visual values.
- The `renderVals()` block at the bottom of each file holds the **sample data** that shows what fields
  each component needs. It is fake data. Do not ship it.
- The build spec is `docs/specs/BEACON_RELAY_TECH_CONSOLE_SPEC.md`.

| File | Screen | Route |
|---|---|---|
| `Board.dc.html` | Master board (every site at a glance) | `/console/` |
| `Main.dc.html` | Alerts inbox + alert detail | `/console/alerts`, `/console/alerts/:id` |
| `Fleet.dc.html` | Fleet overview + map | `/console/fleet` |
| `Site.dc.html` | Site: Overview tab | `/console/sites/:id` |
| `SiteSupport.dc.html` | Site: Support tab | `/console/sites/:id/support` |
| `Topology.dc.html` | Site: Topology tab (Network / Interfaces) | `/console/sites/:id/topology` |
| `Routing.dc.html` | Alert routing per site | `/console/routing/:siteId` |
