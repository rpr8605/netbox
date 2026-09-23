# Beacon Relay: Independent Code Review

**Reviewer:** Claude (Anthropic), independent of the Kimi build agent
**Code reviewed:** `github.com/rpr8605/netbox`, branch `agent/md-sync-2026-09-22`, commit `2176207`
**Date:** 2026-09-23
**Method:** Static read of the security-critical paths (auth/RBAC, enrollment, certs, OTA, support sessions, PHI guards, migration, deployment config) plus a maintainability pass from the point of view of a new developer taking over. I did not run the test suites or the Docker stack. Every finding below cites the file and code that shows it.

Suggested home in the repo: `docs/reviews/2026-09-23-independent-review.md`

---

## Summary

| Severity | Count | Theme |
|---|---|---|
| Critical | 4 | No real authentication, device takeover via enrollment, exposed ports, fleet-wide remote code execution through OTA |
| High | 5 | Device doesn't verify the server, OTA rollback logic, ungated routes, migration resurrects deleted rows, repo is public |
| Medium | 6 | PHI guard gaps and false positives, token race, TPM key generation, misc |
| Maintainability | 10 | Onboarding, docs sprawl, no test runner/CI, stale comments, dual database drivers |

**Bottom line:** The design intent is good and much of the plumbing is thoughtful (short-lived certs, quarantine-by-default, signed bundles, keyed HMAC tokenization in the sidecar). But the control plane currently trusts whatever role the caller *says* it has, and several device-facing endpoints are open. Right now anyone who can reach the control plane's port can impersonate devices, change who gets alerts, and push a command that every Beacon Link runs as root. **This must be fixed before any real hospital device connects, and before the stack runs anywhere reachable from outside your PC** (a VPS demo, a home LAN with other people on it, AWS).

Nothing here is unusual for a fast prototype. The rest of this document says exactly what to fix and in what order.

---

## Critical

### C1. There is no authentication; the caller picks their own role
**Where:** `control-plane/src/rbac.js` (`requirePerm`), `control-plane/src/index.js` (`/fleet.html`)

```js
const role = req.query?.role ?? req.body?.role ?? null;
if (!can(role, perm)) { ... 403 }
```

Any request with `?role=operations-manager` passes every RBAC gate. The fleet map "auth" only checks that *some* `role` value is present. The code comments say this is a Phase 2 placeholder, but the product has since been described (in STATUS and in agent reports) as having "RBAC and auth." It doesn't.

**Impact:** Anyone who reaches the port can replace and revoke devices, create and activate OTA rollouts, request support tunnels, fire alerts, and read the audit log.

**Fix:** Real identity. Operator login via OIDC (e.g. Cognito, Auth0, Entra ID) or passkeys, **with MFA**, server-side sessions, and the role taken from the authenticated principal, never from the request. Until that exists, the control plane must be reachable only from localhost (see C3). Also required before the PHI-mode design (second approver) can mean anything.

### C2. Anyone can mint enrollment tokens and take over an existing device
**Where:** `control-plane/src/routes/enroll.js` (`POST /api/enroll/tokens`, `POST /api/enroll/redeem`), `db.js` (`upsertDevice`, `setDeviceKeyFp`)

- `/api/enroll/tokens` has **no permission check at all** (not even the query-string role).
- For a device_id that already exists, it calls `upsertDevice({... state: 'quarantine' })`. The `ON CONFLICT` clause overwrites `state`, `cert_serial` and `cert_not_after`, so a live device is knocked back into quarantine and its cert record is wiped.
- Redeeming the token with the attacker's own `public_key_pem` overwrites the device's pinned key fingerprint, then returns a step-ca one-time token for `CN=<that device_id>`.

**Impact:** An attacker gets a valid certificate for a real hospital's device, can report fake "all healthy" telemetry as that device, can knock every device into quarantine (outage of the monitoring itself), and permanently hijacks that device's re-trust identity.

**Fix:** Gate token creation behind real auth (ops role). Refuse to create a token for an existing device_id unless it's an explicit, audited re-enrollment flow. Never overwrite `device_key_fp` once set (only the replace workflow may retire it). Never downgrade an `active` device's state from this endpoint.

### C3. Services are published on all network interfaces with default passwords
**Where:** `docker-compose.yml`

- Control plane: `"${CONTROL_PLANE_HOST_PORT:-10443}:9100"` binds on **all** host interfaces, not just localhost. Combined with C1 and C2, anyone on the same network owns it.
- Postgres: `"5432:5432"` published with `POSTGRES_PASSWORD:-beacon`.
- step-ca: `"9000:9000"` published, `CA_PASSWORD:-dev-only-insecure-changeit!`.

The KF3 work made the *container* bind configurable, but the compose file still publishes to every interface, which undoes it.

**Fix:** Use `"127.0.0.1:${CONTROL_PLANE_HOST_PORT:-10443}:9100"`. Don't publish Postgres at all (only the compose network needs it). Make secrets required: `${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}` and the same for `CA_PASSWORD`. Ship a `.env.example`.

### C4. One request can run any command as root on every Beacon Link
**Where:** `routes/releases.js` (`POST /api/releases/rollouts`), `db.js` (`offeredVersion`), `beacon-relay-agent/lib/update.js` (`downloadBundle`, `verifyBundle`), `beacon-relay-agent/agent.js` (`fetchBytes`)

The chain:
1. The rollout `version` is an arbitrary string from the request body, and (C1) the caller only needs `?role=operations-manager`.
2. `offeredVersion()` returns `rollout.version` to devices in the rollout.
3. The device writes the download to `/data/.update-${version}.raucb`. `fetchBytes` returns the body **even on a 404**, so a file is always written.
4. `verifyBundle` runs `execSync(\`rauc info --keyring ${keyringPath} ${bundlePath} 2>&1\`)`, a shell command that includes the unvalidated version.

A version like `1;<command>;#` runs `<command>` as root **before** the signature check. This bypasses the entire signed-update trust boundary, fleet-wide.

**Fix (all three):**
- Validate version everywhere it enters: server side on rollout creation and device side on receipt. Use a strict pattern such as `/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/`.
- Replace every `execSync` template string with `execFileSync('rauc', ['info', '--keyring', keyringPath, bundlePath])` (no shell). Same in `applyBundle` and `tpm.js`.
- Make `fetchBytes` fail on any non-200 status.

---

## High

### H1. The device doesn't verify it's talking to the real control plane
**Where:** `beacon-relay-agent/agent.js` (`api()` defaults `rejectUnauthorized: false`; `mtls()` supplies only the client cert and key, no `ca`)

The device proves who *it* is, but accepts **any** server certificate. Anyone who can intercept or spoof DNS on the hospital network can pose as the control plane, receive telemetry, suppress updates, and feed the device a malicious version string (C4).

**Fix:** Pin the step-ca root (the fingerprint the device already receives at enrollment) and set `ca: rootPem, rejectUnauthorized: true, servername: <control-plane host>` on every device call.

### H2. OTA "automatic rollback" marks the wrong slot
**Where:** `beacon-relay-agent/lib/update.js` (`runUpdateCycle`)

After `rauc install` the code immediately runs a health check **without rebooting**, then calls `rauc status mark-good` or `mark-bad`. Those commands act on the **currently booted (old) slot**. So a failed check marks the known-good running slot *bad*, while the new, untested slot is already set to boot next. That's the opposite of a safe rollback. (`agent.js` separately does a correct post-boot mark-good; the in-cycle calls should go.)

**Fix:** Install, then reboot. After boot, the new slot runs its health check: pass → `mark-good`; fail → `mark-bad` on the booted slot and reboot into the previous one. Remove the in-cycle mark-good/mark-bad. Add a test that asserts which slot each call targets. Also note the comment "a failed verify never touches disk" is false: the bundle is written before verification.

### H3. Several read and write routes have no gate at all
Even under the current role scheme, these have no `requirePerm`:
- **Writes:** `POST /api/alert-rules`, `POST /api/alert-contacts` (anyone can add their own email or phone and receive every outage alert for every hospital), `POST /api/support/sessions/:id/close`.
- **Reads:** `GET /api/devices`, `/api/devices/:id`, `/api/alerts`, `/api/alert-rules`, `/api/channels`, `/api/sites/:id/topology`, `/api/sites/:id/full-status`, `/api/support/sessions/:id`.

**Fix:** Every route declares an auth policy (device-mTLS, operator permission, or explicitly public). Add a test that walks Fastify's route table and **fails if any route lacks a declared policy**. That test would have caught all of these.

### H4. The Postgres migration brings deleted rows back on every restart
**Where:** `control-plane/migrate.js`, `control-plane/entrypoint.sh`

The migration runs on every container start and does `INSERT ... ON CONFLICT DO NOTHING` from the old SQLite file. Anything **deleted** in Postgres since (a removed device, user, contact or token) comes back. (This is already in Kimi's queue.)

**Fix:** Run once, record completion in a marker table, rename the SQLite file to `*.migrated`. Test: delete a row, restart, confirm it stays gone.

### H5. The repository is public
`https://github.com/rpr8605/netbox` is readable without logging in. I found **no committed private keys or real secrets**: `.gitignore` correctly excludes the CA password and provisioner JWK, and git history has no private key blocks. But the full architecture and every vulnerability above are public.

**Fix:** Make the repo private now (Settings → Danger Zone → Change visibility). Note that CodeQL scanning is free only for public repos. Use Semgrep, gitleaks and dependency audits in GitHub Actions instead.

---

## Medium

| # | Finding | Where | Fix |
|---|---|---|---|
| M1 | **PHI guard only covers email.** SMS, voice (Twilio) and Slack/Teams webhooks send alert text with no PHI scan. Slack and Teams are third-party storage. | `deliver.js` | Apply the same guard in `deliver()` for every channel. Also escape text inside the TwiML `<Say>` tag. |
| M2 | **PHI regexes will block ordinary ops notes and still miss names.** `\b\d{6,10}\b` flags ticket numbers, dates like `20260923`, and serials; the DOB pattern flags any date ("cert expired 9/23/2026"). Patient **names** can't be caught by regex at all. | `phi_guard.js` | Keep the guard, but label it as a safety net, not de-identification. Prefer structured fields (dropdowns, codes) over free text, cap free-text length, and add a UI warning. Tune the MRN pattern to reduce false positives. |
| M3 | **Enrollment token double-redeem race.** SELECT then UPDATE is not atomic. | `db.js` `consumeEnrollmentToken` (same pattern in `consumeRetrustChallenge`) | Single `UPDATE ... SET used_at=NOW() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > NOW() RETURNING *`. |
| M4 | **"TPM-backed key" is generated in software, then imported into the TPM.** The private key exists in plain form before sealing. | `beacon-relay-agent/lib/tpm.js` | Generate the key inside the TPM (`tpm2_create`) so it is never exportable. Hospital security reviewers will ask exactly this. |
| M5 | **Revoked or retired devices can still download bundles.** The bundle route checks that the device exists but not its revocation status. | `routes/releases.js` | Reuse `deviceFromCert()` from `events.js`. |
| M6 | **Timestamps compared as text in Postgres.** `expires_at > NOW()::TEXT` compares strings in different formats. It works only while the DB timezone is UTC. | `db.js` `pgize()` | Store `TIMESTAMPTZ` and compare timestamps natively once SQLite is removed. |

Also low: support-session token compared with `!==` (use `crypto.timingSafeEqual`); `smallstep/step-ca:latest` isn't pinned (pin a version for reproducible builds).

---

## For a new developer taking over: how easy is this to pick up?

**Honest grade: C+.** The code is better commented than most prototypes. Every file has a "Responsibility" header, and comments explain *why*, not just *what*. There's a JSON schema registry and about 25 test scripts. But an outside developer would need **1 to 2 weeks** to get productive and, more importantly, to trust what they're reading. With the fixes below, that drops to **2 to 3 days**.

### What makes it hard today

1. **The README is 3 lines and wrong.** It describes a schema registry and a file (`apply_patch.py`) that isn't there. There's no "what is this, how do I run it, where do I start."
2. **Thirteen Markdown files and about 30,000 words sit in the repo root.** Product specs are mixed with AI-process files (`BEACON_RELAY_KIMI_FIXES.md`, `BEACON_RELAY_KIMI_AUDIT_FIXES(1).md`, `AGENTS.md`, `models/`, `opencode.json`). A newcomer can't tell which document is the source of truth.
3. **Comments point at internal labels, not explanations.** Things like "spec §2", "Phase 8", "KF3" and "BUILD_SPEC §8.7" mean nothing without reading the specs.
4. **Some comments are wrong, and that's worse than no comments.**
   - `events.js` says the server "sets rejectUnauthorized". It's `false`.
   - `update.js` says "a failed verify never touches disk". The bundle is written first.
   - `runUpdateCycle` says it "never throws". A download failure can throw.
   - STATUS describes the fleet map as having "auth". It's a query parameter.
   A new developer who trusts these will make wrong decisions.
5. **There's no single test command and no CI.** There are 25 separate scripts, some using `node --test` and some custom runners, plus Python tests, all living in `scripts/` away from the code they test. `package.json` has no `test` script. Nothing runs automatically on push.
6. **Two database drivers.** `db.js` is 733 lines and translates SQLite SQL into Postgres with regexes (`pgize`). That's clever, but fragile and hard to reason about.
7. **Auth is scattered route by route.** No single place shows who can call what, which is exactly how the H3 gaps slipped in.
8. **No linting or formatting config** (no ESLint, Prettier or ruff), so style drifts with every agent session.
9. **"Phase N" naming leaks into scripts** (`phase1:test`, `phase3:build-image`), describing build history instead of what the command does.
10. **No architecture picture.** Three languages (Node agent and control plane, Python HL7 sidecar, bash image pipeline) and a CA, with no diagram of how they connect or where the trust boundaries are.

### How to make it easy

| Change | Effort | Payoff |
|---|---|---|
| Rewrite **README.md**: one paragraph on what it is, a quickstart (`npm run demo`), a repo map, how to test, and links to docs | Small | Biggest single improvement |
| Add **docs/ARCHITECTURE.md** with one diagram: device (agent + sidecar) → control plane → step-ca → Postgres, marking every trust boundary and what crosses it | Small | Newcomer understands the system in 15 minutes |
| Add **docs/SECURITY_MODEL.md**: who authenticates how (device mTLS, operators, CA), what PHI may exist where, and threat assumptions | Small | Also the core of your hospital security approval pack |
| Move specs to **docs/specs/**, AI-process files to **.agent/** or **tools/**, and delete stale ones (e.g. the `(1)` duplicate) | Small | Clean root; clear source of truth |
| Add **docs/adr/** (short decision records: why step-ca, why RAUC, why metadata-only, why a co-op-friendly design) | Small, ongoing | Future developers stop re-litigating settled decisions |
| One **`npm test`** that runs every JS and Python suite, plus a **GitHub Actions** workflow on every push (tests + gitleaks + Semgrep + `npm audit` + `pip-audit` + Trivy) | Medium | Nothing merges broken or leaky |
| **ESLint + Prettier** (JS) and **ruff** (Python), with an auto-fix run once | Small | Consistent style regardless of which AI or person writes the code |
| **Central route registry**: each route declares `auth: 'device' / 'operator:<perm>' / 'public'`, plus the test that fails on undeclared routes | Medium | Fixes H3 and makes auth readable in one file |
| **Remove SQLite**; Postgres only, native timestamps, delete `pgize` | Medium | Cuts `db.js` roughly in half |
| Replace "§/Phase/KF" references in comments with plain explanations or doc links; fix the wrong comments listed above | Small | Comments become trustworthy |
| Rename scripts by purpose (`test`, `build:image`, `stack:up`) and add **CONTRIBUTING.md** (branching, commit style, how to add a route safely) | Small | Clear rules for the next person |
| Consider **TypeScript** (or JSDoc types checked by `tsc --checkJs`) for the control plane | Larger | Catches whole classes of bugs; optional, and can be later |

---

## Recommended order

1. **Today, before anything else runs outside your PC:** C3 (bind localhost, no default passwords), H5 (make the repo private).
2. **Next build session:** C4 (version validation + no shell), C2 (enrollment lockdown), H1 (device verifies server), H3 (gate every route + route-policy test), H4 (migration once).
3. **Before any real hospital device:** C1 (real operator auth with MFA), H2 (correct OTA rollback, tested on real hardware), M1 through M5.
4. **Maintainability track** (can run in parallel, cheap for Kimi): README, ARCHITECTURE, SECURITY_MODEL, docs reorganization, `npm test` + CI + scanners, lint.
5. **Before the first pilot:** an outside human penetration test. With the fixes above done first, you'll pay for a clean report instead of a list of these.

---

## Paste-ready prompt for Kimi

```
Read docs/reviews/2026-09-23-independent-review.md (an independent review of this
repo). Fix findings in this order, one logical change per commit, each with a test
that fails before the fix and passes after. Standing rules unchanged.

Batch 1 (security, do first):
- C3: compose binds control plane to 127.0.0.1 only; do not publish Postgres;
  POSTGRES_PASSWORD and CA_PASSWORD required (no defaults); add .env.example.
- C4: strict version validation server-side (rollout create) and device-side;
  replace every execSync template string in beacon-relay-agent with execFileSync
  arg arrays (update.js, tpm.js); fetchBytes fails on non-200.
- C2: gate POST /api/enroll/tokens behind operator permission; refuse tokens for an
  existing device_id except an explicit audited re-enroll flow; never overwrite
  device_key_fp once set; never downgrade an active device's state here.
- H1: device pins the step-ca root and verifies the control-plane server cert on
  every call (rejectUnauthorized: true).
- H3: add an auth policy to EVERY route; add a test that enumerates the route table
  and fails on any route without a declared policy.
- H4: migration runs once (marker table), then renames the SQLite file.
- M3: atomic token/challenge consumption (UPDATE ... RETURNING).
- M5: bundle download uses the same deviceFromCert() revocation checks as events.

Batch 2 (OTA correctness): H2. Remove in-cycle mark-good/mark-bad; health-check
after reboot into the new slot; test which slot each call targets.

Batch 3 (maintainability): README rewrite, docs/ARCHITECTURE.md with a trust-boundary
diagram, docs/SECURITY_MODEL.md, move specs to docs/specs and AI-process files to
.agent/, single `npm test`, GitHub Actions (tests, gitleaks, Semgrep, npm audit,
pip-audit, Trivy), ESLint+Prettier+ruff, fix the wrong comments listed in the review.

Do NOT start C1 (real operator auth) without asking me: it needs an identity-provider
decision. Checkpoint rules unchanged.
```
