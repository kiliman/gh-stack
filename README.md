# gh-stack

Stacked PR manager for squash-merge workflows.

gh-stack manages chains of dependent pull requests in repositories that squash-merge, where tools like [Graphite](https://graphite.dev/) break down. It works directly against GitHub through `git` and the `gh` CLI, with no backend. Stack metadata lives locally under `.git/.gh-stack/` and is never committed.

## Install

```bash
bun install -g gh-stack
```

Or build from source:

```bash
git clone https://github.com/iamclaudia-ai/gh-stack.git && cd gh-stack
bun install
bun run build
ln -sf "$(pwd)/dist/gh-stack" ~/.local/bin/gh-stack
```

### Prerequisites

- [Bun](https://bun.sh) (the npm package runs under Bun)
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated
- Git 2.30+

## Terms

| Term          | Definition                                            |
| ------------- | ----------------------------------------------------- |
| **trunk**     | Base branch of the repository (usually `main`)        |
| **stack**     | A chain of dependent branches                         |
| **upstack**   | Branches that depend on the current branch (children) |
| **downstack** | Branches the current branch depends on (ancestors)    |

## Quick Start

```bash
# Already have branches main → feat-1 → feat-2? Init from the top of the chain:
git checkout feat-2
gh-stack init                    # detects the chain and offers to track all of it

# Or start fresh from one branch:
git checkout feat-1
gh-stack init
gh-stack create feat-2           # branch off the current branch and track it

# Push the stack and open PRs (you don't need init first: submit tracks the chain)
gh-stack submit

# Look around
gh-stack log                     # tree view (the default command)
gh-stack ls                      # numbered list
gh-stack status                  # live PR dashboard: reviews, CI, mergeability

# Move around
gh-stack up / down / top / bottom
gh-stack checkout 2              # jump to branch #2 from `ls`

# Fixed something low in the stack? Push it and carry it up to the children
gh-stack submit --restack

# main moved: rebase the stack onto it
gh-stack sync

# Land it
gh-stack merge                   # the whole stack → one squash commit on main
gh-stack merge --approved        # only the approved run, from the bottom up
gh-stack merge --base            # just the bottom PR; run again for the next
```

## Commands

`gh-stack <command> --help` (or `gh-stack help <command>`) shows a command's options and runs nothing.

### Core Workflow

#### `init`

```
gh-stack init [--name <name>] [--description <desc>] [--parent <branch>]
```

Creates a stack from the current branch. If the branch sits on a chain of local branches (main → feat-1 → feat-2), init detects the chain and asks whether to add all of it (with `--yes` it does). Run it from the top of the chain so every branch is found.

- `--name <name>`: stack name (default: the current branch)
- `--description <desc>`: stack description
- `--parent <branch>`: trunk branch (default: `main`)

#### `create`

```
gh-stack create <branch-name> [--description <desc>]
```

Creates a branch off the current one and adds it to the current stack. The current branch must already be tracked.

- `--description <desc>`: description for the branch

#### `add`

```
gh-stack add [branch] [--parent <branch>]
```

Tracks an existing local branch (default: the current one) without pushing or opening a PR, so `sync`, `restack` and navigation know about it. If the branch sits on top of a stack, it joins that stack; otherwise a new stack is created from its chain. A PR that gh-stack recorded for the branch in another worktree is kept.

- `--parent <branch>`: stack it directly on `<branch>`, which it must already be based on. Needed for a branch with no commits of its own yet: it sits at its parent's tip, so ancestry can't tell which is the parent. Also re-homes an already-tracked branch that is alone in its stack and has no PR.

#### `submit`

```
gh-stack submit [-d|--draft|--no-draft] [-n|--no-edit] [-t|--title <t>] [-b|--body <b>]
                [--body-file <f>] [--existing] [--restack] [--json] [--dry-run]
```

Pushes every branch from trunk up to the current one, opens PRs for branches that don't have one, numbers each PR title with its stack position `(N/M)`, and refreshes the stack section in every PR description. Safe to run repeatedly. If the current branch isn't tracked yet, submit detects its chain and tracks it first.

Branches without a PR at the top of the stack are local work: they aren't counted in `(N/M)` or shown in the stack section, so tracking a new branch on top doesn't renumber anything.

- `-d, --draft` / `--no-draft`: open new PRs as drafts, or ready for review. Only affects PRs created by this run. The default comes from `[submit] draft` (see [Configuration](#configuration)).
- `-n, --no-edit`: don't prompt for titles; generate them from branch names (`--yes` does this too unless `--title` is given)
- `-t, --title <title>` / `-b, --body <body>`: title or body for the current branch's PR. On an existing PR they update it in place, keeping the `(N/M)` position and the stack section, which `gh pr edit` would wipe.
- `--body-file <f>`: read the body from a file
- `--existing`: push only the branches that already have PRs, across the whole stack, and open no new PR. Bases, titles and stack sections are still refreshed. Use it to publish after `sync --no-push` or `restack --no-push`. It refuses if a branch without a PR sits under one that has a PR.
- `--restack`: afterwards, restack the branches above the current one onto it. submit covers downstack, restack covers upstack, so this updates the whole stack from wherever you stand.
- `--json`: print one JSON document on stdout on every exit (logs go to stderr, uncolored). Implies `--no-edit`.
- `--dry-run`: show what would happen

`--existing` and `--json` can't be combined with `--restack`; `--json` can't be combined with `--dry-run`.

The `--json` document:

```
{ "stack": "...", "current_branch": "...",
  "branches": [{ "branch", "parent", "pr", "url", "title", "action", "pushed", "draft", "error"? }],
  "error": null | { "message": "...", "hint"?: [...], "log"?: "..." } }
```

`branches` is the submit scope in stack order. `action` is `created`, `updated`, `unchanged`, `skipped` (no PR under `--existing`) or `failed`. `draft` is true/false for PRs created this run, otherwise null. The top-level `error` is set when the run stopped early; for a refused push, `log` is the path of git's full output. The exit code is 1 if `error` is set or any branch failed.

#### `log`

```
gh-stack log
```

Shows the current stack as a tree with branch numbers, PRs and descriptions. This is the default command. On an untracked branch it says what to run next (`submit` or `init`).

### Stack Navigation

```
gh-stack checkout [<number>]   Switch to a branch by its number from `ls`; no number opens a picker (alias: co)
gh-stack checkout --stack      Switch between stacks (interactive)
gh-stack up [steps]            Move to a child branch; asks when there are several
gh-stack down [steps]          Move to the parent branch
gh-stack top                   Jump to the tip of the stack; asks when there are several
gh-stack bottom                Jump to the first branch above trunk
gh-stack ls                    List the stack's branches with their numbers (alias: list)
gh-stack stacks [--current] [--json]
                               List all stacks and their topology
```

`stacks` is read-only and makes no network calls. Its `--json` output is the stable interface for scripts, rather than reading `.git/.gh-stack/`:

```
{ "current_stack", "current_branch",
  "stacks": [{ "name", "description", "base", "is_current",
               "branches": [{ "branch", "parent", "pr", "description" }] }] }
```

### Stack Management

#### `restack`

```
gh-stack restack [--resume | --fresh] [--no-push | --push] [--overwrite-remote] [--dry-run] [-v|--verbose]
gh-stack restack --onto <ref>
```

Rebases the current branch and every branch above it onto their parents, then force-pushes them. It finds the right rebase base even after a parent was rewritten, by gh-stack or by plain git (see [Rebasing After a Parent Changes](#rebasing-after-a-parent-changes)). Interactive runs ask before rebasing and pushing; `--yes` doesn't. Refuses on a dirty working tree. Alias: `rebase`.

- `--no-push`: rebase locally only. Also `GH_STACK_NO_PUSH=1` or `[restack] push = false`. Wins over `--yes`.
- `--push`: push even when the env var or config says not to
- `--resume`: continue an interrupted run (after a conflict, a failed push or a kill). It keeps that run's push decision unless you pass `--push` or `--no-push`.
- `--fresh`: discard an interrupted run and start over
- `--overwrite-remote`: rewrite branches even though origin has commits they lack (see below), dropping those commits
- `--onto <ref>`: re-root the stack onto a new base, replaying only the stack's own commits. Use it to move a split stack onto `main` once the stack it was split from has merged.
- `--dry-run`: show what would happen
- `-v, --verbose`: show where each rebase base came from

On a conflict, resolve it, run `git rebase --continue`, then `gh-stack restack --resume`.

- **Interrupted runs.** restack and sync save their progress after every rebase and push. A bare `restack` or `sync` with a run pending asks to finish it first (with `--yes` it does), says when it has, then does its own work. `git rebase --abort` ends the rebase, not the run; use `--fresh` to abandon it. `merge` and `join` refuse to start while a run is pending.
- **Commits only on origin.** Before rewriting anything, restack checks each branch's copy on origin. If it has commits the local branch never had (the squash commit `merge --collapse` adds on GitHub, say), the run stops and names them so you can pull or cherry-pick them first. Interactive runs ask; `--yes` stops.
- **Safe pushes.** Pushes use `--force-with-lease --force-if-includes`. A branch whose parent isn't on origin (its push failed or was declined) is held back, since its PR would be diffed against the parent's old history. The run exits 1, and `--resume` retries the pushes, parents first.

#### `sync`

```
gh-stack sync [--no-push | --push] [--resume | --fresh] [--overwrite-remote] [--dry-run]
```

Fetches main, rebases the stack's bottom branch onto it, pushes, and restacks every branch above, all in one resumable run. Bottom PRs that already merged (on GitHub, or by `merge`) are dropped and the branches on them re-rooted onto main, so only their own commits replay. When a merged branch had several children, each becomes its own stack. Refuses on a dirty working tree.

- `--no-push` / `--push`: as for restack. `--no-push` also leaves PR bases alone; the next `submit` pushes and retargets together.
- `--resume`: same as `restack --resume`
- `--fresh`, `--overwrite-remote`, `--dry-run`: as for restack

#### `merge`

```
gh-stack merge [--collapse] [-d|--delete-branch] [--skip-collapse-check] [--dry-run]
gh-stack merge --approved [--collapse] [-d|--delete-branch] [--dry-run]
gh-stack merge --base [--no-push | --push] [--overwrite-remote] [-d|--delete-branch] [--dry-run]
```

Lands PRs by merging them on GitHub, so they show as "Merged", linked tickets close and Actions fire as usual. Already-merged PRs are skipped, so it's safe to re-run. Takes a snapshot first.

- **Default (top-down collapse).** Squash-merges the stack from the top down (PR3 into PR2, PR2 into PR1), then hands the base PR to GitHub auto-merge, so the whole stack lands on main as one squash commit once checks pass. The stack is archived. If the base PR conflicts with main, merge stops and leaves the stack intact: run `gh-stack sync`, then `merge` again.
- **`--approved`.** The same collapse, but only up to the highest PR in an unbroken approved run from the bottom (an unapproved PR4 caps it at PR3 even if PR5 is approved). The rest stays stacked; after the base PR lands, `gh-stack sync` re-roots it onto main.
- **`--base`.** Squash-merges only the bottom PR into main, then re-roots the next branch onto main and restacks above it. One PR per run. If the re-root stops on a conflict, resolve it, `git rebase --continue`, and re-run `merge --base`. `--no-push` (or `GH_STACK_NO_PUSH=1`) still merges the PR but keeps the re-root local until `submit`; the `[restack] push` config doesn't apply here. `--overwrite-remote` is passed on to that restack.
- `--collapse`: with the default or `--approved`, stop after collapsing into the base PR so you can review the combined diff on GitHub; re-run `merge` to finish. Alias: `--stop-at-base`.
- `-d, --delete-branch`: delete the remote branches after merging
- `--skip-collapse-check`: skip the check below
- `--dry-run`: show what would happen

Before the base PR goes to main, merge checks that every PR collapsed into it is still in the base branch, so a base rewritten without them can't silently drop their changes. A PR proven missing stops the merge (exit 2) with how to restore it. One it can't verify (a GitHub or fetch failure, a shallow clone) is reported as unverified, not missing: interactive runs ask, `--yes` stops (exit 2).

Only `--approved` reads approvals. Otherwise, approval is up to GitHub's branch protection.

#### `split`

```
gh-stack split [<branch>] [--name <name>]
```

Cuts a stack in two at `<branch>`: it and every branch above it become a new stack based on its parent. Metadata only, nothing is rebased. Use it when a long stack is stuck in review and new work piles on top. Once the original stack merges, run `gh-stack restack --onto main` in the new one. With no branch it opens a picker; you can't split at the root.

- `--name <name>`: name of the new stack (default: the cut branch)

#### `join`

```
gh-stack join <branch> [--above <branch>] [--no-push | --push] [--dry-run] [-v|--verbose]
```

Splices an existing branch, usually one with its own PR, into the current stack: as the new bottom, or between `--above <branch>` and its children. The incoming branch is first rebased onto its new parent (only its own commits), then the branches above it are restacked onto it and pushed, and the PR bases are retargeted on GitHub. Its open PR is adopted. A stack named after its old bottom is renamed after the new one.

The branch must exist locally and, unless `--no-push`, on origin. A branch alone in a one-branch stack is absorbed; one in a larger stack is refused. Refuses on a dirty tree. Takes a snapshot first.

- `--above <branch>`: insert between `<branch>` and its children; this also picks the stack, so it works from anywhere (`--above main` is the default)
- `--dry-run`: show the resulting stack and each affected PR's projected commits and files. Changes nothing.
- `--no-push` / `--push`: as for restack (`GH_STACK_NO_PUSH` and `[restack] push` apply)
- `-v, --verbose`: show rebase-boundary diagnostics

A conflict rebasing the incoming branch leaves the stack untouched: resolve, `git rebase --continue`, and re-run the same join (or `git rebase --abort`). A conflict in the branches above resumes like restack.

#### `rename`

```
gh-stack rename [<old-name>] <new-name>
```

Renames a tracked branch (`git branch -m`) and updates the stack so it stays tracked, children included. With one argument it renames the current branch. A plain `git branch -m` heals on the next gh-stack command too. A branch with a PR is renamed locally only; the PR keeps tracking the old remote branch.

#### `delete`

```
gh-stack delete [<branch>] [-k|--keep-branch] [--no-remote]
```

Removes a branch from its stack, re-parents its children, and deletes the local branch and its remote copy. Deleting a root with several children makes each child its own stack; deleting the last branch archives the stack. With no branch it opens a picker.

- `-k, --keep-branch`: remove it from the stack only, like `untrack`
- `--no-remote`: delete the local branch but keep the remote one

#### `untrack`

```
gh-stack untrack [<branch>]
```

Removes a branch from its stack's metadata and nothing else: the local branch, its copy on origin and its PR stay. Children are re-parented. It keeps its PR number, so `gh-stack add <branch>` puts it back.

### Info & Maintenance

#### `status`

```
gh-stack status [--current] [--json]
```

Live PR dashboard across stacks: review state, CI and merge readiness. Unlike `stacks`, it queries GitHub.

- `--current`: only the current stack (or the current PR if it's standalone)
- `--json`: JSON on stdout; progress goes to stderr

#### `update-prs`

```
gh-stack update-prs [<branch>] [--stack <name>] [--force]
```

Restores the stack section in every PR description of a stack, including one removed by an outside edit. A tracked branch whose PR was opened outside gh-stack (`gh pr create`) is found and adopted. The stack is the one named by `--stack`, else the one holding `<branch>`, else the current branch's, so nothing has to be checked out.

- `--stack <name>`: the stack to update
- `--force`: rewrite every PR's section, even ones already current

#### `undo`

```
gh-stack undo
```

Moves the local branches back to the last snapshot, taken before every restack, sync, merge, join and delete. Only local branch tips are restored: metadata, origin, and PRs and their bases are left as they are, so re-push afterwards if needed. Discards an interrupted run on that stack.

#### `archive`

```
gh-stack archive <name>...
gh-stack archive [--list]
gh-stack archive --restore <name>
```

Archives stacks, lists archived ones (the default), or restores one. Metadata only and reversible. Use it for a stack that landed without `gh-stack merge`. `merge`, `delete` and `doctor` archive stacks themselves when they land or empty them.

#### `config`

```
gh-stack config [--json]
```

Shows every configurable default, its resolved value, where it came from, and the config file paths. Works outside a repo (user and env layers only).

#### `doctor`

```
gh-stack doctor
```

Migrates v2 metadata, splits stacks left with several root branches, archives empty stacks, reconciles git branch config with the stack files, and flags stacks whose base looks already merged into main. Safe to run repeatedly.

#### `learn`

```
gh-stack learn [--skill] [--harness <name>] [-g|--global] [--force]
```

Prints the agent skill for gh-stack (Markdown, matching the installed version) to stdout.

- `--skill`: install it as a skill file instead, at `<root>/.<harness>/skills/using-gh-stack/SKILL.md`
- `--harness <name>`: `claude`, `codex`, `cursor`, `all`, or a comma list; skips the prompt
- `-g, --global`: install under your home directory instead of the project root
- `--force`: overwrite an existing skill file without asking, and write through a symlinked skill directory or `SKILL.md` (otherwise refused, even with `--yes`)

## Global Options

```
--yes, -y      Skip all confirmations (for agents and CI); also turns on --plain
--plain        Plain output: no spinners, colors or boxes
--help         List the commands; with a command, show its help and run nothing
--version, -V  Show the version
```

A command that needs to prompt without a TTY exits 1 with the prompt it would have shown; use `--yes` or `GH_STACK_YES=1` there.

## Environment Variables

```
GH_STACK_YES=1       Same as --yes
GH_STACK_PLAIN=1     Same as --plain
GH_STACK_NO_COLOR=1  Disable colors
GH_STACK_NO_PUSH=1   restack, sync, join and merge --base don't push (0 = push); wins over --yes
GH_STACK_DRAFT=1     submit opens new PRs as drafts (0 = ready)
```

Each accepts `1/0`, `true/false` or `yes/no`; anything else is an error.

## Configuration

Flags that encode a repo's conventions can have defaults:

```toml
# .gh-stack.toml at the repo root (commit it), or
# ~/.config/gh-stack/config.toml for personal defaults (honors XDG_CONFIG_HOME)
[submit]
draft = true # new PRs open as drafts; --no-draft overrides

[restack]
push = false # restack, sync and join stay local; --push overrides
```

| Key              | Flags                    | Env                           | Built-in |
| ---------------- | ------------------------ | ----------------------------- | -------- |
| `[submit] draft` | `--draft` / `--no-draft` | `GH_STACK_DRAFT`              | `false`  |
| `[restack] push` | `--push` / `--no-push`   | `GH_STACK_NO_PUSH` (inverted) | `true`   |

Precedence, highest first: CLI flag > env var > repo config > user config > built-in default. `gh-stack config` shows each value and its source, and a command says so when a default rather than a flag decides.

`merge` and `submit --restack` always push what they restack: publishing is their job. Only `merge --base` can be kept local, with `--no-push` or `GH_STACK_NO_PUSH=1`.

Unknown keys print a warning. Malformed TOML, a non-boolean value or a bad env value is an error, reported before anything changes. `--yes` can't be set in a config file.

## How It Works

### Finding the Chain

`init`, `add` and `submit` find a branch's chain by walking git ancestry: every local branch whose tip is an ancestor of it and not already on trunk (local `main` or `origin/main`). Two branches at the same commit can't be parent and child, so only one goes in the chain and the others are named in a warning.

### Rebasing After a Parent Changes

After a parent branch is rewritten (rebased onto a new main, say), `git merge-base` with its child falls back to the old main, and rebasing from there would replay the parent's old commits onto the child. gh-stack instead records every branch's tip before each destructive operation, and restacks a child from its parent's *old* tip: `git rebase --onto <new-parent-tip> <old-parent-tip> <child>`, which replays only the child's own commits. For a parent rewritten with plain git, which gh-stack never saw, it finds the old tip in the parent's reflog. When no safe base can be found, restack refuses and prints a manual `git rebase --onto` rather than guessing.

The same snapshots power `gh-stack undo`.

### Commits Main Already Has

A branch sometimes carries a copy of another PR's commit (a shared fix cherry-picked where it was needed). Once that PR squash-merges, rebasing replays the copy onto a main that already has a newer version of it and stops on a conflict. When a rebase stops, gh-stack skips the commit only if a commit the target gained touched every file it touches and at least 80% of the lines it adds are already there. It prints what it skipped and why. Any other conflict stops for you to resolve.

### Stack Position in PR Titles

`submit` suffixes each PR title with its position, so the order shows even in a review list where only titles appear:

```
feat(paid-subs): tiers overview list [BEE-20531] (1/4)
feat(paid-subs): tier detail page [BEE-20550] (2/4)
feat(paid-subs): tier create wizard [BEE-20579] (3/4)
feat(paid-subs): advanced settings step [BEE-20587] (4/4)
```

Parentheses avoid colliding with `[TICKET-123]` tags. Re-running `submit` after adding or reordering branches renumbers the stack; the rest of the title is yours. Single-PR stacks get no suffix, and `merge` leaves the suffix out of squash commit subjects.

### Stack Visualization

`submit` also keeps a stack section in every PR description:

```
### 📚 Stacked on
⚫ main
┃
┣━ #123 feat: backend models (1/2)
┃
┗━ #124 feat: frontend UI (2/2) 👈
```

Every PR above the bottom one also gets a warning, because its base on GitHub is the branch below it: merging it there squashes it into that branch and closes it, and nothing reaches `main`.

> [!WARNING]
> **Don't merge this PR on GitHub.** Its base is #123's branch, not `main`: merging it here squashes it into that branch and closes it for good, with nothing reaching `main`. Merge #123 first, or land the stack with `gh-stack merge`.

The section is built from local metadata, and `submit` only rewrites descriptions whose section changed. Use `gh-stack update-prs` to repair one.

### Metadata

Metadata lives under `.git/.gh-stack/` and is never committed. A linked worktree keeps its own under `.git/worktrees/<name>/.gh-stack/`, so each worktree has its own stacks.

```
.git/.gh-stack/
  active/<stack>.json          live stacks: branches, parents, PR numbers, base
  archived/<stack>.json        landed or archived stacks
  deleted/<stack>.json         tombstones
  snapshots/                   branch tips before each destructive operation
  restack-state.json           the last restack/sync/join run, for --resume
  push-failure.log             git's full output from the last refused push
  lock-waits.log               every wait on a git lock (see below)
```

Each branch's stack, parent, PR and a stable id are also kept in git config (`branch.<name>.ghstack-*`), so a plain `git branch -m` is healed on the next command. `gh-stack doctor` reconciles the two if they drift. For scripts, read `gh-stack stacks --json` rather than these files.

Repos from before this layout have a single `.git/gh-stack-metadata.json`; commands refuse to run until `gh-stack doctor` migrates it.

### Worktrees

Git won't rebase a branch that another worktree has checked out, so `restack`, `sync`, `merge --base` and `join` rebase such a branch inside its own worktree. That worktree must be clean: the command checks first and stops before changing anything if one has uncommitted changes, a rebase in progress, or a missing folder, and prints the fix. A conflict there is resolved in that worktree, then resumed from the one that ran the command.

### Busy Repositories

A background `git status` (an editor, a watcher, another agent) briefly holds `index.lock`, and git fails at once instead of waiting. gh-stack retries every locking git step for about 5 seconds. If the lock is still held, it exits 1 naming the process that holds it (or saying it was left by a crashed git and can be removed). Nothing changed, so run the command again (or `restack --resume`). Each wait is logged to `lock-waits.log`.

## Agent/CI Usage

The quickest way to teach an agent gh-stack is `gh-stack learn`, which prints a skill matching the installed version:

```bash
gh-stack learn                              # print the skill
gh-stack learn --skill --harness claude     # install it for Claude Code
gh-stack learn --skill -g --harness all     # every harness, in your home dir
```

```bash
export GH_STACK_YES=1                       # no prompts, plain output

gh-stack submit -t "Title [WEB-1234]" -b "Description"
gh-stack submit -n                          # or generate titles
gh-stack sync

# Rebase without publishing, then push only the branches that have PRs
gh-stack restack --no-push
gh-stack submit --existing

# Structured output
gh-stack submit --json -t "Title" --body-file body.md
gh-stack stacks --json
gh-stack status --current --json
gh-stack config --json
```

## License

MIT
