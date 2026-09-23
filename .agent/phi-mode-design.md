# PHI-mode toggle — design note

## Goal
Document the design for a per-site PHI-mode toggle before any implementation code is
written. This is `BUILD_SPEC` §8.9, split out because enabling PHI retention is a
deliberate, contractual, audited act rather than a normal feature flag.

## Default state: OFF, forever, unless explicitly enabled

- `phi_mode` is `false` for every site at creation and remains `false` unless a
  legally-approved, two-person controlled enablement flow is completed.
- Metadata-only telemetry (message type, trigger event, direction, ACK/NACK,
  latency, size, correlation token) remains the default forever. The existing
  structural guarantee — raw message bodies are not retained when `phi_mode` is
  `false` — is unchanged.
- A site can be returned to `phi_mode: false`; that act is also controlled and
  audited. Returning to `false` does not restore bodies already retained while
  `phi_mode` was `true`; those are purged per the retention policy below.

## Who can enable PHI mode

- **Role:** `operations-manager` only.
  - `support-technician`, `customer-it-admin`, `security-auditor`, and
    `readonly-executive` cannot initiate, approve, or view the enablement UI.
- **Prerequisites for enablement:**
  1. A recorded BAA / contract amendment reference tied to the site. The reference
     is free text but required; the system rejects enablement without it.
  2. A textual reason for the exception.
  3. A second `operations-manager` approver, distinct from the requester. The
     approver must re-authenticate (same role check + audit log record) at
     enablement time.
- **Enablement transaction:**
  - `phi_mode` is set atomically in the `sites` table.
  - An `audit.phi_mode.enabled` record is written with requester, approver,
    contract reference, reason, timestamp, and site_id.
  - An ops alert (P2) is fired automatically: `PHI mode enabled for site X by A,
    approved by B, contract ref C`.

## Disablement / return to metadata-only

- Same role requirement: `operations-manager` only.
- Same second-approver requirement.
- Records `audit.phi_mode.disabled` with requester, approver, reason, timestamp.
- Fires an ops alert (P2).
- Existing retained bodies are not deleted instantly; they enter the retention
  purge queue described below.

## What changes when PHI mode is ON

### Data paths

- **HL7/MLLP sidecar:** when `phi_mode: true`, the sidecar keeps the full raw
  message body after metadata extraction and emits it as an `hl7_metadata` event
  with a new optional `raw_body` field (encrypted at the event level before
  leaving the device).
- **Ingestion API:** accepts `raw_body` only when the sending device reports
  `phi_mode: true` and the site's record also shows `phi_mode: true`. Any
  mismatch causes the event to be rejected.
- **Storage:** full bodies are stored only on the device's encrypted `/data`
  partition and in the control-plane's encrypted data store (PostgreSQL with
  column-level encryption or LUKS-at-rest). Bodies are never stored in the
  device's read-only rootfs.
- **Search / replay:** a new `phi_mode: true` permission is required to query
  retained bodies. Security-auditor and readonly-executive roles do not receive
  it.
- **Export / ticketing:** ticket blocks and incident exports for PHI-mode sites
  must strip `raw_body`. The existing metadata-only export path stays the
  default; raw-body export is a separate, explicit action logged under
  `audit.phi_data.export`.

### Encryption

- At rest: bodies use AES-256-GCM with a site-specific data-encryption key (DEK)
  stored in the control-plane database, wrapped by a master key in a KMS/HSM or
  environment secret. The DEK is rotated on enablement and whenever a site is
  re-keyed.
- In transit: bodies travel inside the existing mTLS envelope; no additional
  channel is opened.
- On device: bodies live only in `/data`, which is already LUKS-encrypted; the
  sidecar keeps them in memory only long enough to encrypt and emit them.

### Retention and purge

- Default retention for raw bodies: **30 days** from `occurred_at`, configurable
  per site down to a minimum of 24 hours.
- A nightly job (`phi_purge` worker) deletes expired bodies and writes
  `audit.phi_data.purged` records with site_id, count, and retention window.
- Manual purge: an `operations-manager` with a second approver can purge all raw
  bodies for a site immediately. This writes `audit.phi_data.purged` with reason
  `manual`.
- When a site is disabled, its existing bodies continue to age out under the
  retention policy; they are not retained longer because the site is no longer
  in PHI mode.

## UI / console treatment

- A site in `phi_mode: true` is shown with a persistent red/banner indicator on
  every console view that includes that site: fleet map pin badge, site list,
  topology view, incident panel, and alert details.
- The badge text is literal: **"PHI MODE — raw message retention enabled"**.
- The enable/disable UI is behind its own route (`/admin/phi-mode`) and is not
  mixed into routine site settings, so nobody toggles it by accident.
- Any user without the `operations-manager` role sees the badge but not the
  controls.

## Audit and alert events

| Event | Actor | Detail |
|---|---|---|
| `phi_mode.enabled` | requester + approver | site_id, contract_ref, reason |
| `phi_mode.disabled` | requester + approver | site_id, reason |
| `phi_data.purged` | system / manual | site_id, count, retention_window |
| `phi_data.export` | operations-manager | site_id, incident_id, reason |
| `phi_mode.alert` | system | P2 alert to ops on every enable/disable |

## Out of scope for this design

- Physical hardware lifecycle tooling (golden image manifest, BOM, swap
  procedure) is covered separately; it does not depend on PHI-mode code.
- React console rewrite; the existing vanilla HTML console will display the
  badge first.
- Okta / Google Workspace identity providers.

## Open questions before coding

1. Where does the master key live in local dev / self-hosted mode? (KMS is AWS
   only; a local fallback must be defined.)
2. Does the 30-day default meet the first contractual use case, or should it
   be shorter by policy?
3. Should raw-body replay require an additional justification field per query?

## Recommended first implementation slice

1. Schema migration: `sites.phi_mode` boolean default false, plus contract_ref
   and retention_days.
2. Audit table / event types for the events above.
3. API endpoints under `POST /api/admin/sites/:id/phi-mode` with two-person
   approval.
4. Sidecar branch: keep and encrypt `raw_body` only when device config and site
   flag are both true.
5. Console badge + admin UI.
6. Nightly purge worker.
7. Tests: enable/disable flow, rejection on mismatch, purge, badge presence.
