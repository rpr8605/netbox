# Beacon Relay — Demo Mode

Demo mode is a self-contained, one-command environment that shows Beacon Relay
monitoring a fictional fleet of small critical-access hospitals in Missouri and
Kansas. Everything is synthetic: no real hospital data, no real patient
identifiers, and no PHI-shaped fields are used.

## Quick start

```powershell
# Windows (opens the Fleet Map and console in your default browser)
.\demo.ps1

# Cross-platform (Node + Docker)
npm run demo
```

The script will:

1. Start `step-ca` and the control plane via Docker Compose.
2. Seed 6 fictional hospitals in MO/KS with enrolled devices and healthy baselines.
3. Start the device simulator in demo loop mode (periodic heartbeats + events).
4. Play a ~10-minute scripted incident timeline:
   - interface channel stall on a MEDITECH-style site,
   - TLS certificate nearing expiry,
   - WAN primary flap and recovery,
   - DNS resolver failure,
   - incident memory suggesting a similar past incident.

Open the console pages while the timeline runs:

- Fleet Map: `https://localhost:10443/fleet.html?demo=1`
- Registry / topology: `https://localhost:10443/index.html?demo=1`

Both pages show a prominent **DEMO MODE** banner when the control plane is in
demo mode or when the URL contains `?demo=1`.

## Stop and reset

```powershell
# Stop the stack (keeps Docker volumes)
.\demo.ps1 -Stop

# Stop the stack and delete the local SQLite data + Docker volumes
.\demo.ps1 -Reset
```

Cross-platform equivalents:

```bash
npm run demo:reset
# or manually:
docker compose down -v
rm -rf ./data
```

## Adjusting the timeline speed

The default timeline runs for 10 minutes. To run a fast 60-second version for
smoke testing:

```bash
npm run demo -- --duration-seconds 60
```

Or run only the timeline against an already-seeded stack:

```bash
npm run demo:timeline -- --duration-seconds 60
```

## 5-minute click-through script for a hospital IT director

Use this script to walk a director through the demo without needing to know the
internals.

**0:00 — Fleet Map overview**
Open `https://localhost:10443/fleet.html?demo=1`. Point out the 6 pins across
MO/KS, all green/active. Explain: "Each pin is a critical-access hospital. The
color is the worst current status of any critical service at that site."

**0:30 — Drill into one site**
Click the pin for *Barton County Memorial Hospital*. The panel shows site ID,
coordinates, and status. Mention that customer IT admins see only their own
site, while operations managers see the whole fleet.

**1:00 — Interface channel stall**
The timeline will turn the *Barton County* lab channel red. Refresh the Fleet
Map and click the pin again: status is now degraded/down. Open
`index.html?demo=1` and use the **View site topology** form with the site ID to
see the channel view: `oru-result` is STOPPED and dependent services are
affected.

**2:00 — Alert and incident signature**
The timeline fires a lab alert. Explain that every alert gets a deterministic
incident signature (service, status transition, time-of-day bucket, and
co-occurring signals) — no AI, no guessing.

**3:00 — TLS cert near expiry**
Switch to *Lafayette County Regional Medical Center*. Its `cert_expiration`
service turns degraded. Explain that Beacon Relay checks every TLS endpoint it
already touches and surfaces expiry as a first-class critical service, not an
afterthought.

**4:00 — WAN flap + DNS failure**
Watch *Johnson County Medical Center* go degraded when the primary WAN drops,
then recover. Then *Cass County Community Hospital* shows a DNS failure. Explain
that the status is always a concrete tier (reachable / verified_ready / active)
backed by an actual check, not a generic "up/down" flag.

**4:30 — Incident memory suggests a similar past incident**
The timeline creates a closed lab-down incident on *Wyandotte County Health
System*, then triggers the same lab-down pattern on *Barton County* again and
queries similar incidents. Open the alert detail and call
`/api/alerts/{alert_id}/similar` to show ranked matches with root-cause and
action distributions — "this looks like the interface-engine deadlock we saw
last week; the action taken then was to restart the HL7 listener."

**5:00 — Recovery**
Refresh the Fleet Map: all sites return to green. Emphasize that every event,
alert, and operator action is audit-logged and immutable.

## What demo mode does not do

- It does not send real pages/SMS/email. Delivery rails are configured to skip
  when SendGrid/SES/Twilio credentials are absent.
- It does not use real hospital networks or EHR feeds. All endpoints are
  synthetic or stubbed.
- It does not exercise TPM/LUKS sealing or physical hardware lifecycle steps.
- It is not a load test; it is designed for a single-room demo.

## Files involved

- `scripts/demo.js` — orchestrator.
- `scripts/demo_seed.js` — synthetic hospital seed + alert rules.
- `scripts/demo_timeline.js` — scripted incident timeline.
- `scripts/demo_reset.js` — reset helper.
- `demo.ps1` — Windows launcher.
- `scripts/test_demo_seed.js` — unit tests for the seed definitions.
- `scripts/test_demo_timeline.js` — unit tests for the timeline definitions.
- `control-plane/src/index.js` — `/api/demo` flag.
- `control-plane/public/index.html` / `fleet.html` — DEMO banner.
