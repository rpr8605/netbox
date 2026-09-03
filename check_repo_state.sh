#!/usr/bin/env bash
# check_repo_state.sh — read-only snapshot of the repo before deciding anything about a push.
# No AI, no network calls beyond what git itself does locally. Safe to run any time.
set -euo pipefail

echo "=== Location ==="
pwd
git rev-parse --show-toplevel 2>/dev/null || { echo "Not inside a git repo — cd into the repo first."; exit 1; }
echo

echo "=== Current branch ==="
git branch --show-current
echo

echo "=== Working tree status ==="
git status
echo

echo "=== Staged changes (stat) ==="
git diff --stat --cached || echo "(nothing staged)"
echo

echo "=== Unstaged changes (stat) ==="
git diff --stat || echo "(no unstaged changes)"
echo

echo "=== Untracked files ==="
git ls-files --others --exclude-standard
echo

echo "=== Last 10 commits ==="
git log --oneline -10
echo

echo "=== Ahead/behind remote ==="
git status -sb | head -1
