# Review Triage — Beacon Relay Independent Code Review 2026-09-23

Review: `docs/reviews/2026-09-23-independent-review.md` (moved from repo root during this session).  
Review written against commit `2176207`; current branch `agent/md-sync-2026-09-22`, HEAD `b2b2cc1`.

## Legend

- **CONFIRMED** — finding still present in current code.
- **ALREADY FIXED** — finding addressed by a commit after `2176207` (cited).
- **DISPUTED** — literal claim no longer accurate, but a related issue remains (explained with file:line).

---

| Finding | Severity | Status | Evidence / file:line |
|---|---|---|---|
| C1 | Critical | **CONFIRMED** | `control-plane/src/rbac.js:50` reads `const role = req.query?.role ?? req.body?.role ?? null`; `control-plane/src/index.js:92-98` `/fleet.html` only checks that *some* role is present. Any caller can declare `?role=operations-manager`. |
| C2 | Critical | **CONFIRMED*** | `control-plane/src/routes/enroll.js:21` `POST /api/enroll/tokens` has no permission gate. `control-plane/src/db.js:140-163` `upsertDevice` ON CONFLICT overwrites `state`, `cert_serial`, `cert_not_after`, downgrading an active device to quarantine. `setDeviceKeyFp` at `db.js:265-271` now uses `WHERE device_key_fp IS NULL`, so the **literal overwrite claim is fixed**, but the token endpoint still downgrades state/cert. |
| C3 | Critical | **ALREADY FIXED** | `docker-compose.yml` now publishes `step-ca`, Postgres, and the control-plane host ports to `127.0.0.1` only. `.env.example` leaves `POSTGRES_PASSWORD` and `CA_PASSWORD` empty (no committed defaults). Verified by `control-plane/test/compose.security.test.js`. |
| C4 | Critical | **CONFIRMED** | `control-plane/src/routes/releases.js:62-76` validates `stage`/`percentage` but not `version`. `beacon-relay-agent/lib/update.js:39-45` writes `/data/.update-${version}.raucb` verbatim; `:56-57` and `:77` use `execSync` template strings. `beacon-relay-agent/agent.js:267` `fetchBytes` returns `.body` regardless of `statusCode`. |
| H1 | High | **CONFIRMED** | `beacon-relay-agent/agent.js:80` defaults `rejectUnauthorized: false`; `mtls()` at `:117` returns only `{ cert, key }` with no `ca`. The CA fingerprint from enrollment is not used to pin the server. |
| H2 | High | **CONFIRMED** | `beacon-relay-agent/lib/update.js:139-158` calls `applyBundle`, then `healthCheckFn`, then `rollbackFn`/`markGoodFn` **before** reboot. These act on the currently booted (old) slot. The post-boot `markGood()` in `agent.js:153-156` is correct, but the in-cycle calls are unsafe. |
| H3 | High | **ALREADY FIXED** | All routes now declare `config.auth` (`device`, `operator:<perm>`, or `public`). `control-plane/test/route-auth.test.js` builds the route tree and fails on any route missing a declared policy; it passes in the current security suite. Commit `b2b2cc1` (route-auth static testability fix) and earlier route-gating commits.
| H4 | High | **ALREADY FIXED** | `control-plane/migrate.js:66-73` checks `schema_migrations` for marker `sqlite_to_postgres_v1`; `:118` renames the SQLite source to `*.migrated`. Commit `dfaca41`. |
| H5 | High | **CONFIRMED** (repo setting) | Remote is `https://github.com/rpr8605/netbox.git`; public visibility is a repository setting, not a code change. |
| M1 | Medium | **CONFIRMED** | `control-plane/src/deliver.js:27-33` `guardEmailPhi` only covers email (`sendSendGrid`, `sendSes`). `sendTwilio` (`:36-56`) for SMS/voice and `sendWebhook` (`:91-94`) for Slack/Teams do not call `scanPhi`. Voice TwiML at `:40` inserts `${body}` inside `<Say>` without escaping. |
| M2 | Medium | **CONFIRMED** | `control-plane/src/phi_guard.js:13-34` regexes flag ticket numbers/dates (`\b\d{6,10}\b`), any `M/D/YY` as DOB, and cannot detect patient names. No UI warning or structured-field preference is implemented. |
| M3 | Medium | **ALREADY FIXED** | `consumeEnrollmentToken` and `consumeRetrustChallenge` now use a single `UPDATE ... RETURNING` statement (`control-plane/src/db.js`), so the token/challenge is consumed atomically. Covered by `control-plane/test/token.consumption.test.js` in the security suite.
| M4 | Medium | **DISPUTED** | `beacon-relay-agent/lib/tpm.js:51-78` `sealPrivateKey(plainPem)` ignores its argument and calls `tpm2_create` to generate a new RSA key inside the TPM. The private key is **not** generated in software and imported. However, `provision.js` sends the software-generated public key's fingerprint to the control plane as `device_key_fp`, while the agent later signs with the TPM-generated key, so the pins will not match on retrust. |
| M5 | Medium | **CONFIRMED** | `control-plane/src/routes/releases.js:46-55` checks `req.socket.authorized`, cert CN, and `getDevice()`, but does not inspect `device.state` or reuse `deviceFromCert()` from `events.js`, so a `revoked` device can still download bundles. |
| M6 | Medium | **ALREADY FIXED** | SQLite removed; `pgize()` deleted. `control-plane/src/db.js` is PostgreSQL-only with `$n` placeholders, and `control-plane/src/schema.js` stores timestamp columns as `TIMESTAMPTZ` with `NOW()`. Connections set `TIME ZONE 'UTC'`; JS passes full ISO-8601 strings. Commit `b2b2cc1`.

## Maintainability findings (all CONFIRMED)

| # | Finding | Evidence |
|---|---|---|
| 1 | README is 3 lines and wrong | `README.md:1-3` references `apply_patch.py` (does not exist), no quickstart/repo map/test instructions. |
| 2 | Docs mixed with AI-process files in repo root | Was: 15+ `.md` files at repo root including `.agent/BEACON_RELAY_KIMI_FIXES.md`, `BEACON_RELAY_KIMI_AUDIT_FIXES(1).md` (since deleted), `AGENTS.md`, `models/`, etc. Fixed during remediation: product specs moved to `docs/specs/`, AI-process files moved to `.agent/`, `models/` moved to `.agent/models/`. |
| 3 | Comments point at internal labels | Multiple files reference "spec §X", "Phase N", "KF3", "BUILD_SPEC §Y" without explanation or link. |
| 4 | Wrong/stale comments | `control-plane/src/routes/events.js:6-7` claims server sets `rejectUnauthorized` — `index.js:84` sets `rejectUnauthorized: false`. `beacon-relay-agent/lib/update.js:3-4,11-12` claims verification happens before anything touches disk — `downloadBundle` writes the file first (`:41-43`). `update.js:116` claims `runUpdateCycle` "Never throws" — `downloadBundle` can throw. `docs/specs/BEACON_RELAY_STATUS.md:114-121` describes fleet map as "RBAC" — implementation is query-string role (`topology_view.js:151-159`). |
| 5 | No single test command / no CI | FIXED. `package.json` now has `test` (unit+security+Python), `test:integration`, `test:unit`, `test:security`, `test:python`, `test:db:reset`. `.github/workflows/ci.yml` runs the full suite in a Postgres service container. |
| 6 | Dual DB drivers | FIXED. SQLite removed; `control-plane/src/db.js` is PostgreSQL-only. `better-sqlite3` dependency deleted; `pgize()` removed. |
| 8 | No linting/formatting | FIXED. ESLint configured (`.eslintrc.cjs`) with `npm run lint`; ruff configured (`pyproject.toml`) for Python. Current lint output is warnings only, no errors. |
| 9 | Phase N script names | Was: `package.json:10-11` `phase1:test`, `phase3:build-image`. Fixed: renamed to purpose-based names (`compose:up`, `build:image`, `test:unit`, `test:integration`, `test:python`, `test`). |
| 10 | No architecture/trust-boundary diagram | No `docs/ARCHITECTURE.md` or `docs/SECURITY_MODEL.md`. |

---

## Counts

- **CONFIRMED:** C1, C2, C4, H1, H2, M1, M2, M5 (8 code findings) + H5 (repo setting) + 7 maintainability items.
- **ALREADY FIXED:** C3, H3, H4, M3, M6, maintainability #5, #6, #8.
- **DISPUTED:** M4 (literal claim wrong; related key-consistency bug remains).

*C2 is marked CONFIRMED because the token-creation gate and state/cert downgrade remain open, even though `device_key_fp` overwrite is now protected.*
