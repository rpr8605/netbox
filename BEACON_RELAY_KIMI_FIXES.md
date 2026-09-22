# Beacon Relay — Fix List for Kimi (next session)

Generated from a clarity/correctness pass over `beacon-relay-agent/`, `control-plane/src/`,
`sidecar/`, `configurator/`, and `pipeline/`. That pass was comment-only (see commit
`96d6a46`, "docs: comment accuracy pass..."). This file is the follow-up: the actual logic
issues that pass turned up, left unfixed on purpose so they'd get a real look instead of a
drive-by patch. Each item below is self-contained — file, problem, why it matters, and a
concrete fix — so any one of them can be handed to Kimi on its own.

After fixing any item, re-run the relevant suite from `BEACON_RELAY_STATUS.md` §2 before
calling it done. Most of these touch `scripts/test_agent_loop.js` or
`scripts/test_alerting_rbac_audit_support.js`.

---

## 1. Self-monitor heartbeat check will falsely report "down" forever after boot

**Files:** `beacon-relay-agent/agent.js`, `beacon-relay-agent/lib/self_monitor.js`

**Problem:** `agent.js` declares `let lastHeartbeatOkAt = Date.now();` at module scope
(line 183), then passes it **by value** into the context object handed to
`startMonitorLoop` (line 206: `{ ..., lastHeartbeatOkAt, ... }`). Every successful
heartbeat POST reassigns the *outer* `lastHeartbeatOkAt` variable (line 131), but the copy
already baked into that context object never changes. `self_monitor.js`'s
`checkHeartbeat({ lastHeartbeatOkAt, maxAgeMs = 30_000 })` reads its own parameter, which
is that frozen, boot-time snapshot — not the live value.

**Why it matters:** this is the exact "silent monitor failure" case the self-monitoring
system exists to catch (per its own header comment). Right now it will report the
heartbeat monitor as failed ~30 seconds after every boot and never recover, even when
heartbeats are landing fine. On a real device this either trains the ops team to ignore a
permanently-red self-check, or fires a false escalation every boot — both bad.

**How to fix:** stop passing a plain value; pass something that can be read live. Options,
in order of least invasive:
- Wrap it in a getter/object the monitor loop re-reads each tick, e.g. keep
  `state.lastHeartbeatOkAt` on a shared mutable object instead of a bare `let`, and update
  `heartbeat()` to write `state.lastHeartbeatOkAt = Date.now()` instead of reassigning a
  local variable.
- Or have `checkHeartbeat` accept a function (`getLastHeartbeatOkAt()`) instead of a value,
  and call it at check time.
Either way, the monitor loop's `ctx` needs to end up reading the *current* value each time
`self_monitor.js` runs, not a value captured once when `ctx` was built.

**Verify:** `node scripts/test_agent_loop.js` — check B1/B2 specifically simulate heartbeat
silence; make sure a test also covers the "heartbeat keeps landing, check should stay OK"
case, since that's the case the current bug fails silently on and the existing suite may
not catch it (double check before assuming green means fixed).

---

## 2. RBAC map is defined but not enforced almost anywhere

**Files:** `control-plane/src/rbac.js`, and every route under `control-plane/src/routes/`
except `GET /api/audit` in `control-plane/src/index.js`.

**Problem:** `rbac.js` defines a real permission map (`ROLE_PERMISSIONS`) for five roles
and a `requirePerm()` gate. As of this repo, `requirePerm` is wired into exactly one
route: `GET /api/audit` (`control-plane/src/index.js` line 105). Every other route that
should be gated is not:
- `routes/alerts.js` — alert firing, ack, and rule writes are all ungated.
- `routes/channels.js` — channel registration is ungated; `/api/enroll/tokens` has **no
  permission defined for it at all** in `ROLE_PERMISSIONS`, so there's nothing to wire it
  to yet.
- `routes/devices.js` — the quarantine → active device confirm endpoint is ungated, and
  again, no permission exists in the map for it.
- `routes/support.js` — support-session request is ungated, even though `support:request`
  already exists in the map for `support-technician`.
- `routes/topology_view.js` — the cross-site rollup view is ungated at the route level;
  `routes/channels.js` enforces its own two-role allow-list inline instead of going through
  `can()`/`requirePerm()`, so there are two different gating mechanisms in the codebase
  right now.

This is documented honestly in `rbac.js`'s own comments (added in the comment-accuracy
pass) and in `BEACON_RELAY_STATUS.md` §3 ("RBAC is a structural stub"), so this isn't a
surprise finding — it's the known next step, made concrete.

**Why it matters:** in Phase 2, `role` arrives as a plain request attribute
(`req.query.role`/`req.body.role`), so today anyone who can reach the control plane can
set any role they want and hit any route. That's fine as a documented interim state before
Phase 8 auth lands, but it should not quietly become "fine forever" because nobody wrote
the wiring down as a todo. Treat this whole section as that todo.

**How to fix, per route:**
- `routes/alerts.js`: add `preHandler: requirePerm('alerts:fire', appendAudit)` to the fire
  route, `'alerts:ack'` to ack, `'alerts:rules:write'` to rule create/update/delete —
  matching the permissions already defined in `rbac.js`.
- `routes/support.js`: add `preHandler: requirePerm('support:request', appendAudit)` to the
  session-request route.
- `routes/topology_view.js`: either add `requirePerm('topology:rollup', appendAudit)` to
  the rollup route, or migrate `routes/channels.js`'s inline allow-list to go through
  `can()` too, so there's one gating mechanism, not two. Pick one and document why in a
  comment.
- `routes/channels.js`: decide what permission channel registration needs (there's no
  existing one — add e.g. `'channels:write'` to the map for the roles that should have it,
  most likely `customer-it-admin` and `operations-manager`), then gate the route with it.
- `routes/devices.js` + `rbac.js`: add a `'devices:confirm'` permission to `rbac.js`'s map
  (decide which roles get it — `support-technician` and `operations-manager` are the
  obvious candidates given their other permissions), then gate the confirm route with it.
- `/api/enroll/tokens` (`routes/channels.js`): same pattern — add a permission (e.g.
  `'enroll:tokens:write'`), assign it to the roles that should be minting enrollment
  tokens, gate the route.

**Verify:** `node scripts/test_alerting_rbac_audit_support.js` covers RBAC; extend it with
a deny-case test per newly-gated route (wrong role gets 403) before calling this done —
the existing 23/23 passing doesn't mean these routes are covered today, since they aren't
gated yet.

---

## 3. Control-plane server is reachable on the host network, not localhost-only

**Files:** `control-plane/src/index.js`, `docker-compose.yml`

**Problem:** Comments in this repo used to describe the operator/enrollment endpoints as
"Phase 1: localhost-only" (fixed as part of the comment-accuracy pass, since it was false).
The actual behavior: `app.listen` binds `0.0.0.0`, and `docker-compose.yml` publishes
`9100:9100` on the host. Combined with item 2 above, `/api/enroll/tokens` (enrollment
token minting) is reachable by anyone who can reach that port on the host network, with no
auth and no RBAC gate.

**Why it matters:** an enrollment token is what lets a new device join the fleet. Minting
one is not a read-only action — it's the kind of thing that should be the *first* thing
gated, not something discovered as "oh, this was never actually localhost-only."

**How to fix:** this is really two separate fixes, pick based on urgency:
- Short term (dev/pilot posture): bind `app.listen` to `127.0.0.1` explicitly and drop the
  `9100:9100` port publish from `docker-compose.yml` if nothing outside the compose network
  needs to reach it directly; front it with whatever *does* need direct access (a reverse
  proxy, VPN, etc.) instead of exposing it raw.
- Real fix (what the RBAC work in item 2 is for): gate `/api/enroll/tokens` with a real
  permission once the Phase 8 auth layer supplies a real principal, so "who can reach the
  port" stops being the only control.
Do the short-term fix now regardless of when Phase 8 lands — there's no reason enrollment
minting should be open on the host network in the meantime.

---

## 4. Configurator flash gate has no boot-disk exclusion check

**Files:** `configurator/src/index.js`, `configurator/flash_wrapper.sh`

**Problem:** `BEACON_RELAY_BUILD_SPEC.md` calls for the flash tool to refuse a target that
looks like the machine's own boot disk. That check does not exist. The only safeguard
today is `confirmHard()` in `configurator/src/index.js` (line 29), which requires the
operator to retype the exact target path — a real safeguard against fat-fingering, but not
a safeguard against confidently flashing the wrong drive on purpose or by bad automation.

**Why it matters:** this tool's entire job is writing raw bytes to a block device. The
retype-to-confirm gate protects against typos; it does nothing if someone (or a script)
correctly types the wrong-but-real device path — including, worst case, the box's own
boot disk.

**How to fix:** before `confirmHard()` runs, add a check that compares the resolved target
device against the system's boot/root device and refuses (hard exit, not just a warning)
if they match. On Linux, this can be done by resolving the boot disk from `findmnt -n -o
SOURCE /` (strip the partition suffix to get the parent block device) and comparing it
against the resolved target — reject if they're the same device. Put this check in
`configurator/src/index.js` right before the existing `confirmHard()` call (there's
already a comment there at lines 89-93 marking exactly where this needs to go and warning
not to remove the existing confirm without adding this first).

**Verify:** no automated test currently covers this (the `vm-harness` acceptance flow
flashes into a QEMU disk image, not a real boot disk) — after adding the check, manually
verify it refuses when pointed at the running system's own root device, and still succeeds
against a non-boot target/QEMU raw file.

---

## 5. Post-flash integrity check will false-fail on a real (larger) target disk

**File:** `configurator/flash_wrapper.sh`

**Problem:** Line 28's read-back verification —
`dd if="$TARGET" bs=4M status=none | sha256sum` — reads `$TARGET` to EOF with no length
limit. Against a raw file sized exactly to the image (the QEMU dev path), that's correct.
Against a real physical drive, which is almost always larger than the image, this hashes
the image bytes plus everything else on the disk after it, so the hash will not match
`LOG_SHA` even when the write was byte-for-byte correct.

**Why it matters:** this is the safety check that's supposed to catch a bad flash. As
written, it will report failure on every good flash to a real drive, training whoever runs
it to distrust or skip the check — which defeats the point of having it.

**How to fix:** cap the read-back to the image's byte length instead of reading to EOF.
Get the image size first (`IMG_SIZE=$(stat -c%s "$IMG")`), then read back exactly that many
bytes: `dd if="$TARGET" bs=4M count=$(( (IMG_SIZE + 4*1024*1024 - 1) / (4*1024*1024) )) iflag=count_bytes status=none` —
or simpler, use `dd ... bs=1 count="$IMG_SIZE"` if the performance hit of `bs=1` over the
full image size is acceptable (probably not for a multi-GB image; prefer the `count_bytes`
form with a larger block size). Whatever the exact `dd` invocation, the intent is: hash
only the first `IMG_SIZE` bytes of `$TARGET`, not the whole device.

**Verify:** test against both a raw file sized to the image (should still pass) and a
larger file/loop device standing in for a physical drive (should now also pass, where
today it would incorrectly fail).

---

## 6. Microsoft Graph client sends a malformed Authorization header (currently unwired, but a real bug)

**File:** `beacon-relay-agent/lib/graph.js` (around lines 21-22)

**Problem:** the object literal defines `authorization: \`Bearer ${token.access_token}\``
on one property, but the `get()` method actually used to make requests sends
`headers: { authorization: \`${token.access_token}\` }` — no `"Bearer "` prefix. The
correctly-prefixed value is dead: nothing reads it.

**Why it matters:** this file isn't imported by `agent.js` today (per
`BEACON_RELAY_STATUS.md` §3: "the existing `beacon-relay-agent/lib/graph.js` is only the
earlier Step-1 Graph security-signal work"), so this bug is currently harmless. It stops
being harmless the moment someone wires Graph calls back in for the
`CONTROLS_AND_IDENTITY` §6 M365 account-health work — every request will 401 until this is
noticed, likely during that future integration work, costing time re-discovering a bug
that's already known.

**How to fix:** in the `get()` method, change
`headers: { authorization: `${token.access_token}` }` to
`headers: { authorization: `Bearer ${token.access_token}` }`, and delete the now-redundant
unused `authorization` property elsewhere in the object if it isn't used for anything else.

**Verify:** `scripts/test_step1_signals.js` exercises this file — confirm it still passes,
and if it doesn't already assert on the header value, add an assertion that the sent
`authorization` header starts with `Bearer ` so this can't silently regress again.

---

## 7. `lib/enroll.js` is dead code that would crash if anything ever imported it

**File:** `beacon-relay-agent/lib/enroll.js`

**Problem:** nothing in the codebase imports this file — `provision.js` and `agent.js`
each have their own inline CSR/HTTP logic instead. It's still copied into the device image
by `pipeline/build.js`. It imports `node-forge` (line 14), which conflicts with the
documented "no npm packages in the image" constraint (see `agent.js`'s header) and isn't
installed anywhere in this repo — so the moment anything does import it, it crashes.

**Why it matters:** it's currently harmless dead weight, but it's the kind of thing that
looks live (it has real logic, a real header comment, real exports) and could get wired in
by someone who doesn't check whether its dependency is actually available on-device.

**How to fix — pick one:**
- **Remove it entirely** if `issue_cert.js` (the current canonical CSR->sign path, per its
  own header) already covers everything this file was for. Also remove it from whatever
  list `pipeline/build.js` / `pipeline/stages/30-agent.sh` use to decide which agent files
  get copied into the image, so it stops shipping on-device for no runtime purpose.
- **Or keep it as the shared-helper consolidation target** (its own header comment
  describes this intent — "kept around... for whoever eventually consolidates
  provision.js/agent.js onto shared helpers") — in that case, replace the `node-forge`
  usage with Node's built-in `crypto` module (which `provision.js`/`agent.js` already use
  for their inline CSR logic) so it can actually be imported on-device without adding a
  dependency that isn't there.
Don't leave it as-is; either path is better than dead code with a landmine dependency.

---

## 8. Two unused data flows in the pipeline (dead code, not bugs, but worth cleaning up)

**Files:** `pipeline/gen_sfdisk.js`, `pipeline/stages/20-partition.sh`,
`pipeline/stages/40-rauc.sh`

**Problem:**
- `pipeline/gen_sfdisk.js` writes `out/<version>/sfdisk.script`. Nothing reads it —
  `pipeline/assemble_image.sh` partitions the image directly via `jq` + `parted` instead.
- `pipeline/stages/20-partition.sh` writes `/tmp/partition.env` (`PART_*` variables).
  `pipeline/stages/40-rauc.sh` sources that file (line 15) but never references any
  `PART_*` variable — `40-rauc.sh` builds its `system.conf` from the JSON partition map
  directly instead. This is already flagged in a comment at that `source` line, but the
  dead write in `20-partition.sh` itself is still there.

**Why it matters:** neither breaks anything today, but both are exactly the kind of
red herring that makes a build pipeline hard to trust cold — a reader has to go verify
these are unused rather than assume they matter, every single time they touch this code.

**How to fix:** confirm (via the greps already done above, or fresh ones) that nothing
else in the repo or in `pipeline/rootfs_files/` depends on `out/<version>/sfdisk.script`
or `/tmp/partition.env`'s `PART_*` variables, then delete the `gen_sfdisk.js` call from
`pipeline/build.js`, delete `gen_sfdisk.js` itself (or keep it if it's useful as a
human-readable debug artifact, but say so in its header instead of implying it's consumed
downstream), and drop the `/tmp/partition.env` write from `20-partition.sh` (or keep the
`source` line in `40-rauc.sh` removed instead, whichever direction makes more sense once
you're looking at both together).

**Verify:** `node scripts/test_agent_loop.js` and the QEMU acceptance harness
(`vm-harness/acceptance.sh`) don't depend on either dead flow, so both should still pass
unchanged after removal — run them to confirm.

---

## 9. Unconfirmed: no visible A/B slot-selection or rollback logic for RAUC updates

**Files:** `pipeline/assemble_image.sh` (grub config, ~line 111-123), and anywhere the
runtime update/rollback logic would live (not found in this repo's `pipeline/` or
`pipeline/rootfs_files/` during this pass).

**Problem:** the embedded `grub.cfg` written by `assemble_image.sh` hardcodes
`root=LABEL=ROOTFS_A` unconditionally (line 115), and the kernel/initrd are copied onto the
ESP once, from slot A, at image-build time. No grubenv, no slot-selection variable, and no
rollback-on-failed-boot logic was found anywhere in the pipeline during this review.

**Why it matters:** `BEACON_RELAY_STATUS.md` §1 lists signed A/B updates as part of what
Phase 3 proves, and §3 separately notes "the dev → test-device → pilot-group → broad
rollout... is not built" for the *staged rollout*, which reads as if the underlying A/B
switch itself works and only the rollout policy on top of it is missing. If grub can't
actually be told to boot slot B after a RAUC update lands there, that's a more fundamental
gap than a missing rollout policy — RAUC would be updating a slot the bootloader never
boots into.

**How to fix — this one needs investigation before a code fix, not a patch:**
1. Check whether RAUC's own hooks (a `grubenv`-based bootloader backend is RAUC's standard
   approach) are configured somewhere outside this repo's `pipeline/` directory — e.g. in
   `pipeline/rootfs_files/` as a shipped `grub-editenv`/`grubenv` setup, or in the RAUC
   config referenced in `pipeline/stages/40-rauc.sh` (check `system.conf` for a
   `[handlers]` or bootloader section).
2. If it genuinely isn't configured anywhere: this needs real design work, not a quick
   patch — RAUC's grub integration typically means grub reads a `grubenv` variable
   (commonly `ORDER`/`A_TRY`/`B_TRY`-style counters) to decide which slot to boot, and RAUC
   itself updates that variable after a successful install; the embedded static
   `grub.cfg` written by `assemble_image.sh` would need to chainload based on that
   variable instead of hardcoding `ROOTFS_A`.
3. Confirm with whoever built the original Phase 3 acceptance run
   (`vm-harness/acceptance.sh`) whether an actual slot-B boot was ever exercised — the
   acceptance criteria listed in `BEACON_RELAY_STATUS.md` §1 (first-boot → TPM-seal →
   quarantine → confirm → active heartbeat) describe a first-boot flow on slot A, not an
   update-and-reboot-into-slot-B flow, so it's possible this was simply never tested yet
   rather than broken.

**Verify:** once resolved one way or the other, this needs its own acceptance test: build
an image, apply a RAUC bundle update, reboot, and confirm the device actually comes up on
slot B — that scenario doesn't appear to exist in `vm-harness/acceptance.sh` today.

---

## Suggested order

Cheapest and highest-leverage first: **6 → 5 → 1 → 4 → 7 → 8 → 3 → 2 → 9**. Items 6, 5, and
1 are each a small, well-understood, single-file fix. Item 4 is small but safety-critical.
Item 2 is the biggest chunk of work (touches ~5 files) but is mechanical once you start.
Item 9 needs investigation before it needs code, so it's last on purpose, not because it's
unimportant — it may turn out to be the most important item on this list.
