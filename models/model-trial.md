# Model Trial: 30 minutes, your own code

Prices are known. Quality on YOUR repo isn't. Test before you commit to a Builder or Scout.

## Setup
1. Make a branch: `git checkout -b trial/models`
2. Pick **3 real tasks** from your backlog, all about the same size:
   - **Task A (read):** "List every .md spec in this repo and summarize what each asks for in one line."
   - **Task B (build):** one small real feature or bug fix that has a test.
   - **Task C (debug):** break a test on purpose (or use a real failing one) and ask it to fix it.
3. Check your balance in the Zen console (or run `opencode stats`) before and after each run.

## Run
- For each candidate model: `/models` -> pick it -> run Task A, B, C in a **fresh session** (`/new`) each.
- After each task: `git diff` to judge the result, then `git checkout .` to reset.

**Suggested candidates**
- Scout (Task A only): `deepseek-v4-flash`, `gpt-6-luna`, `qwen3.8-flash`, `glm-5.3-flash`
- Builder (Tasks B + C): `kimi-k2.7-code`, `minimax-m3`, `deepseek-v4-pro`, `glm-5.3`, and whatever you use now (e.g. `kimi-k3`) as the baseline

## Score each run
- **Pass?** Did it actually work (tests green, summary accurate)?
- **Cost:** $ spent on that task
- **Retries:** how many times it looped or had to be corrected
- **Honesty:** did it claim success when it hadn't? (Automatic fail for Beacon Relay work.)

## Results log

| Date | Model | Task | Pass | Cost $ | Retries | Honest? | Notes |
|---|---|---|---|---|---|---|---|
| | | A | | | | | |
| | | B | | | | | |
| | | C | | | | | |

## Decide
- **Cheapest model that passes all three honestly wins the role.**
- A cheap model that needs 3 retries can cost more than a mid model that gets it right the first time. Compare **cost per passed task**, not price per token.
- Update the table in `README.md` and the model IDs in `opencode.json`.
