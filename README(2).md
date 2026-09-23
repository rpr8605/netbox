# Model Routing Guide (OpenCode Zen)

**Goal:** cheap models do the cheap work, strong models only touch the hard parts.
**Prices from:** your Zen model list, 2026-09-22. Columns are $ per 1M tokens: input / output / cached read / cached write.

---

## How to read cost in a coding agent

Coding agents re-send the whole conversation on every turn, so most of what you pay for is **cached input**, not output. Sticker price (input/output) is misleading on its own.

**Blended cost** below assumes a typical agent session: **80% cached read, 15% fresh input, 5% output**. It's the best single number for comparing models on agent work. Rerun `python3 cost-calc.py` when prices change.

---

## The team (default setup)

| Role | What it does | Primary | Backup | Blended $/1M |
|---|---|---|---|---|
| **Scout** | Find new MD files, read/summarize docs, grep, list what changed | `deepseek-v4-flash` | `gpt-6-luna` | ~$0.05 |
| **Builder** | Day-to-day coding, tests, fixing build errors | `kimi-k2.7-code` | `minimax-m3` / `deepseek-v4-pro` | ~$0.15 to $0.57 |
| **Reviewer** | Second-opinion code review before commit | `claude-sonnet-5` | `gpt-6-sol` | ~$0.96 |
| **Architect** | Planning, hard bugs, security, PHI boundary, device identity | `claude-opus-5-5` | `gpt-5.6-sol` | ~$1.76 |
| **Small model** | Session titles, tiny summaries | `gpt-5-nano` | `gpt-6-luna` | ~$0.04 |

**Why this split**
- **Scout is ~35x cheaper than Architect.** Reading files is the part that burns the most tokens and needs the least brains.
- **The Reviewer comes from a different model family than the Builder,** so it doesn't share the Builder's blind spots.
- **The Architect is the most expensive model on the list you should use regularly.** Only call it for decisions that are expensive to get wrong.

---

## Escalation rules

1. **Start at the cheapest tier that could do the task.**
2. **Builder fails twice on the same thing** (same test, same build error) -> hand it to the Architect with the error output. Don't let a cheap model loop; retries are where credits disappear.
3. **Anything touching security, auth, certificates, PHI handling, or data model** -> Architect plans it, Builder writes it, Reviewer checks it.
4. **Docs, READMEs, config tweaks, renames** -> Builder or Scout, never Architect.
5. **Before every commit** -> Reviewer does a quick pass on the diff only (not the whole repo).

---

## Do NOT use (you're paying extra for the same tier)

| Model | Why skip |
|---|---|
| `claude-opus-4-5` through `claude-opus-5` | Every one costs more than `claude-opus-5-5` ($5/$25 vs $4/$20, cache $0.50 vs $0.20) |
| `claude-sonnet-4`, `4-5`, `4-6` | Cost more than `claude-sonnet-5` ($3/$15 vs $2/$10) |
| `gpt-5.4-pro`, `gpt-5.5-pro` | $30/$180 and **cached reads also cost $30**, so agent sessions cost ~20x the Architect. One long session could eat your whole balance. |
| `claude-fable-5`, `claude-fable-5-1`, `gpt-6-astra` | $10/$50. Not needed for app code; the Architect tier covers it. |
| `gpt-5.5` | $5/$30, costs more than Opus 5.5 |
| `kimi-k3` | **Heads up:** $3/$15 is ~3x the cost of `kimi-k2.7-code` and the same price as older Sonnets. If K3 is your current execution model, trial K2.7 Code against it (see `model-trial.md`) before paying the premium. |

**Same-price twins:** in these families the newest version costs the same as the older ones, so default to newest and trial if unsure: GPT-5 / 5.1 / 5.1 Codex, GPT-5.2 / 5.3 Codex, GLM-5.1 / 5.2 / 5.3, MiniMax M2.5 / M2.7 / M3, Gemini 3.6 / 3.7 / 3.8 Flash.

---

## Free models: read before using on real code

`big-pickle`, the `-free` and `-contributor-free` models cost $0, but free tiers generally pay for themselves with your data (the "contributor" name suggests exactly that). Check each model's terms in the Zen console before using it.

- **OK for:** throwaway experiments, public code, learning.
- **Not for:** Beacon Relay, MsJaneHH, or anything with customer, hospital, or PHI-adjacent code or data.
- Free models also have their own usage cap separate from your Zen balance (that's the "Free usage exceeded" error).

---

## Honest limits of this guide

- **Prices are facts** (from your list). **The quality rankings are my defaults, not measurements.** Many of these models are newer than what I can verify.
- Before locking in a Builder or Scout, **run the 30-minute trial in `model-trial.md`** on your own repo. Your code is the only benchmark that matters.
- Update the table above with your trial results.

---

## Files in this folder

| File | Use |
|---|---|
| `README.md` | This guide |
| `opencode.json` | Drop-in OpenCode config: sets the Builder, Plan, and Scout/Reviewer/Architect subagents |
| `AGENTS-routing.md` | Paste into your repo's `AGENTS.md` so the main agent knows when to delegate |
| `model-trial.md` | How to test candidate models on your own code + results log |
| `pricing.csv` | Raw price list |
| `cost-calc.py` | Recomputes blended cost when prices change |
