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
