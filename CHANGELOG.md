# Changelog

## 0.5.0

> **Minor version bump:** `merge --collapse` lets you collapse the stack into the base PR without merging to main.

### ✨ Features
- **`gh-stack merge --collapse`** — squash-merges PRn..PR2 into PR1 top-down (same as normal merge), then **stops at the base PR** instead of auto-merging it into main. The base PR is left open against `main` holding the cumulative diff so you can review the full set of changes on GitHub before shipping. Re-run `gh-stack merge` (without `--collapse`) to finish — the existing "already merged" skip logic walks past the intermediate PRs and only the base→main step runs.
- `--stop-at-base` is a hidden alias for `--collapse` for muscle memory.
- The summary prints the base PR URL (when `gh pr view` is available) so you can click straight through to review.
- After collapse completes, the working tree is checked out to the **base branch** (mirrors how normal `merge` lands you on `main`). If the local base branch is behind `origin/<base>` — which it always will be, since the squashed commits live on origin only — the summary calls that out so you know to review on GitHub rather than locally.

### 🧪 Tests
- Added 2 integration tests covering `merge --collapse --dry-run` and the `--stop-at-base` alias (148 tests total, up from 146).

## 0.4.1

### 🐛 Fixes
- **`restack` no longer picks a stale snapshot base from an earlier session** ([#5](https://github.com/kiliman/gh-stack/issues/5)) — when the snapshots list contained pre-rewrite entries from a previous restack cycle the child had already moved past, `findPreRewriteSha` would return one of those stale SHAs and `rebase --onto` would replay 10–20+ unrelated commits, conflicting on files outside the user's actual changes.

### ♻️ Internals
- `findPreRewriteSha(meta, parent, child?)` now accepts an optional child branch and validates that any candidate SHA is still an ancestor of the child. Stale snapshots whose recorded parent tip is no longer reachable from the child are skipped. Restack passes the child branch on every lookup.

### 🧪 Tests
- Added 3 integration tests covering the issue #5 repro and the missing-child fallback (146 tests total, up from 143).

## 0.4.0

> **Minor version bump:** restack base-detection mechanism replaced — temp tags are out, metadata snapshots are in.

### 🐛 Fixes
- **`restack` no longer replays parent's old commits onto children after `sync`** ([#2](https://github.com/kiliman/gh-stack/issues/2)) — the previous merge-base lookup fell back to original-`main` once the parent had been rebased, causing ghost-conflicts on the parent's own work. Restack now reads the orphaned pre-rewrite tip from a metadata snapshot, replaying only the child's unique commits.
- **`sync` and `restack` reject if a `git rebase` is already in progress** — clearer error than the previous half-broken behavior. Tells you to `git rebase --continue` or `--abort` before retrying.
- **Removed misleading "stale tags" prompt** — when sync called restack internally, the prompt fired on freshly-created tags and any choice produced wrong results.

### ♻️ Internals
- `findPreRewriteSha(meta, branch)` walks snapshots newest→oldest and returns the most recent recorded SHA that's no longer an ancestor of the branch's current tip.
- Tag-based base lookup (`stack-sync-base-*`) is gone. Restack still silently cleans up any leftover tags from older versions on entry.
- Snapshot is now the source of truth for cross-process rebase-base recovery.

### 🧪 Tests
- Added 5 integration tests covering `findPreRewriteSha` + the issue #2 repro end-to-end (143 tests total, up from 137).

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
