# Kimi prompt: add power backup to the hardware plan

Paste this into Kimi in the Beacon Relay repo, on branch `agent/md-sync-2026-09-22`.

---

Ryan added `docs/hardware/POWER_BACKUP.md`. Read it, then:

1. In `hardware/bom.json`, add a new component with the same shape as the existing `cellular_modem` entry:
   - `role`: `power_backup`, `required`: false
   - `primary`: EcoFlow RIVER 3 Plus (286 Wh LiFePO4, UPS mode under 10 ms). Notes: "Power the box from the 12 V DC output, not AC. Recommended for about 24 h runtime. See docs/hardware/POWER_BACKUP.md."
   - `alternates`: one generic entry, "12 V DC UPS module plus 12 V 20 to 30 Ah LiFePO4 battery", with a note that parts must come from a known industrial supplier.
   - `required_features`: `lifepo4`, `ups_switchover_under_20ms`, `dc_12v_output`, `about_300wh_min`
   - Update `last_updated`. Keep the JSON valid, and run `scripts/validate_golden_manifest.js` plus any BOM validation to prove nothing broke.
2. Add the 5 open questions from POWER_BACKUP.md to `.agent/open-questions.md` under a "Power backup" heading.
3. Add the "Future software work" list from POWER_BACKUP.md to `BEACON_RELAY_CHECKLIST.md` as **not started**. Do not build it yet.
4. Do not change anything else. Do not buy, order, or choose parts beyond what is written here. Checkpoint when done.
