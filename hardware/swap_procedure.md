# Beacon Relay — Field Device Swap Procedure

## Scope

This document describes the software and operational workflow for replacing a
Beacon Relay edge appliance at a hospital site. Steps that require touching
physical hardware are marked **PHYSICAL**; everything else can be driven through
the control-plane API or the `scripts/swap_device.js` CLI.

## Prerequisites

1. Replacement unit is flashed with the current golden image and has completed
   first-boot provisioning (it is in `quarantine` state, not yet confirmed).
2. Old unit is reachable enough to issue a final heartbeat, OR an operator has
   verified it is dead/unrecoverable.
3. The operator performing the swap holds the `operations-manager` role
   (`devices:replace` permission); support-technicians may not retire a device.
4. The new unit's serial number / device_id is recorded on the shipping label.

## Step-by-step

### 1. Record the replacement in the control plane (no hardware)

Use the API or the CLI:

```bash
node scripts/swap_device.js \
  --old-device-id OLD-UUID \
  --new-device-id NEW-UUID \
  --reason "SSD failure, unit unresponsive"
```

What the workflow does:
- Verifies both devices exist and belong to the same site.
- Revokes the old device's certificate in step-ca (passive revocation).
- Records the revoked certificate serial so the control plane rejects the next
  mTLS connection attempt from the old identity immediately.
- Sets the old device state to `revoked` (it can no longer ingest events).
- Carries the `site_id` forward to the new device.
- Writes an `audit.device.replaced` record with old_id, new_id, site_id, reason,
  and actor.

### 2. Decommission the old unit **PHYSICAL**

- Power off the old appliance.
- If the SSD is accessible and the hospital requires media destruction, remove
  and physically destroy it. The LUKS-encrypted /data partition is unreadable
  without the TPM-sealed key from this specific device, but physical destruction
  satisfies the strongest policy.
- If the unit will be returned to Beacon Relay for refurb, record the RMA
  tracking number in the control plane (optional field on the replacement
  record).

### 3. Install the replacement unit **PHYSICAL**

- Connect power and primary WAN.
- Connect the LTE failover modem if the site profile requires it.
- Power on and wait for first-boot provisioning to complete (the device will
  generate its own keypair and appear in `quarantine`).

### 4. Confirm the new unit (no hardware)

An operator with `devices:write` confirms the new device:

```bash
curl -X POST https://control-plane/api/devices/NEW-UUID/confirm \
  -H "Content-Type: application/json" \
  -d '{"role":"operations-manager"}'
```

The device moves from `quarantine` to `active` and begins full monitoring.

### 5. Verify service restoration

- Check the Fleet Console for the site: all critical services should return to
  their previous state within one monitoring cycle.
- Confirm at least one heartbeat and one check_result event from the new
  device_id.
- If the old device was the source of any active alert, close or reassign the
  alert with a note referencing the swap.

## Rollback

If the replacement fails before confirm:
- Revoke the new device (`state: revoked`).
- Re-flash or repair the original device if possible, then re-enroll it with a
  new device_id. The old device_id remains revoked; Beacon Relay never reuses
  device identities.

## What this procedure does NOT cover

- **PHYSICAL** TPM clear / secure erase on the old unit. This requires hardware
  access and may require vendor-specific tooling; it is logged as an open
  question in `.agent/open-questions.md`.
- **PHYSICAL** Barcode/serial-number scanning at the warehouse. A shipping-label
  scanner integration is deferred until volume warrants it.
- **PHYSICAL** Factory burn-in and thermal testing. These remain manual or
  vendor-provided.
