# Beacon Relay — Kimi Task List: Audit Findings Fix-Up

This document exists because Ryan walked through the actual codebase and logs (not just the
docs) and found real gaps between what's documented as working and what the evidence shows.
This is a targeted punch list, not a new phase. Nothing here should be treated as "vibe coded,
told it's functional" — every item below is either a confirmed bug (with evidence) or a
confirmed unverified claim (with the reason it's unverified).

**Note for Ryan before handing this to Kimi:** there is already a file in the repo named
`BEACON_RELAY_KIMI_FIXES.md` (dated 9/13). Check whether any of these items overlap with
what's already in there before dropping this in, so Kimi isn't working two versions of the
same fix in parallel. If there's overlap, merge rather than duplicate.

## Standing rules (same as every other phase — don't restate per-item)

- Never real hospital data, real patient identifiers, or a real HL7 feed. Synthetic/test data
  only, no exceptions.
- No tool substitution (RAUC, step-ca, LUKS, IoT Core, TPM libraries, etc.) without flagging
  why first.
- Every file touched gets the existing documentation standard: header comments, docstrings
  (what + when/why), inline comments on every deliberate safety or design decision.
- **Do not mark anything DONE in `BEACON_RELAY_CHECKLIST.md` without a fresh, live, re-run
  test result attached to the claim.** That's the exact gap that caused item #1 below — a
  status was marked DONE and then contradicted by the next 7 test runs. Every status change
  in this pass needs the command run and its actual output, not "should work now."
- **If you see a better way to write, structure, or test any of the code you touch while
  working through this list, write it up in this document under that item, or add a new
  item at the end under "Kimi's own findings."** This list is Ryan's read of the code, not
  the ceiling of it. Point out anything that looks fragile, over-complicated, or wrong even
  if it's not on the list.
- Stop after each numbered item, report back with the actual test output, and wait before
  moving to the next one. Don't chain fixes without a checkpoint — that's how a real
  regression (see item #1) gets buried under five more "final" attempts instead of getting
  root-caused.

---

## Priority 1 — Device identity / first-boot provisioning (blocking, contradicts checklist)

### 1. TPM unseal/open failure — 7 consecutive acceptance test failures

**Evidence:** `BEACON_RELAY_CHECKLIST.md` (written 11:03 AM, commit `84e3206`) marks first-boot
provisioning as **DONE**, citing `ACCEPTANCE_PASS: TPM-seal → quarantine → confirm → active
heartbeat in QEMU`. Every acceptance run logged after that point failed:

- `acc_fixpass.log` (12:09 PM) — failed before reaching the TPM step (external network
  `beacon_relay_default` not found — an environment/compose issue, separate bug, see #2)
- `acc_fixpass2.log` (12:14 PM) — reached the TPM step, **TPM unseal/open FAILED**
- `acc_final.log` through `acc_final5.log` (1:59 PM–2:51 PM, 5 separate runs) — **all five
  failed at the identical point**: key sealed to TPM successfully, then
  `decrypt: TPM unseal/open FAILED`, every time.

**Why this is priority 1:** per `BEACON_RELAY_SPEC_INDEX.md`, "nothing else matters until a
device can prove who it is." This is the literal foundation of the product. Right now there
is no evidence it works, and the checklist's DONE claim can't be substantiated by anything in
the logs that came after it was written.

**What's needed:**
- Root-cause the unseal failure, not just re-run it. What changed between the state that
  produced the original `ACCEPTANCE_PASS` (if it really happened) and now? Check for: TPM
  PCR/policy mismatches between seal and unseal, a QEMU vTPM state that isn't persisting
  correctly between the seal step and the unseal step, or a swtpm/software-TPM
  version/config issue specific to the VM harness (this may be a virtualization artifact
  rather than a real design flaw — worth explicitly testing whether the same seal/unseal
  logic behaves differently against a real TPM chip if one is available).
- Once root-caused and fixed, run the acceptance suite **3 times in a row** before calling it
  fixed. A single pass right after a fix doesn't clear the bar this item needs, given the
  history.
- Update `BEACON_RELAY_CHECKLIST.md`'s entry for this item with the real, current, re-verified
  status and the fresh test output it's based on.

### 2. `acc_fixpass.log` external network error

Separate, smaller issue surfaced in the same investigation: `network beacon_relay_default
declared as external, but could not be found`. This looks like a compose/harness environment
setup problem (a network expected to already exist wasn't created), not a product bug — but
confirm that and fix whatever's missing in the harness setup docs/scripts so this doesn't
silently fail future acceptance runs before they even reach the real test.

---

## Priority 1b — EHR adapter DONE claims are unverified (same pattern as item #1)

**Context:** `BEACON_RELAY_CHECKLIST.md` marks the following as **DONE**, all citing
`test_ehr_e2e.js` at 23/23: MEDITECH (Expanse, Magic, Client-Server), Cerner CommunityWorks,
CPSI/Evident, Epic Community Connect, athenahealth, Surescripts (net-check only), and the
VA/IHS HL7v2 tap profiles.

**Why this needs the same treatment as item #1:** the checklist has already been shown wrong
once, on the single most foundational claim in it (see Priority 1). That's reason enough to
re-verify every other DONE claim before repeating it to anyone outside the project, not just
assume the rest of the document is reliable because one item was caught.

There's also a structural reason to be specifically cautious about the EHR adapters: they all
route traffic through the same sidecar tap that Priority 2 below shows has real, confirmed
bugs (hardcoded ACK status, wrong latency measurement, a listener that doesn't survive a
dropped connection). If those bugs are real, they affect every EHR adapter built on top of
that tap regardless of what `test_ehr_e2e.js` reports, since the per-vendor code handles
recognizing and formatting that vendor's messages, not the transport-level correctness
underneath it.

**What's needed:**
- Read the actual adapter code for each EHR listed above, not just the checklist entry.
- Read `test_ehr_e2e.js` itself and answer plainly: does "E2E through real stack" mean tested
  against a real vendor sandbox/test system for that EHR, or tested end-to-end only within
  Beacon Relay's own stack using synthetic data with no real external EHR system involved at
  all? These are very different claims and the checklist's current wording doesn't make it
  clear which one is true. State the answer explicitly in the checklist entry itself once
  it's known, don't leave it ambiguous.
- Re-run `test_ehr_e2e.js` fresh and attach the actual output to the checklist entry, the
  same standard Priority 3 already sets for the rest of the document.
- Explicitly confirm or correct: none of this has been validated against a real, live
  hospital running production Meditech/Cerner/Epic/etc., since there is no live customer
  yet. "Passes synthetic E2E test" and "confirmed working at a real site" are different
  claims — make sure the checklist (and anything Ryan says to a prospective customer or
  consultant) doesn't blur the two.
- Prioritize re-verifying whichever EHR is most likely to come up in Ryan's near-term
  conversations first (Cerner CommunityWorks / Oracle Health, given active outreach from an
  Oracle/Cerner contact, and the Mirth/NextGen admin-API reader, given active outreach from a
  Mirth-experienced contact).

---

## Priority 2 — HL7/MLLP sidecar (`sidecar/mllp_tap.py`)

The safety-critical parts of this file are solid and shouldn't be touched without a good
reason: the metadata-only extraction, the per-device HMAC-SHA256 correlation tokenizer, and
the guarantee that raw message bodies never get retained when `phi_mode=False`. Leave that
design alone. The following are real functional gaps in the same file:

### 3. ACK/NACK status is hardcoded, not measured

In `run_passive_listener`, `ack_status="ACK"` is a literal string passed into every call to
`extract_metadata` — there's no code path that reads whether the message was actually
acknowledged. Every message currently gets recorded as acknowledged regardless of what really
happened on the wire. Since the core promise of this product is "know when something silently
fails," this is the single piece most responsible for actually catching that, and right now
it can't.

**What's needed:** parse the real ACK/NACK response for each message (or, since this is a
**passive, read-only tap**, correlate against the ACK/NACK frame that comes back over the
same mirrored traffic, rather than fabricating one). If the tap genuinely cannot see a real
response in passive mode, that's an important architectural fact to document clearly, not
paper over with a hardcoded value.

### 4. Latency measurement times the wrong thing

`started = time.time()` is set immediately before calling `extract_metadata`, and
`latency_ms` is calculated right after it returns. This measures how long the Python parsing
code took (likely sub-millisecond), not the actual interface latency (time between a message
going out and its acknowledgment coming back). As written, this field will always read close
to 0ms no matter how the real interface is performing.

**What's needed:** latency should be measured from when the outbound message is observed to
when its corresponding ACK/NACK is observed on the tap, correlated by message control ID
(the same field already used for the correlation token). If that's the fix, note that this
depends on fixing #3 first, since you need a real ACK signal to time against.

### 5. Listener only accepts one connection, ever

`run_passive_listener` calls `srv.listen(1)` and `conn, _addr = srv.accept()` once, processes
frames until that one connection closes, then the function ends — there's no loop back to
accept a new connection. If the mirror/SPAN feed connection drops for any reason (a switch
hiccup, a restart on the sending side), the tap is permanently dead until something manually
restarts the process.

**What's needed:** wrap the accept/process loop so the listener keeps accepting new
connections indefinitely (or reconnects if it's the client side of the relationship — check
which direction this is actually meant to run, since "passive tap" could be either). This
needs to survive indefinitely for a 24/7 monitoring product; a single dropped connection
should not require manual intervention.

### 6. Clarify what "passive tap" guarantees vs. what it requires externally

The code correctly guarantees it never writes back to the socket (the read-only safety
property is real and well-documented). But the code doesn't set up or verify the actual
network mirror/SPAN port that's supposed to feed it a copy of real MLLP traffic — that's a
separate piece of network engineering at the hospital site, not something this script does.
This isn't a bug, but the documentation in this file and in `BEACON_RELAY_EHR_INTEGRATIONS.md`
should be explicit about that boundary so nobody (Ryan included) confuses "the tap code is
read-only" with "the tap is already receiving real traffic."

**What's needed:** a doc-only fix — add a clear comment/section stating what has to exist on
the network side (mirror port, SPAN session, or equivalent) before this code receives
anything at all.

### 7. Stray compiled bytecode file

`sidecar/__pycache__/mllp_tap.cpython-314.pyc` showed up alongside the source file. Check
whether the build/packaging process is generating and shipping compiled `.pyc` files anywhere
near what eventually gets built into a customer-facing image, and make sure `__pycache__`
directories are excluded from anything that isn't a pure local dev artifact (confirm this is
already covered in `.gitignore` and in whatever the Configurator's image build actually
copies in).

---

## Priority 3 — Re-verify existing DONE/PARTIAL claims (process fix, not code fix)

Given that item #1 shows a DONE claim was contradicted by the very next test runs, do a
lightweight pass over `BEACON_RELAY_CHECKLIST.md`'s other DONE items and re-run the suites
listed in its own "Test evidence" table, rather than assuming they still hold. Specifically
re-confirm:

- Sidecar security suite (`python scripts/test_sidecar_security.py`, claimed 18/18) — note
  that this suite tests the payload-recovery/security properties, not the ACK/latency/
  connection-resilience issues in items #3–#5 above, so a passing re-run here does NOT mean
  those are fixed. Don't let a green sidecar suite be read as "the sidecar works" — it means
  the security boundary holds, which is a narrower claim.
- Phase 3 QEMU acceptance (directly relevant, see item #1).
- Anything else in that table that hasn't been re-run since the checklist was written.

If a re-run comes back different from what the checklist says, fix the checklist entry and
say so plainly, don't quietly overwrite it.

---

## Kimi's own findings

*(Space for Kimi to add anything found while working through the above that wasn't already
flagged — a fragile pattern, a better approach to one of the fixes above, a similar
"claimed done but unverified" gap spotted elsewhere in the codebase, etc. Same format as the
numbered items above: what you found, why it matters, what you'd suggest.)*
