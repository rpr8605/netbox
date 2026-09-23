# Review Triage — Beacon Relay Independent Code Review 2026-09-23

Review: `docs/reviews/2026-09-23-independent-review.md` (moved from repo root during this session).  
Review written against commit `2176207`; current branch `agent/md-sync-2026-09-22`, HEAD `5faaddb`.

## Legend

- **CONFIRMED** — finding still present in current code.
- **ALREADY FIXED** — finding addressed by a commit after `2176207` (cited).
- **DISPUTED** — literal claim no longer accurate, but a related issue remains (explained with file:line).

---

| Finding | Severity | Status | Evidence / file:line |
|---|---|---|---|
| C1 | Critical | **CONFIRMED** | `control-plane/src/rbac.js:50` reads `const role = req.query?.role ?? req.body?.role ?? null`; `control-plane/src/index.js:92-98` `/fleet.html` only checks that *some* role is present. Any caller can declare `?role=operations-manager`. |
| C2 | Critical | **CONFIRMED*** | `control-plane/src/routes/enroll.js:21` `POST /api/enroll/tokens` has no permission gate. `control-plane/src/db.js:140-163` `upsertDevice` ON CONFLICT overwrites `state`, `cert_serial`, `cert_not_after`, downgrading an active device to quarantine. `setDeviceKeyFp` at `db.js:265-271` now uses `WHERE device_key_fp IS NULL`, so the **literal overwrite claim is fixed**, but the token endpoint still downgrades state/cert. |
| C3 | Critical | **CONFIRMED** (partial fix) | `docker-compose.yml:23` `"9000:9000"`, `:40` `"${POSTGRES_HOST_PORT}:5432"`, `:82` `"${CONTROL_PLANE_HOST_PORT}:9100"` all bind to all host interfaces. Passwords were moved out of compose by commit `2fce3cd`, but `.env.example:9,25` still ships defaults (`POSTGRES_PASSWORD=beacon`, `CA_PASSWORD=dev-only-insecure-changeit!`). |
| C4 | Critical | **CONFIRMED** | `control-plane/src/routes/releases.js:62-76` validates `stage`/`percentage` but not `version`. `beacon-relay-agent/lib/update.js:39-45` writes `/data/.update-${version}.raucb` verbatim; `:56-57` and `:77` use `execSync` template strings. `beacon-relay-agent/agent.js:267` `fetchBytes` returns `.body` regardless of `statusCode`. |
| H1 | High | **CONFIRMED** | `beacon-relay-agent/agent.js:80` defaults `rejectUnauthorized: false`; `mtls()` at `:117` returns only `{ cert, key }` with no `ca`. The CA fingerprint from enrollment is not used to pin the server. |
| H2 | High | **CONFIRMED** | `beacon-relay-agent/lib/update.js:139-158` calls `applyBundle`, then `healthCheckFn`, then `rollbackFn`/`markGoodFn` **before** reboot. These act on the currently booted (old) slot. The post-boot `markGood()` in `agent.js:153-156` is correct, but the in-cycle calls are unsafe. |
| H3 | High | **CONFIRMED** | Multiple routes lack any `preHandler` auth policy: `POST /api/alert-rules` (`alerts.js:26`), `POST /api/alert-contacts` (`alerts.js:38`), `POST /api/support/sessions/:id/close` (`support.js:93`), plus reads `GET /api/devices` (`devices.js:18`), `GET /api/devices/:id` (`devices.js:20`), `GET /api/alerts` (`alerts.js:21`), `GET /api/alert-rules` (`alerts.js:22`), `GET /api/channels` (`channels.js:73`), `GET /api/sites/:id/topology` (`channels.js:93`), `GET /api/sites/:id/full-status` (`topology_view.js:63`), `GET /api/support/sessions/:id` (`support.js:101`). |
| H4 | High | **ALREADY FIXED** | `control-plane/migrate.js:66-73` checks `schema_migrations` for marker `sqlite_to_postgres_v1`; `:118` renames the SQLite source to `*.migrated`. Commit `dfaca41`. |
| H5 | High | **CONFIRMED** (repo setting) | Remote is `https://github.com/rpr8605/netbox.git`; public visibility is a repository setting, not a code change. |
| M1 | Medium | **CONFIRMED** | `control-plane/src/deliver.js:27-33` `guardEmailPhi` only covers email (`sendSendGrid`, `sendSes`). `sendTwilio` (`:36-56`) for SMS/voice and `sendWebhook` (`:91-94`) for Slack/Teams do not call `scanPhi`. Voice TwiML at `:40` inserts `${body}` inside `<Say>` without escaping. |
| M2 | Medium | **CONFIRMED** | `control-plane/src/phi_guard.js:13-34` regexes flag ticket numbers/dates (`\b\d{6,10}\b`), any `M/D/YY` as DOB, and cannot detect patient names. No UI warning or structured-field preference is implemented. |
| M3 | Medium | **CONFIRMED** | `control-plane/src/db.js:125-138` `consumeEnrollmentToken` SELECTs then UPDATEs; same pattern in `consumeRetrustChallenge` (`:286-300`). |
| M4 | Medium | **DISPUTED** | `beacon-relay-agent/lib/tpm.js:51-78` `sealPrivateKey(plainPem)` ignores its argument and calls `tpm2_create` to generate a new RSA key inside the TPM. The private key is **not** generated in software and imported. However, `provision.js` sends the software-generated public key's fingerprint to the control plane as `device_key_fp`, while the agent later signs with the TPM-generated key, so the pins will not match on retrust. |
| M5 | Medium | **CONFIRMED** | `control-plane/src/routes/releases.js:46-55` checks `req.socket.authorized`, cert CN, and `getDevice()`, but does not inspect `device.state` or reuse `deviceFromCert()` from `events.js`, so a `revoked` device can still download bundles. |
| M6 | Medium | **CONFIRMED** | `control-plane/src/db.js:42-50` `pgize()` converts `datetime('now')` to `NOW()::TEXT`; `control-plane/src/schema.js` PG schema stores timestamp columns as `TEXT`. Comparisons are string-based. |

## Maintainability findings (all CONFIRMED)

| # | Finding | Evidence |
|---|---|---|
| 1 | README is 3 lines and wrong | `README.md:1-3` references `apply_patch.py` (does not exist), no quickstart/repo map/test instructions. |
| 2 | Docs mixed with AI-process files in repo root | Was: 15+ `.md` files at repo root including `.agent/BEACON_RELAY_KIMI_FIXES.md`, `BEACON_RELAY_KIMI_AUDIT_FIXES(1).md` (since deleted), `AGENTS.md`, `models/`, etc. Fixed during remediation: product specs moved to `docs/specs/`, AI-process files moved to `.agent/`, `models/` moved to `.agent/models/`. |
| 3 | Comments point at internal labels | Multiple files reference "spec §X", "Phase N", "KF3", "BUILD_SPEC §Y" without explanation or link. |
| 4 | Wrong/stale comments | `control-plane/src/routes/events.js:6-7` claims server sets `rejectUnauthorized` — `index.js:84` sets `rejectUnauthorized: false`. `beacon-relay-agent/lib/update.js:3-4,11-12` claims verification happens before anything touches disk — `downloadBundle` writes the file first (`:41-43`). `update.js:116` claims `runUpdateCycle` "Never throws" — `downloadBundle` can throw. `docs/specs/BEACON_RELAY_STATUS.md:114-121` describes fleet map as "RBAC" — implementation is query-string role (`topology_view.js:151-159`). |
| 5 | No single test command / no CI | `package.json:13` `npm test` runs only 3 scripts; no `.github/workflows/`. |
| 6 | Dual DB drivers | `control-plane/src/db.js` supports both `better-sqlite3` and `pg` via hand-written `pgize()` translation. |
| 7 | Auth scattered route-by-route | Some routes use `requirePerm`, some inline query-role checks, some mTLS checks, some no gate. No central route registry. |
| 8 | No linting/formatting | No ESLint, Prettier, or ruff configs. |
| 9 | Phase N script names | Was: `package.json:10-11` `phase1:test`, `phase3:build-image`. Fixed: renamed to purpose-based names (`compose:up`, `build:image`, `test:unit`, `test:integration`, `test:python`, `test`). |
| 10 | No architecture/trust-boundary diagram | No `docs/ARCHITECTURE.md` or `docs/SECURITY_MODEL.md`. |

---

## Counts

- **CONFIRMED:** C1, C2, C4, H1, H2, H3, M1, M2, M3, M5, M6 (11 code findings) + H5 (repo setting) + 10 maintainability items.
- **ALREADY FIXED:** H4.
- **DISPUTED:** M4 (literal claim wrong; related key-consistency bug remains).

*C2 is marked CONFIRMED because the token-creation gate and state/cert downgrade remain open, even though `device_key_fp` overwrite is now protected.*
