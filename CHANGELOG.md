# Changelog

## 0.17.0

### ✨ Features
- **`gh-stack add` — track an existing local branch in a stack without pushing or opening a PR.** Closes the catch-22 where a local WIP tip (created with `git checkout -b`, not yet submitted) couldn't be `sync`'d or `restack`'d because it wasn't in any stack — and the only way into a stack was `submit`, which publishes. `add` registers the current branch (or a named one) by walking local ancestry: if it sits on top of an existing stack it's adopted in with its parent auto-detected; otherwise a new stack is created from the chain. Network-free — nothing is pushed, no PR is opened (that's still `submit`'s job; `submit` continues to auto-track too). `sync`/`restack` now point an untracked branch at `gh-stack add` instead of dead-ending. (#25)

### 🐛 Fixes
- **`restack`/`sync` with `--yes` no longer publish an unsubmitted local-only branch.** Pushing is incidental to a restack — it's only there to keep **already-submitted** branches in sync after a rebase, not to publish work. But the push step force-created a remote for any touched branch, so `restack --yes` (or `submit --restack`) silently pushed a local WIP tip (no remote, no PR) to origin — surprising, since `submit` is the command that publishes. Now restack/sync **rebase a local-only branch but skip its push** (with a note pointing at `gh-stack submit`), and the post-restack verification no longer flags an intentionally-unpushed branch as an "un-pushed ref" (so a clean run still exits 0). Branches that already have a remote or a PR are still force-pushed to stay in sync, and a genuinely missing *published* ref is still reported (no #12 / #23 regression). (#24)
- **Stack/branch navigation no longer dumps a raw exception when a switch is refused.** Switching with uncommitted changes that the target branch would overwrite — e.g. `gh-stack co --stack`, or `up`/`down`/`top`/`bottom` — let git's failure bubble up as a Bun `ShellError` stack trace instead of a readable message. These commands now render a clean "local changes would be overwritten — commit or stash them first" message (listing the offending files) and exit 1. It does **not** pre-block on a merely-dirty tree: git carries non-conflicting WIP across a switch, and stack navigation should too, so we let git decide and only intervene on a real refusal. Also fixes a partial-state bug where `co --stack` persisted the new `current_stack` _before_ attempting the checkout, leaving metadata pointing at a stack you never switched to when the checkout was refused.

## 0.16.0

### ✨ Features
- **`gh-stack learn` — onboard a coding agent straight from the binary.** A hand-maintained skill drifts out of date with every release; this ships the skill _inside_ gh-stack so it's always in lockstep with the installed version. `gh-stack learn` prints the canonical, version-stamped skill (Markdown) to stdout — pipe it, read it, or redirect it. `gh-stack learn --skill` installs it as a skill file, picking the path from the target harness: Claude Code (`.claude/skills/using-gh-stack/SKILL.md`), Codex (`.codex/...`), or Cursor (`.cursor/...`). Defaults to the project root (resolved to the git worktree root, so it works from any subdirectory) and confirms before overwriting. `--harness <claude|codex|cursor>` skips the prompt, `--global` installs under `~/.<harness>/`, and `--force`/`--yes` overwrite unattended. Every copy is stamped with the version it came from and can be refreshed with `gh-stack learn --skill`. (#22 — thanks to Benjamin for the suggestion.)

### 🐛 Fixes
- **`restack`/`submit --restack` no longer reports a false "un-pushed refs" + non-zero exit after a successful force-push.** The post-restack sync verification (added in #12) read each branch's remote sha from the local remote-tracking ref (`rev-parse origin/<branch>`), which a force-push can leave stale even though the push landed — so a fully-successful run could end with `✗ … local <new> origin <old>`, `Restack finished with un-pushed refs`, and exit 1, breaking `set -e`/`GH_STACK_YES=1` automation. The verification now reads the **authoritative** remote state via a single `git ls-remote` (`git.remoteHeads`), so a landed push is recognized regardless of the tracking ref, while a genuinely un-pushed or missing ref is still reported and still exits non-zero (no #12 regression). (#23)

## 0.15.0

### ✨ Features
- **`submit --restack` — push and propagate in one command.** The everyday loop is: drop downstack, fix an issue, commit, `submit`, then `restack` to carry the fix up to the children. `submit --restack` chains them. It fits how the two commands already divide the stack: `submit` owns **downstack** (push + PRs from trunk up to the current branch), `restack` owns **upstack** (rebase the children onto the current branch), so together they sync the whole stack from wherever you're standing. Honors `--dry-run` (previews both phases) and `--yes`, and skips cleanly with a note when nothing sits above the current branch.

## 0.14.1

### 🐛 Fixes
- **`merge` no longer archives a stack whose base PR has merge conflicts.** The base PR → main step waited for the PR to become mergeable but **ignored the result** — so a base PR that conflicts with main (GitHub: "This branch has conflicts that must be resolved") would silently accept `--auto` (which then never fires), and the stack was archived as if shipped. `merge` now checks the base PR's mergeability **before** enabling auto-merge and distinguishes a real **conflict** (hard stop — leaves the stack intact, points you at `gh-stack sync` to resolve) from being merely **blocked on pending checks** (fine to hand off to auto-merge). A closed or never-settled base PR also stops instead of archiving. The intermediate cascade now fails fast on a definitive conflict instead of polling for ~60s first.

## 0.14.0

### ✨ Features
- **`merge --approved` — merge approved PRs bottom-up, keep stacking the rest.** For the "merge PRs as they get reviewed, leave the rest as PRs" workflow. Walks the stack from the bottom: for each approved PR it squash-merges to main as its own commit, then re-roots the next branch onto main — replaying **only that branch's own commits** (via `git rebase --onto`, never the just-squashed work), pushing it, and repointing its PR base to main. Stops at the first PR that isn't approved, leaving the unreviewed tail as a clean stack on main. A PR already merged outside gh-stack is detected and advanced past, not re-merged. Snapshots first, so `gh-stack undo` restores the prior state. (Thanks to Benjamin for the request, born of actual usage.)
- **`sync` now catches up when a bottom PR was merged outside gh-stack.** If the bottom PR(s) already landed on main via the GitHub web UI, the stack metadata still lists them — and a plain rebase onto main would replay their now-squashed commits and conflict. `sync` detects this and advances past the merged bottom(s), re-rooting the survivor onto main with `--onto` before the normal restack. Embodies the "do the right thing — detect drift and fix it, never wedge the stack" principle. (#20)

## 0.13.0

### ✨ Features
- **`submit -t` / `-b` / `--body-file` now update an existing PR, not just new ones** — set the title or body for the branch you're on and `submit` applies it in place if the PR already exists. The title keeps its `(N/M)` stack position; the body is replaced with the `📚 Stacked on` block **re-merged in**. This makes `submit` the one tool to update a PR's title/description without `gh pr edit --body` clobbering the stack visualization — handy for agents/scripts that regenerate descriptions. Scoped to the current branch, idempotent (a no-op re-run changes nothing), and the local cache stays in sync. Run it whenever you want.

## 0.12.0

### ✨ Features
- **Stack position in PR titles** — `submit` now suffixes each PR title with its stack position as `(N/M)` (e.g. `feat(paid-subs): tier detail page [BEE-20550] (2/4)`), so the order is visible in a bare "needs your review" list where only titles show — not just inside the description's viz block. Parentheses (not brackets) avoid colliding with `[BEE-1234]` ticket tags. It's **self-healing and idempotent**: adding or reordering a branch renumbers the whole stack on the next `submit`, a no-op re-submit makes zero edits, and only the `(N/M)` part is managed — your title text and ticket tags are preserved. Single-PR stacks get no suffix. Existing stacks are backfilled automatically (a one-time title fetch), and `gh-stack update-prs` reconciles titles too. (Thanks to Merritt for the request.)
- Since the position now lives in the title, the `### 📚 Stacked on` description block **drops its redundant `1.`/`2.` prefix** — the tree just shows the (now-numbered) titles. Local views (`log`, `ls`, `stacks`) keep their numbering.

## 0.11.0

### 🐛 Fixes
- **The current stack is now derived from the branch you're on — never a stale stored hint — and self-heals on every command.** The invariant: a stack is "current" only while you're on a branch that belongs to it; stand on `main` or any branch in no stack and there is **no** current stack. This is now enforced in one place — `readMetadata` resolves `current_stack` on every read (branch git config → scan active stacks → else none) and rewrites the on-disk `current` pointer when it drifts. A stale hint left by a prior session, a `merge`, or a plain `git checkout` clears itself on the next command rather than resurfacing a stack you'd already left. Knock-on changes:
  - **`merge`** no longer hands "current" to an arbitrary leftover stack (`remaining[0]`) after archiving the merged one — you're on `main` afterward, so there's simply no current stack.
  - **`log` / `list` / `stacks --json`** stop falling back to the stored hint; off-stack they report no current stack instead of rendering a previously-used one.
  - **`split <branch>` / `delete <branch>`** now resolve their target stack from the **branch argument** (which names its stack unambiguously) rather than from "current," so they operate on the right stack from anywhere — not only while standing on it. Interactive mode (no branch given) still uses the current stack.

### ✨ Features
- **The current stack now follows the parent chain — a new branch built on top of a stack belongs to that stack.** Current-stack resolution gains an ancestry step: branch's own membership → scan active stacks → **nearest tracked ancestor's stack** → none. So a fresh, unsubmitted branch stacked on top of an existing stack is understood as part of it (you're extending it, not seeding a new one), and `stacks --json` reports that stack as `current_stack`. The walk probes only tracked branches, so the common path (you're on a tracked branch) stays instant.
- **`log` (the default command) now points you at the next step when the branch isn't tracked yet.** Instead of a dead-end "not in any stack" message (which also suggested a nonexistent `gh-stack add`), it inspects the branch's local ancestry — the same chain `submit` self-heals — and recommends the lowest-friction action:
  - **sits on top of an existing stack** → draws the chain (marking which branches are already in the stack vs. new) and tells you `gh-stack submit` will **add** the branch to that stack;
  - **stacked on untracked branches only** → `gh-stack submit` will **create** the stack and open PRs for the whole chain;
  - **based directly on trunk** → `gh-stack submit` pushes it and opens a PR (starting the stack);
  - **on trunk** → `gh-stack init`.

## 0.10.0

### 🐛 Fixes
- **`merge` no longer aborts on GitHub's misleading "Head branch is out of date"** ([#19](https://github.com/kiliman/gh-stack/issues/19)) — in a top-down cascade, squash-merging a child moves the next parent PR's branch server-side, but GitHub **intermittently fails to advance that PR's recorded head pointer** (`headRefOid`). Every status read — `mergeable`, `mergeStateStatus`, even a base…head compare — is then computed against the *stale* head and reports `CLEAN`/`behind_by: 0`, yet `mergePullRequest` validates against the *live* ref and rejects `Head branch is out of date` — and stays stuck that way, not just for a few seconds. `merge` now detects the mismatch (PR head vs. live branch ref) and forces GitHub to re-read the branch via a close→reopen nudge, then waits for the head to sync and retries. The brief async-recompute window (`mergeStateStatus: UNKNOWN`) is handled separately with backoff (2s → 4s → 8s). The same healing covers the final base→main hop, and enabling auto-merge there no longer reports false success when GitHub rejects it. Only a state that settles *genuinely* non-mergeable (real conflict / failing required check) — or exhausted retries — is surfaced as a hard failure, so the "re-run to continue" hint stops crying wolf.

### ✨ Features
- **`gh-stack rename [<old>] <new>` + auto-reconcile on `git branch -m`** ([#18](https://github.com/kiliman/gh-stack/issues/18)) — first-class branch renaming for the `feature-wip` → `feature-BEE-1234` flow, with **no manual metadata editing**. Each branch now carries a stable id (`branch.<name>.ghstack-id`, stamped on first write). Because `git branch -m` moves a branch's whole config section but the topology JSON is keyed by name, gh-stack matches the moved config back to its stale JSON entry by id (PR number as fallback), re-keys it, and re-points any children — on the *next command*, whether you used `gh-stack rename` or a raw `git branch -m`. Covers tip, mid-stack, pre-submit (no PR yet), and split-stack-base renames.
- **`gh-stack stacks [--json]`** — a read-only, network-free dump of all stacks and their topology (ordered branches, PR numbers, base). It exists so external tooling can consume `--json` as a stable interface instead of reaching into the `.git/.gh-stack/` store and parsing the on-disk format directly. Shape: `{ current_stack, current_branch, stacks: [{ name, description, base, is_current, branches: [{ branch, parent, pr, description }] }] }`. `--current` narrows to the stack containing the checked-out branch. Distinct from `status --json`, which hits the network for live PR/CI state.

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
