# Beacon Relay Security Model

This document states who authenticates how, where protected health information (PHI) may exist, and the current threat assumptions. It is intended for security reviewers and operators.

## Authentication

### Device authentication

- Every Beacon Relay appliance receives a unique device identity during first-boot provisioning.
- The device obtains an mTLS client certificate from the private step-ca. The certificate's common name is the device_id.
- On every connection to the control plane, the device presents its client cert and verifies the control-plane server cert against the pinned step-ca root (H1).
- The control plane verifies the client cert against step-ca, checks the certificate serial against a revocation list, and checks that the device_id exists in the registry and is not revoked.

**Current state:** Device mTLS is implemented and tested.

### Operator authentication

- The Fleet Console and operator API endpoints currently use a query-string role parameter (`?role=operations-manager`) as a placeholder until real operator auth is built.
- This is **not real authentication**. Anyone who can reach the control-plane port can declare any role.
- Real operator authentication (OIDC + MFA) is pending a decision on identity provider; options are documented in `.agent/c1-auth-options.md`.

**Current state:** Operator auth is NOT built yet (C1). The control plane is bound to `127.0.0.1` in `docker-compose.yml` to limit exposure until real auth exists.

### CA authentication

- step-ca is the root of trust for both device and server certificates.
- The CA root fingerprint is pinned to the device during enrollment; the device refuses to trust a different CA (H1).
- The CA intermediate key is protected by `CA_PASSWORD` and must not be committed.

## Authorization

- `control-plane/src/rbac.js` defines five roles and their permissions.
- Every route declares an auth policy (`device`, `operator:<perm>`, or `public`) in `config.auth` (H3).
- A test enumerates the Fastify route table and fails if any route lacks a declared policy.

## PHI handling

### Design goal

Beacon Relay is intentionally **metadata-only**. The system emits events that describe the health of interfaces and services without carrying message content, patient identifiers, or free-text clinical data.

### Where PHI may exist

| Location | PHI risk | Mitigation |
|---|---|---|
| Hospital HL7 feed | High | The sidecar extracts only timestamps, message type, source/destination, and error counts. Content fields are dropped. |
| Alert text | Medium | Free-text impact statements are plain-language operational descriptions, not clinical notes. The PHI guard blocks common identifier patterns before any channel sends (M1). |
| `resolution_record` close fields | Medium | `root_cause_note` and `action_taken` are scanned by `phi_guard.js` before persistence. |
| Ticket email/block | Low | `formatTicketBlock` renders only severity, service, site, status, and timestamps; no raw events or payloads. |
| Database | Low | Only metadata events and config are stored. No patient content. |

### PHI guard

- `control-plane/src/phi_guard.js` scans free text for patterns that look like SSN, phone, DOB, or MRN.
- It is a safety net, not a de-identification guarantee. It is applied to email, SMS, voice, and webhook messages (M1).
- It cannot detect patient names; free-text fields should be short and use structured codes where possible.

## Threat assumptions

- **Network:** Hospital LAN and cloud VPC are trusted enough for mTLS, but an attacker who can intercept DNS or spoof the control-plane IP must be prevented by server-cert pinning (H1).
- **Appliance:** Physical access to the device is possible; the data partition is LUKS-encrypted or the key is TPM-sealed.
- **CA compromise:** Would allow issuance of fake device/server certs. The CA key must be offline-backed and password-protected.
- **Control-plane compromise:** An attacker with control-plane access could read metadata, revoke devices, and push malicious updates. Real operator auth + binding to localhost mitigates this until C1 is implemented.
- **PHI leakage:** Mitigated by metadata-only design, PHI guard, and short retention.

## Not yet implemented

- Real operator authentication with MFA (C1).
- SQLite removal and native PostgreSQL timestamps (M6).
- TPM key pin alignment: `provision.js` pins a software-generated public key while the agent signs with a TPM-generated key (M4 follow-up).
- Repository is currently public; it should be made private (H5).
