# Kimi prompt: interface engine readers (verify first, then build)

Paste everything below the line into a fresh `/new` session in the Beacon Relay repo.

---

You are working in the Beacon Relay repo. Create branch `agent/engine-readers` from `agent/md-sync-2026-09-22`.

## Goal

Give sites that don't run Mirth real interface visibility, using **read-only** monitoring APIs and engine-neutral signals. This task has three parts, done in order:

1. **Verify** the vendor facts below against official sources. Build nothing until this is done.
2. Build the **engine-neutral foundation**: a shared data shape, adapter capabilities, port checks, and syslog and SNMP v3 intake.
3. Build the **Iguana** and **InterSystems** readers, then move the existing Mirth reader onto the same shape.

Corepoint, Rhapsody, Cloverleaf and MEDITECH readers are **out of scope** for this task, apart from registry entries marked "needs customer access" (step 2.1).

## Rules (apply to every step)

- **Never guess.** Only official vendor documentation or a real running instance counts as verified. Blog posts, forums and AI summaries are leads, not proof.
- **Read-only, enforced in code.** Each reader has a hard allowlist of the exact monitoring paths it may call. Anything else throws before a request is sent, and a test proves it. No start/stop, config, deploy or other write actions, even if the vendor API has them.
- **No patient data.** Collect health, state, counts, queue depth, errors and timing only. Never collect message payloads, and never store raw log or alert text. Engine error text can contain patient data (step 2.4).
- **Credentials** are secret references, never plain text in code, config, tests, logs or git. TLS verification stays on. Reuse `beacon-relay-agent/lib/tls_pin.js` where it fits.
- **Never deploy, push to `main`, merge, or touch keys, certs, or the CA** without asking Ryan.
- **Checkpoint every $5** in `.agent/checkpoints.md`. If the same fix fails twice with no progress, stop and log it in `.agent/attempts.md`.
- **No em dashes** in user-facing text.
- Keep all existing tests passing, especially the Mirth and EHR suites.

## Step 1: Verify (output: `.agent/engine-verification.md`)

Check each claim against the vendor's own documentation. Use your web fetch tool. If a vendor doc page won't load or is behind a login, mark the claim **NOT_VERIFIED** and give the reason. Do not fill gaps from memory.

For every row record: **status** (VERIFIED, PARTLY VERIFIED, NOT_VERIFIED, or WRONG), the **official URL**, the **product version the doc covers**, and a **short exact quote**.

| # | Claim to check | Where to start |
|---|---|---|
| I1 | Iguana `/status` returns an XML summary of all channels | help.interfaceware.com/v6/monitor-iguana-channels-programmatically |
| I2 | Iguana `/monitor_query` returns XML with server stats and channel summaries. Is it GET or POST? | same page, plus the "Monitoring Remote Iguana Instances" page |
| I3 | Iguana `/channel_status_data.html?Channel=<name>` returns JSON for one channel | same |
| I4 | Iguana auth method for these calls (basic auth or session), and whether a read-only user role exists | Iguana user/role docs |
| I5 | Which Iguana versions these apply to (6.x? Iguana X?) and whether Iguana X uses different endpoints | docs.interfaceware.com Iguana X Monitoring page |
| I6 | Exact channel fields available: state, queue count, error state, last activity, message counts | from the docs or a sample response in them |
| S1 | InterSystems `/api/monitor/metrics` returns Prometheus/OpenMetrics text | docs.intersystems.com Monitoring Guide, "Monitoring InterSystems IRIS via REST" (GCM_rest) |
| S2 | `/api/monitor/alerts` exists; what format does it return? | same |
| S3 | `/api/monitor/interop` exists; which metrics (interfaces running, messages sent) and **from which version** | same, check release notes too |
| S4 | Auth: the `/api/monitor` web app's default auth, and how to set up a least-privilege monitor role | same |
| S5 | Custom metrics via `%SYS.Monitor.SAM.Abstract` and `SetSensor()` | same guide |
| C1 | Corepoint 7.5.3 made an Administration REST API generally available. Record only whether it's confirmed and where. Do not build. | rhapsody.health blog "Corepoint 7.5.3 features Administration REST API" |
| R1 | Rhapsody management API docs are behind a customer portal. Record only; do not build. | rhapsody.health, docs.rhapsody.health |

If the InterSystems doc pages render with JavaScript and your fetch tool can't read them, say so. Do not treat a third-party summary as verification. A row can stay NOT_VERIFIED; Ryan will confirm it on a real instance.

**Stop after Step 1** and write a checkpoint that shows the verification table and lists anything that changes the plan. Wait for Ryan's go-ahead before Step 2.

## Step 2: Engine-neutral foundation

### 2.1 Shared shape and adapter contract

Create `beacon-relay-agent/lib/engines/` with:

- `contract.js`: the normalized observation and the adapter interface.
  - Observation fields:
    - `engine`: `{vendor, product, version, instance_id}`
    - `route`: `{external_id, name, source_system, destination_system, protocol, direction}`
    - `observation`: `{observed_at, state, throughput_count, backlog_count, error_count, last_success_at, evidence_source, collection_confidence}`
    - `privacy`: `{payload_collected: false, patient_identifiers_collected: false}`
  - `state` is one of `ok`, `degraded`, `down`, `stopped`, `unknown`.
  - `evidence_source` is one of `native_api`, `port_check`, `syslog`, `snmp`, `canary`.
  - Any field a source can't provide is `null`, never invented.
- `manifest.js`: each adapter declares `{vendor, product, minVersion, capabilities[], readOnly: true, permitsPayloadCollection: false, allowedPaths[]}`. Capabilities: `instance_health`, `route_inventory`, `route_health`, `alerts`, `throughput`, `queue_depth`, `error_metadata`, `config_version`.
- `registry.js`: every adapter plus entries for Corepoint, Rhapsody, Cloverleaf and MEDITECH marked `status: "needs_customer_access"`, with no code behind them.
- Adapter methods: `discover()`, `collectHealth()`, `collectRoutes()`, `collectAlerts()`.
- A shared HTTP helper that refuses any path not in the adapter's `allowedPaths`, with timeouts and a per-instance rate limit (default 1 request every 15 s).

Also add a JSON Schema for the observation in `schemas/` and regenerate types with `npm run gen-types`.

### 2.2 Wrap Mirth

Make `mirth_admin.js` available as a Mirth adapter that emits the shared shape. Keep its current exports working so nothing else breaks.

### 2.3 Port checks

For each configured HL7 listener (host and port), every 60 s: TCP connect, record open, refused or timeout plus connect time, then **close without sending any bytes**. Add a test proving zero bytes are written. The result maps to `evidence_source: "port_check"`, which can say up or down but never "messages flowing."

### 2.4 Syslog intake

- Listens only on the management interface and only accepts allowlisted source IPs. Put the source check in code, not just the firewall. Default is off, enabled per site.
- Parses RFC 5424 and RFC 3164.
- Per-engine rule files (regex) map a line to `{rule_id, severity, route_name or null}`.
- **Store only** the rule id, severity, timestamp, source IP and extracted route name. **Discard the raw line** right after matching. Unmatched lines are counted, not stored.
- Rules ship empty for engines without verified log formats. No guessed patterns.

### 2.5 SNMP v3 intake

- Traps and informs with authPriv only. Reject v1 and v2c.
- OID-to-event mappings come from config. None ship until a vendor MIB is verified.
- Same storage rule as syslog: mapped fields only.
- If no maintained SNMP v3 library that fits the image checks out (license, Debian package, maintenance), stop, log it, and ask Ryan instead of picking one blindly.

## Step 3: Readers

Build each reader **only from rows marked VERIFIED in step 1**. Anything else returns a clear `NOT_VERIFIED` error and stays out of `allowedPaths`.

### 3.1 Iguana (`engines/iguana.js`)

- `allowedPaths` holds only the verified monitoring paths from I1 to I3.
- Parse XML safely: no external entities, no DTDs, and a size limit.
- Map channel state, queue count, error state and last activity into the shared shape.
- Recording thread counts is optional. The docs say some of that data is embedded in HTML, so skip it if it isn't clean to parse.

### 3.2 InterSystems (`engines/intersystems.js`)

- Scrape each verified `/api/monitor/*` endpoint and parse the Prometheus/OpenMetrics text format. Use a small, well-tested parser or write one with tests; check the license first.
- Map system metrics to `instance_health`, alerts to `alerts`, and interop metrics (only if S3 is verified) to `route_health` and `throughput`.
- Version-gate endpoints: a missing endpoint gives `null` fields and a note, not an error storm.
- Leave a documented hook for customer-created custom metrics (S5), off by default.

### 3.3 Where it shows up

- Readers run from `monitor_loop.js`, using the site's EHR/engine profile. Add engine config fields to the profile format in `config/ehr-profiles/` without breaking existing profiles.
- Observations feed the existing ADT, Lab, Pharmacy and Interfaces checks, so the console shows which source (API, port check, syslog, SNMP) backs each status. A service with no source shows "Not watched," never green.

## Step 4: Tests (all required)

- **Mock servers** for Iguana and InterSystems, built from the **sample responses in the vendor docs** where available. Where no sample exists, use a clearly labeled synthetic sample and note it in `.agent/engine-verification.md`.
- An allowlist test per adapter: every write-style path (for example channel start/stop) is refused before any network call.
- Unsafe XML (external entity, oversized input) is rejected.
- Prometheus parser: comments, labels, escaped label values, counters vs gauges, missing metrics.
- Port check: sends zero bytes; open, refused and timeout cases.
- Syslog: accepts both formats, source allowlist enforced, raw line never stored (check the stored record and the logs).
- SNMP: v2c rejected; if the library is blocked, those tests are skipped with a logged reason.
- A privacy test: no observation from any adapter has `payload_collected` set to true or any field containing sample message text.
- Existing suites still pass: `npm run ehr:unit`, `scripts/test_agent_loop.js`, and the sidecar Python tests.

Add all new tests to the single `npm test` if that exists by then; otherwise add npm scripts `engines:unit` and list them in the checkpoint.

## Step 5: Deliverables and checkpoint

- `.agent/engine-verification.md`: the verified table.
- `docs/ENGINE_READERS.md`: plain-language guide covering what each engine gives you, what the hospital must provide (read-only user, network access, version), and what's still unverified.
- `docs/SITE_ENGINE_QUESTIONS.md`: the intake questions per engine. For Rhapsody, use this request wording:

  > We are evaluating a read-only integration-health connector. Could your Rhapsody integration team provide a read-only service account, the installed Rhapsody version and build, the relevant REST or management API documentation, authentication requirements, rate limits, and the endpoints that expose engine health, communication-point status, queue and throughput indicators, processing errors, and notifications? We do not need permission to start or stop communication points, modify routes, view message content, or write to production systems.

- Final checkpoint: what's built, test results, every NOT_VERIFIED item, and the next 3 steps. The next 3 should include getting Corepoint docs from a licensed site and testing against a real Iguana or InterSystems instance.
