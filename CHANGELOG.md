# Changelog

## 0.3.1

### 🐛 Fixes
- **`merge` skips already-merged PRs** — safe to re-run after partial failure. Plan shows "(already merged)" for completed PRs.
- **`merge` waits for GitHub to process** between merges — after squash-merging PR3 into PR2, waits for PR2 to become mergeable before attempting the next merge (retries up to 60s).

### ✨ Features
- Added `getPrMergeState()` helper to check PR state/mergeable status

## 0.3.0

> **Minor version bump:** `merge` command completely rewritten (breaking behavior change).

### ♻️ Rewritten `merge` — all merges via GitHub
- **`merge` now does everything through GitHub** instead of locally — PRs show as "Merged" (not "Closed"), Linear tickets auto-close, GitHub Actions fire, review history is preserved
- Flow: squash-merge top-down via `gh pr merge --squash`, then enable auto-merge for base PR into main
- No more local squash-merge, rebase, or manual push steps
- Added `--delete-branch` / `-d` flag to delete remote branches after merging
- Removed `ensureCleanWorkingTree` requirement (no local git operations needed)

## 0.2.3

### ✨ Features
- **`merge` now pushes and enables GitHub auto-merge** (v0.2.3 did this locally; v0.3.0 does it entirely via GitHub)

## 0.2.2

### ✨ Features
- **`submit --title` / `--body` / `--body-file`** — provide PR details directly instead of auto-generating from branch names. Useful for agents/CI.

## 0.2.1

### ⚡ Performance
- **`submit` skips pushing branches already up-to-date with origin** — compares local vs remote SHA before pushing, avoiding unnecessary pre-push hook runs

### 🐛 Fixes
- `--yes` flag now implies `--no-edit` in submit (auto-generates PR titles)
- Refresh git index before clean-tree check (fixes false "dirty tree" errors)
- Filter already-merged branches from init chain detection

## 0.2.0 — Graphite Parity Phase 1

> **Minor version bump:** New commands, renamed commands (breaking), reworked `init` behavior.

### ✨ New Commands
- **`submit`** — Push branches and create/update PRs with stack visualization (downstack only, idempotent)
- **`create <branch>`** — Create a new git branch and add to the stack in one step
- **`up [steps]`** / **`down [steps]`** — Navigate stack by steps (upstack/downstack)
- **`top`** / **`bottom`** — Jump to the tip or base of the stack

### ♻️ Renamed Commands (Breaking)
- `show` → **`log`** (still the default command)
- `add` → **`create`** (complete rewrite)
- `remove` → **`delete`**
- `switch` → **`checkout`** (alias: `co`)
- `update-prs` absorbed into **`submit`**

### ✨ Reworked `init`
- Smart defaults: stack name = branch name, parent = main, auto-detect PR
- Zero interactive prompts in the common case
- Flags for overrides: `--name`, `--description`, `--parent`

### 📝 Help Improvements
- Added TERMS section (trunk, stack, upstack, downstack)
- Grouped commands: CORE WORKFLOW, STACK NAVIGATION, STACK MANAGEMENT, INFO & MAINTENANCE

## 0.1.2

- CLI entrypoint integration tests
- Improved CLI parsing and dry-run coverage

## 0.1.1

- Fix gh-stack docs and regression coverage
- Add oxlint/oxfmt configs

## 0.1.0

- Initial release: show, init, add, remove, switch, list, restack, sync, update-prs, status, merge, undo, archive
