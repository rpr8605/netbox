# Beacon Relay

Beacon Relay is a remote infrastructure monitoring appliance for critical-access hospitals. It sits at the edge of a hospital network, runs continuous health checks against EHR interfaces, network services, and cloud dependencies, and sends metadata-only alerts to a cloud-hosted control plane. The appliance communicates over mutual TLS with short-lived certificates issued by a private step-ca; the control plane stores telemetry in PostgreSQL and serves a Fleet Console for operations staff.

## What is it?

- **Edge appliance** (`beacon-relay-agent/`): a Node.js daemon running on a hardened Linux image (RAUC A/B updates, optional TPM sealing, LUKS-encrypted data partition). It runs checks, posts metadata-only events, renews its mTLS cert automatically, and applies signed OTA bundles.
- **Control plane** (`control-plane/`): a Fastify HTTPS API with PostgreSQL storage, RBAC stubs, alerting engine, support-session broker, and a static Fleet Console.
- **Private CA** (`pki-config/`): `step-ca` issues short-lived device and server certificates.
- **HL7 sidecar** (`sidecar/`): a Python service that receives HL7 messages, extracts metadata, and posts safe events.
- **Image pipeline** (`pipeline/`): bash/Node build stages that produce a signed RAUC bundle and disk image.

## Quickstart

```bash
# 1. Copy the example environment file and fill in secrets.
cp .env.example .env
# Edit .env: POSTGRES_PASSWORD, CA_PASSWORD, CA_FINGERPRINT, etc.

# 2. Seed the local CA and build a release bundle.
npm run pki-seed
npm run phase3:build-image

# 3. Start the local stack (step-ca + Postgres + control-plane + device simulator).
npm run compose:up

# 4. Run the one-command demo with synthetic hospitals.
npm run demo
```

The Fleet Console is available at `https://localhost:10443/fleet.html?role=operations-manager` after the stack is up.

## Repo map

| Path | What lives there |
|---|---|
| `beacon-relay-agent/` | Device agent daemon, first-boot provisioning, OTA client, monitoring loops, downtime UI. |
| `control-plane/` | Fastify API, route handlers, alerting engine, database layer, public console. |
| `sidecar/` | Python HL7 metadata sidecar. |
| `pipeline/` | Build stages for the golden disk image and RAUC bundle. |
| `pki-config/` | step-ca configuration, provisioner JWK, entrypoint scripts. |
| `device-sim/` | Docker-based simulator for local integration tests. |
| `vm-harness/` | QEMU acceptance harness for the full appliance image. |
| `scripts/` | Test scripts, demo orchestration, and utility helpers. |
| `schemas/` | Canonical JSON schema for Beacon Relay events. |
| `hardware/` | BOM, golden-image manifest, swap procedure. |
| `docs/` | Product specs, architecture, security model, and design docs. |
| `.agent/` | Session notes, checkpoints, open questions, and AI-process artifacts. |

## How to test

```bash
# Reset the isolated test database and run all test suites.
npm test

# Run individual suites:
npm run ehr:unit        # 48 EHR/network adapter unit checks
npm run ehr:e2e         # End-to-end EHR flow against the stack
node scripts/test_agent_loop.js
node scripts/test_update_client.js
node scripts/test_alerting_rbac_audit_support.js

# Python sidecar tests:
python -m pytest sidecar/
```

Tests that touch PostgreSQL require `DATABASE_URL` set (`.env` does this by default).

## Key docs

- `docs/reviews/2026-09-23-independent-review.md` — latest independent security review.
- `docs/ARCHITECTURE.md` — system diagram and trust boundaries.
- `docs/SECURITY_MODEL.md` — authentication, CA, PHI handling, and threat assumptions.
- `docs/specs/BEACON_RELAY_SPEC_INDEX.md` — maps each spec to the code it governs.
- `docs/specs/BEACON_RELAY_CHECKLIST.md` — implementation status and test evidence.
- `docs/specs/BEACON_RELAY_STATUS.md` — current state and blockers.

## Development notes

- Node.js 20+ and Python 3.11+ are required.
- The agent intentionally has no npm dependencies in the image; it uses only Node built-ins and openssl.
- The control plane defaults to PostgreSQL; SQLite is still supported for zero-config local runs.
- Operator authentication is currently a query-string role stub; real IdP integration is pending a decision (see `.agent/c1-auth-options.md`).

## License

Proprietary — Beacon Relay is not open source.
