# Beacon Relay power backup

**Status:** Planned consideration, not yet required. Added 2026-09-23.
**Goal:** keep the box running and reporting for about 24 hours after a site loses power.

## Why

The box already has a network backup (LTE). Power backup is the other half. When a building loses power, the hospital's switch and internet usually go down with it. A box with its own battery and an LTE modem can still send "site lost power" and keep reporting until power returns. Without a battery it goes dark at the moment it matters most.

## How much battery a day takes

Measured draw from Protectli ([source](https://kb.protectli.com/kb/power-draws-for-the-vault-w-ups-uptime-estimates/)):

| Box | Idle | Full load |
|---|---|---|
| Protectli V1210 (N5105, 2 ports) | 6.3 W | 21.1 W |
| Protectli VP2420 (J6412, 4 ports) | 8.2 W | 18.5 W |

Beacon Relay's work is light, so plan for about 9 to 10 W on average, plus about 2 to 3 W for an LTE modem.

- **24 hours at about 12 W is about 290 Wh at the box.**
- After conversion losses, plan for **300 to 350 Wh of battery**, or **about 500 Wh** for margin as batteries age.
- These are estimates. Measure a real box with a DC power meter over a normal day before quoting a runtime to a hospital.

## Options

### Option 1 (preferred for pilots): LiFePO4 power station with UPS mode

- Example: **EcoFlow RIVER 3 Plus**, 286 Wh LiFePO4, rated 3,000 cycles to 80%, switches to battery in under 10 ms (tested at 9 ms), about 10.4 lb, under 30 dB ([review](https://www.storagereview.com/review/ecoflow-river-3-plus-review-compact-power-station-with-600w-output-ups-support), [product](https://www.ecoflow.com/us/river-3-plus-portable-power-station)).
- Expected runtime: about a day on a V1210, and about 18 to 24 hours on a VP2420 depending on load and LTE.
- Add-on battery ("RIVER 3 Max") for about two days.
- **Power the box from the 12 V DC output**, not the AC outlet. The AC inverter's own draw can roughly halve runtime.

### Option 2: 12 V DC UPS module plus a LiFePO4 battery

- A DC UPS feeding a 12 V, 20 to 30 Ah LiFePO4 battery (about 256 to 384 Wh).
- Cheaper per Wh and more permanent, but more of a build. Buy from a known industrial supplier for hospital sites.

### Not recommended for 24 hours

- Small 12 V "router" mini UPSes: a few hours at most.
- Standard AC UPSes: sized for minutes, and inverter losses waste the battery.
- PoE power: backed by the hospital's closet UPS, but the box goes dark when that closet loses power, which is one of the outages we most want to report.

## To verify before adopting (open questions)

1. Does the RIVER 3 Plus 12 V output stay live in UPS mode, with no dropout on switchover? Test by pulling the plug with the box running.
2. Can the box read battery status (on battery, percent left, time left)? Check whether the power station's data port works with Linux, or choose a unit that reports over USB.
3. Actual average draw of a VP2420 and a V1210 running Beacon Relay, with and without an LTE modem.
4. Hospital facilities approval for a lithium battery in the network closet (LiFePO4 is the easiest to approve).
5. Whether the V1210 has TPM 2.0 enabled in Protectli's firmware (not listed on its product page) before choosing it as the low-power option.

## Future software work (after the questions above are answered)

- The agent reports power source (wall or battery), battery percent and estimated time left.
- New alerts: "Site on battery power" (with the time it started) and "Battery below 25%."
- The console's site view and the local display show power status next to network status.
- A clean shutdown at a low battery threshold so the disk and the /data partition are never cut off mid-write.
