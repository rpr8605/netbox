# Beacon Relay — AI Agent Operating Guide

**Read this before starting any work session, regardless of which AI agent or tool is doing
the work (Kimi K3, OpenCode, or anything else).** This is not a task list — it's the standing
operating rules for how work gets done here, written specifically to avoid wasting credits
and compute, and to avoid the kind of "looks done, isn't" gap that already cost real time on
this project once (see the TPM acceptance-test history if you want the concrete example).

If your tool supports auto-loading a standing instructions file (check its docs for the exact
filename it looks for), put a copy there too. If it doesn't, the person running the session
should paste or reference this file at the start of every session.

---

## 1. Before touching any code

- **Read the spec docs before reading the code.** `BEACON_RELAY_SPEC_INDEX.md` tells you which
  document governs which part of the system and in what order. Don't re-derive architecture
  decisions from scratch by reverse-engineering the code when they're already written down.
  Re-deriving costs credits; reading doesn't.
- **Don't trust a DONE/PASS claim in any doc without a fresh test run backing it up in this
  session.** Docs go stale the moment code changes underneath them. Re-run the specific test
  named in `BEACON_RELAY_CHECKLIST.md` for whatever you're about to touch, before you assume
  it works, and before you build anything new on top of it.
- **Check what already exists before generating something new.** If a function, schema, or
  pattern already exists elsewhere in the repo that does most of what's needed, extend or
  reuse it. Regenerating a parallel version of something that already exists wastes credits
  twice: once to write it, once for someone to notice the duplication later.

## 2. Credit and compute efficiency rules

- **Cheapest test first, most expensive test last.** Run a syntax check or unit test before
  triggering a full Docker build. Run the full Docker build before triggering a full QEMU
  boot/acceptance cycle. Don't jump straight to the most expensive validation step if a
  cheaper one would have caught the same problem.
- **After two identical failures, stop and diagnose. Don't re-run a third time hoping for a
  different result.** This is the single most important rule in this document. The TPM
  acceptance test failed the same way seven times in a row across two files before anyone
  stopped to ask why. Each of those re-runs cost a full QEMU boot cycle for zero new
  information. If a fix attempt doesn't change the failure, the next step is root-causing
  the failure, not repeating the fix.
- **Scope changes to what the task actually needs.** Don't refactor unrelated code, rename
  things "while you're in there," or expand a narrow fix into a broader rewrite unless asked.
  A wider diff means more to review, more that can break, and more compute to re-test.
- **Avoid full rebuilds when an incremental one will do.** Check whether the build pipeline
  supports partial/incremental builds (layer caching, staged builds, etc.) before defaulting
  to a full `--no-cache`-style rebuild. Only force a full rebuild when there's a real reason
  to distrust the cache.
- **Batch related changes into one pass.** If a task touches five files, make the five edits
  and then run the test suite once, rather than editing one file and running the full suite
  five times.
- **Don't build ahead of demand.** Several docs already say this explicitly for specific
  features (extra EHR vendor profiles, extra interface engines) — treat it as a general rule,
  not just a rule for those two cases. Building a speculative feature nobody's asked for yet
  is compute spent on something that may get thrown away.
- **Prefer targeted edits over full-file rewrites** when a tool supports patch/diff-style
  edits. Regenerating an entire file to change a few lines costs more tokens than it needs to
  and makes the actual change harder to review.

## 3. Honesty and verification discipline

- **A task is DONE when a test proves it, not when the code compiles or the happy path looks
  right in a manual check.** PARTIAL is a legitimate, expected status. Use it whenever
  something is real but incomplete, mocked, or unverified, exactly the way
  `BEACON_RELAY_CHECKLIST.md` already does. There's no penalty for reporting PARTIAL
  accurately. There is a real cost to reporting DONE inaccurately, because everything built
  on top of a false DONE has to be re-checked once the truth comes out.
- **If a fix doesn't work after a reasonable attempt, report the actual failure and your best
  diagnosis, don't keep silently retrying variations.** Stopping to report costs one message.
  Five more blind attempts costs five full test cycles and still might not fix it.
- **State assumptions explicitly rather than guessing silently.** If a spec is ambiguous, say
  what you assumed and why, so it can be corrected quickly if wrong, instead of building on a
  wrong guess for several steps before anyone notices.

## 4. Documentation as a cost-saving practice, not overhead

- Every deliberate design or safety decision gets a comment explaining **why**, not just what
  the code does. The next session, whether it's you again or a different agent entirely,
  should be able to understand intent from the code and its comments without needing the
  full conversation history replayed to it. Replaying context costs credits; reading a good
  comment doesn't.
- When a phase or task finishes, update the relevant status doc (`BEACON_RELAY_CHECKLIST.md`,
  `BEACON_RELAY_STATUS.md`, etc.) in the same session, with the real test evidence. Don't
  leave that for a "later cleanup pass" — status drift is exactly what caused the TPM gap.

## 5. When to stop and ask vs. when to proceed

- **Proceed without asking** when the spec docs already answer the question, when the fix is
  narrowly scoped to what was asked, and when a reasonable default is obvious from existing
  patterns in the codebase.
- **Stop and ask** when a fix would require deviating from a documented architecture decision,
  substituting a different tool/library than the spec names, touching the PHI boundary or any
  safety-critical logic in the sidecar, or when two consecutive attempts at the same fix have
  failed and the next step would be a real guess rather than a diagnosis.
- **Stop and report back at every phase boundary**, per the existing spec-index rule. This
  isn't just a safety habit, it's a compute-saving one: it stops a wrong assumption from
  propagating through several more phases before anyone catches it.

## 6. Session handoff hygiene

- End each session by leaving the repo in a state a fresh session (possibly a different
  agent entirely) could pick up from cold, using only the docs and code, not by relying on
  this conversation's memory. If something important only exists in this chat and not in a
  doc or comment, write it down before the session ends.
- If you discover something during a task that isn't captured anywhere (a gotcha, a better
  approach, a gap in a doc), add it to the relevant doc immediately rather than mentioning it
  once and letting it disappear when the session ends.

---

*This file is written for Beacon Relay specifically, but the pattern (read specs first,
cheapest-test-first, stop-after-two-failures, DONE-needs-evidence, document decisions inline)
applies to any of Ryan's other products just as well. Copy and adapt rather than starting from
scratch for a new repo.*


## Model routing (paste this section into AGENTS.md)

You have three helper subagents. Use them to keep cost down. Delegation is required, not optional.

- **@scout (cheap):** use FIRST for any reading task: finding new or changed .md files, reading specs, summarizing large files, searching the codebase. Do not read large files or many files yourself; ask scout for a summary.
- **@architect (expensive):** use ONLY when
  - the task touches security, auth, certificates, device identity, PHI handling, or the data model, OR
  - you have failed the same fix twice (same test, same build error). Send it the error output and the file paths, not the whole repo.
- **@reviewer (mid):** run on the diff before EVERY commit. Fix anything it rates high severity before committing.

Cost rules
- Never retry the same failing approach more than twice. Escalate to @architect instead.
- Don't re-read files you already read this session unless they changed.
- Keep your own messages short. Summaries, not transcripts.
- At each checkpoint report, list which subagents you called and how many times, so I can see where the spend went.
