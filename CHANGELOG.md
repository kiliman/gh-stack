# Changelog

## 0.9.0

> **Metadata is now a folder, not a file.** The single `.git/gh-stack-metadata.json` monolith is replaced by per-stack files under `.git/.gh-stack/` plus git-native branch config. This removes whole classes of bugs structurally — stacks vanishing on merge, `current_stack` drift, snapshot-array churn — rather than patching them one at a time. Run `gh-stack doctor` once to migrate.

### ⚡ Performance
- **`submit` is far faster on large stacks** ([#16](https://github.com/kiliman/gh-stack/issues/16)) — it no longer makes ~4 serial GitHub calls per branch just to re-push one. The stack visualization is now rendered entirely from local metadata (plus one cached repo-identity lookup for links), and `submit`:
  - **skips the PR-description PATCH** for any PR whose rendered block is unchanged (cached `vizHash`) — a re-submit touching one branch on a 12-PR stack does ~1 update, not 12;
  - **skips `gh pr edit --base`** when the parent hasn't changed since the last submit (cached `prBase`);
  - **caches PR titles** so the viz needs no per-PR fetch, backfilling only the first time, in parallel;
  - **parallelizes** the description updates that do remain.
- **Stack viz now numbers each branch** by its position in the stack (`1.`, `2.`, …) and **drops the review/CI emoji** (tracked out-of-band) — which is what makes the block fully local-renderable. `gh-stack update-prs` (now wired into the CLI) gains `--force` to rewrite all descriptions regardless of the cache.

### ✨ Features
- **`gh-stack doctor`** ([#14](https://github.com/kiliman/gh-stack/issues/14)) — migrates old (v2) metadata to the v3 layout, reconciles git branch config against the topology files, and flags stacks whose base stack appears already-merged into main. Idempotent; safe to run repeatedly.
- **v3 metadata layout** ([#14](https://github.com/kiliman/gh-stack/issues/14)) — metadata moves from one JSON blob to a folder under `.git/.gh-stack/`:
  - **Per-stack files** (`active/<stack>.json`, `archived/`, `deleted/`) — a bad write can't corrupt other stacks, and lifecycle transitions are atomic file moves. A stale stack file is **tombstoned** to `deleted/`, never just unlinked, so a stack can't silently vanish (the root cause of [#13](https://github.com/kiliman/gh-stack/issues/13)'s metadata wipe).
  - **Git-native branch membership** — each branch records its stack/parent/PR in git config (`branch.<name>.ghstack-stack` / `-parent` / `-pr`). `git branch -m` moves the config, `git branch -D` deletes it — rename/delete tracking for free, and the current stack is derivable from the branch you're on (no `current_stack` drift).
  - **Append-only snapshots** retained **per-stack** — a busy stack can no longer evict a dependent stack's only recorded tip (the staleness behind [#1](https://github.com/kiliman/gh-stack/issues/1)/[#13](https://github.com/kiliman/gh-stack/issues/13)).

### 🛡️ Guards
- Commands refuse to run on unmigrated v2 metadata and point you at `gh-stack doctor` (read-only `status` only nudges, so it stays pipeable).

### 🔁 Migration
- One-time `v2 → v3` via `gh-stack doctor`: fans the monolith out into per-stack files, backfills branch config, explodes `snapshots[]` into per-file records, and keeps a `.bak` of the old file. Fresh repos (`gh-stack init`) start on v3 directly.

## 0.8.0

> **Stacks can now be based on a branch, not just main.** New `gh-stack split` cuts a long chain into independent stacks; `gh-stack restack --onto` re-roots a stack onto a new base.

### ✨ Features
- **`gh-stack split <branch>`** ([#10](https://github.com/kiliman/gh-stack/issues/10)) — cut the current stack into two at `<branch>`. The cut branch and everything above it move into a new stack whose base is the cut branch's parent (which stays in the original stack). Purely a metadata operation — no git branches are moved or rebased, since stack membership is just bookkeeping on top of the real branch graph.
  - Use it when a long chain is in review and can't merge yet but new work is piling on top: split at the first "new work" branch so the original stays the review unit and the new stack rides on its tip.
  - `--name <name>` sets the new stack's name (defaults to the cut branch name).
- **Stacks now have an explicit `base`** — usually `main`, or a branch in another stack (for split stacks). `gh-stack log` renders the real base at the root, and the PR-description stack visualization (`📚 Stacked on`) shows the base branch (linked to its PR when it has one) instead of always showing `main`. Existing metadata is back-compatible: a missing `base` is treated as `main`.
- **`gh-stack restack --onto <ref>`** — re-root the current stack onto a new base ref. Use it to move a split stack off its parent-stack branch and onto `main` once that parent stack has merged; only the stack's own commits replay onto the new base (the now-merged parent commits are dropped via the existing snapshot/rebase machinery).

- **`submit` adopts new branches onto a non-main-based stack** ([#11](https://github.com/kiliman/gh-stack/issues/11)) — the chain-resolution walk now stops at the **nearest tracked ancestor** and adopts the untracked tail into that stack, instead of climbing all the way to `main` and bailing with "spans multiple stacks". This makes the split workflow's natural next step work: keep stacking new slices on a child stack and `gh-stack submit` just registers them (base preserved), no manual create+reset dance.

- **`restack` pushes every ref it touches and verifies they landed** ([#12](https://github.com/kiliman/gh-stack/issues/12)) — previously restack force-updated the children it rebased but left the **committed/base branch's ref** stale on origin (and could skip a never-pushed branch entirely), so PRs showed outdated heads. Now restack pushes **each** branch as it finishes it — including the branch you committed on, whether or not it needed rebasing — and ends with a verification pass that fails loudly, listing any ref that didn't reach origin, instead of falsely reporting success. Re-running restack reconciles any stale refs (idempotent).
- **All navigation/display commands are base-aware** — `down` now bottoms out at the stack's root (treating a non-main base as the boundary, never crossing into a parent stack) and moves as far as possible when a multi-step move overshoots, instead of refusing to move.

### 🛡️ Guards
- `sync` and `merge` refuse to run on a non-main-based stack and point you at `gh-stack restack` / `gh-stack restack --onto main` instead — syncing/merging only makes sense once a stack is rooted on the trunk.

## 0.7.1

### 🐛 Fixes
- **`delete` no longer hangs under `GH_STACK_YES=1`** ([#9](https://github.com/kiliman/gh-stack/issues/9)) — `delete` called `p.confirm` directly instead of the auto-yes-aware `confirmAction()`, so under an agent (no TTY) the confirmation prompt blocked forever and the process was killed mid-operation, leaving nothing done. It now respects `--yes`/`GH_STACK_YES=1` like every other destructive command.
- **`delete` actually deletes the git branch now** ([#9](https://github.com/kiliman/gh-stack/issues/9)) — previously `delete` only edited stack metadata; the local branch (and any pushed remote branch) survived and had to be cleaned up by hand. It now removes the stack entry **and** deletes the local branch, deletes the remote branch if it exists, and switches off the branch first if you're standing on it.
  - `--keep-branch` / `-k` — old behavior: remove from stack metadata only, leave git branches.
  - `--no-remote` — delete the local branch but keep the remote.

## 0.7.0

> **Quiet output for agents:** new `--plain` flag (auto-enabled under `GH_STACK_YES=1`) strips spinners, colors, and box-drawing chrome so tools like `tokf` can filter output cleanly.

### ✨ Features
- **`--plain` flag and `GH_STACK_PLAIN=1` env var** ([#8](https://github.com/kiliman/gh-stack/issues/8)) — drop the @clack `intro`/`outro` banners, spinners, and ANSI colors. Output collapses to plain `console.log` lines while preserving branch names, PR URLs, and errors.
- **`GH_STACK_YES=1` now implies `--plain`** — agents already set this; no reason to also burn tokens on spinner frames and color codes a human won't see.
- `--plain` alone keeps interactive prompts active (rare but supported); pair with `--yes` for fully non-interactive plain mode.

## 0.6.0

> **Minor version bump:** `submit` is now self-healing — it bootstraps a stack from bare local branches instead of failing.

### ✨ Features
- **`submit` self-heals when the current branch isn't tracked** ([#7](https://github.com/kiliman/gh-stack/issues/7)) — previously `submit` bailed with "Branch X not found in any stack", which was a constant dead end when a multi-step change left a chain of local branches that never got `init`'d. Now `submit`:
  - Auto-detects the branch chain from trunk → current (same ancestry walk `init` uses).
  - Creates a new stack (named after the current branch, auto-suffixed on clash) **or** reconciles untracked branches into an existing stack if part of the chain is already tracked.
  - Registers missing branches with correct parent links, then falls through to the normal push + PR-create flow.
  - Works with **no metadata file at all** — `submit` no longer requires `gh-stack init` to have been run first.
  - Aborts cleanly if run from `main`/`master`, or if the chain spans multiple existing stacks (ambiguous).
  - `--dry-run` previews the detected/created stack and push plan without writing metadata or pushing.

### ♻️ Internals
- Extracted `detectBranchChain` from `init` into `src/lib/chain.ts` and added `resolveOrCreateStack` (shared self-heal logic). `init` now imports the shared helper.
- Added `git.trunkBranch()` — resolves `main` / `master` (defaults to `main`).
- `submit` no longer calls `ensureMetadata` (which hard-failed on a missing file); it reads metadata or starts from an empty in-memory store.

### 🧪 Tests
- Added `chain.test.ts` (6 tests: full-chain detection, single-branch, mid-chain stop, new-stack creation, partial-stack reconciliation, name auto-suffix, multi-stack ambiguity) plus a `submit --dry-run` self-heal command test (157 tests total, up from 148).

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
