# gh-stack

Stacked PR manager for squash-merge workflows.

Manages stacked pull requests with metadata stored locally under `.git/.gh-stack/` (never committed). Designed for repositories that use squash-merge (where tools like Graphite break down). Inspired by [Graphite](https://graphite.dev/) (`gt`) but works directly against GitHub — no backend required.

## Install

```bash
# From source (requires Bun)
bun install
bun run build
ln -s $(pwd)/dist/gh-stack ~/.local/bin/gh-stack

# Or install globally
bun install -g gh-stack
```

### Prerequisites

- [Bun](https://bun.sh) runtime
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated
- Git 2.30+

## Terms

| Term | Definition |
|------|-----------|
| **trunk** | Base branch of the repository (usually `main`) |
| **stack** | A chain of dependent branches |
| **upstack** | Branches that depend on the current branch (children) |
| **downstack** | Branches the current branch depends on (ancestors) |

## Quick Start

```bash
# You have branches: main → feat-1 → feat-2
# Go to the top of the chain and init:
git checkout feat-2
gh-stack init                    # Auto-detects the chain!

# Or start fresh:
git checkout kiliman/first-pr
gh-stack init                    # Creates stack with this branch
gh-stack create kiliman/second-pr  # Branch off current, add to stack

# Push everything to GitHub and create PRs
gh-stack submit

# View the stack
gh-stack log                     # tree view (default)
gh-stack ls                      # numbered list

# Navigate
gh-stack up                      # move to child branch
gh-stack down                    # move to parent branch
gh-stack top                     # jump to tip of stack
gh-stack bottom                  # jump to base of stack

# Sync with main and restack
gh-stack sync

# Check PR status
gh-stack status

# Split a long in-review chain so new work becomes its own stack
gh-stack split feat-12           # feat-12.. → new stack based on feat-11
# ...later, after the original stack merges to main:
gh-stack restack --onto main     # re-root the split stack onto main
```

## Commands

### Core Workflow

```
init [--name <name>] [--description <desc>] [--parent <branch>]
    Create a new stack from the current branch. Auto-detects branch
    chains — if you're at the top of main → feat-1 → feat-2, all
    branches are added to the stack automatically.

create <branch-name> [--description <desc>]
    Create a new git branch off the current branch and add it to
    the stack. The current branch must already be tracked.

submit [-d|--draft] [-n|--no-edit] [-t|--title <t>] [-b|--body <b>] [--body-file <f>] [--dry-run]
    Push all downstack branches to GitHub, create PRs for branches
    that don't have them, and update all PR descriptions with stack
    visualization. Idempotent — safe to run repeatedly.

    Self-healing: if the current branch isn't tracked in a stack yet,
    submit auto-detects the chain from trunk → current, registers (or
    reconciles into) a stack, then pushes + creates PRs for the whole
    chain. You never need to run `gh-stack init` first — running submit
    from the top of a bare chain of local branches converges to the
    expected end state (stack registered, branches pushed, PRs created).

    --title/-t and --body/-b provide PR details directly (skips prompts).
    --body-file reads body from a file. In --yes mode without --title,
    auto-generates PR titles from branch names.
```

### Stack Navigation

```
checkout [<branch>]
    Switch to a branch by name, or interactive picker.
    --stack    Switch between stacks instead of branches
    (alias: co)

up [steps]
    Move to child branch (upstack). Prompts if multiple children.

down [steps]
    Move to parent branch (downstack).

top
    Jump to the tip (leaf) of the current stack.

bottom
    Jump to the base (first branch above trunk).

ls
    List branches with position numbers.
```

### Stack Management

```
restack [--resume] [--dry-run] [--verbose]
    Rebase the current branch and all descendants onto their parents.
    Uses metadata snapshots to recover the correct rebase base even
    after a parent's history has been rewritten.

    On conflict:
        git rebase --continue
        gh-stack restack --resume

    (alias: rebase)

restack --onto <ref>
    Re-root the current stack onto a new base ref, changing the stack's
    base. Use this to move a split stack off its parent-stack branch and
    onto main once the parent stack has merged — only the stack's own
    commits replay onto the new base.

sync [--dry-run]
    Fetch main, rebase the base branch onto main, then restack all
    children. Snapshots every branch's pre-sync tip so children can be
    correctly rebased even though their parent's history was rewritten.

merge [--dry-run] [-d|--delete-branch] [--collapse]
    Squash-merge the stack top-down via GitHub (PR3 → PR2 → PR1),
    then enables auto-merge for the base PR into main. All merges
    happen on GitHub so PRs show as "Merged", Linear tickets close
    automatically, and GitHub Actions fire normally. Skips already-
    merged PRs (safe to re-run). Waits for GitHub between merges.
    --collapse  Stop after collapsing the stack into the base PR;
                leaves the base PR open against main so you can
                review the cumulative diff on GitHub. Re-run
                `gh-stack merge` (without --collapse) to finish.

split [<branch>] [--name <name>]
    Cut the current stack into two at <branch>. The cut branch and every
    branch above it move into a NEW stack whose base is the cut branch's
    parent (which stays in the original stack). Purely a metadata
    operation — no git branches are moved or rebased. Interactive
    selector if no branch is given; you can't split at the stack's root.

    Use it when a long chain is in review and can't merge yet, but new
    work is piling on top: split at the first "new work" branch so the
    original stack stays the review unit and the new stack rides on its
    tip. Once the original stack merges, re-root the new stack with
    `gh-stack restack --onto main`.

delete [<branch>] [-k|--keep-branch] [--no-remote]
    Remove a branch from the stack and re-parent its children, then
    delete the underlying local git branch (and the remote branch if
    it was pushed). Interactive selector if no branch specified.
    --keep-branch leaves the git branches untouched (metadata only);
    --no-remote deletes the local branch but keeps the remote.
```

### Info & Maintenance

```
log
    Display the current stack as a tree with branch numbers,
    PR info, and descriptions. This is the default command.

status [--current] [--json]
    PR dashboard showing review state, CI status, and merge readiness.
    --current  Show only the current stack or standalone PR
    --json     Structured JSON output (progress goes to stderr)

undo
    Restore the last snapshot taken before a destructive operation.

archive [--restore <name>]
    List archived stacks by default, or restore one by name.

doctor
    Migrate old (v2) metadata to the v3 layout, reconcile git branch
    config against the topology files, and flag stacks whose base
    stack appears already-merged into main. Safe to run repeatedly.
```

## Global Options

```
--yes, -y      Skip all confirmations (for agents/CI)
--plain        Plain output — no spinners, colors, or banner boxes
--help         Show help for a command
--version, -V  Show version
```

`--plain` is auto-enabled when `--yes` / `GH_STACK_YES=1` is set, so agents get clean, easily-filtered output by default. Use `--plain` alone if you want plain output but still interactive prompts.

## Environment Variables

```
GH_STACK_YES=1         Skip all confirmations (same as --yes; also enables --plain)
GH_STACK_PLAIN=1       Plain output (same as --plain)
GH_STACK_NO_COLOR=1    Disable colored output
```

## How It Works

### Smart Init

`gh-stack init` auto-detects branch chains by walking git ancestry. From the top branch, it finds all local branches whose tips are strict ancestors (but not already merged into trunk) and reconstructs the chain with correct parent relationships.

### Snapshot-Based Rebasing

The critical insight: after a parent branch's history is rewritten (e.g., rebased onto a new main), `git merge-base(child, parent)` falls all the way back to the original main — and using that as a rebase base would replay the parent's old commits onto the child, producing ghost-conflicts on the parent's own work.

gh-stack solves this by snapshotting every branch's tip **before** any destructive operation. When restacking a child whose parent has been rewritten, gh-stack walks the snapshots newest-first and finds the most recent recorded tip that's no longer an ancestor of the parent's current tip. That orphaned SHA is the correct rebase base — `git rebase --onto <new-parent-tip> <orphaned-old-tip> <child>` replays only the child's unique commits.

Snapshots also power `gh-stack undo`, so the same data structure does double duty.

### Stack Visualization

`submit` automatically adds a stack section to all PR descriptions:

```
### 📚 Stacked on
⚫ main
┃
┣━ ✅ #123 Backend models
┃
┗━ ⏳ #124 Frontend UI 👈
```

### Metadata (v3)

Stack metadata lives under `.git/.gh-stack/` (never committed) — a folder of
per-stack files plus git-native branch config, rather than a single JSON blob:

```
.git/.gh-stack/
  current                      hint: last-active stack name
  active/<stack>.json          topology of a live stack (ordered branches, base, description)
  archived/<stack>.json        merged/closed stacks
  deleted/<stack>.json         tombstones (recoverable)
  snapshots/<ts>__<stack>.json append-only, retained per-stack
  restack-state.json           in-flight restack/sync resume state
```

A single `active/<stack>.json` looks like:

```json
{
  "description": "",
  "last_branch": "kiliman/feature-2",
  "base": "main",
  "branches": {
    "kiliman/feature-1": { "parent": "main", "pr": 21729 },
    "kiliman/feature-2": { "parent": "kiliman/feature-1", "pr": 21730 }
  }
}
```

Per-branch membership is *also* recorded in git's own config, so renaming or
deleting a branch updates/cleans it automatically:

```
branch.<name>.ghstack-stack   <stack>
branch.<name>.ghstack-parent  <parent-branch>
branch.<name>.ghstack-pr      <number>
```

The two representations cross-check each other; `gh-stack doctor` reconciles
any drift. Why this shape:

- **A stack can't silently vanish** — lifecycle transitions are file moves
  (`active/ → archived/ → deleted/`), and a stale stack file is tombstoned, never
  just unlinked.
- **No `current_stack` drift** — the stack you're on is derivable from the
  branch's own config, so a written pointer can't contradict reality.
- **No all-or-nothing blast radius** — one bad write can't corrupt other stacks.

#### Migrating from v2

Repos created before v3 store a single `.git/gh-stack-metadata.json`. Run
`gh-stack doctor` once — it fans the monolith out into the layout above,
backfills branch config, explodes snapshots into per-file records, and keeps a
`.bak` of the old file. Commands refuse to run on unmigrated metadata and point
you at `doctor`.

### Snapshots

Before any destructive operation (restack, sync, merge, delete), gh-stack saves a snapshot of all branch HEADs as an append-only file under `snapshots/`, retained per-stack. Run `gh-stack undo` to restore.

## Example Workflow

```bash
# Start from an existing branch with a PR
git checkout kiliman/api-layer-WEB-1234
gh-stack init

# Create second PR on top
gh-stack create kiliman/frontend-WEB-1234
# ... code, commit ...

# Push everything and create PRs
gh-stack submit

# Later: sync everything with main
gh-stack sync

# Navigate the stack
gh-stack up          # go to child
gh-stack down        # go to parent
gh-stack top         # jump to tip

# Check status
gh-stack status

# When PRs are approved, merge the stack
gh-stack merge       # squash-merges down, pushes, enables auto-merge

# Or: collapse first to review the cumulative diff before shipping
gh-stack merge --collapse   # squash-merges PRn..PR2 into PR1, stops there
# ...review base PR on GitHub...
gh-stack merge              # finishes base PR → main + archives the stack
```

## Agent/CI Usage

gh-stack is designed to be used by AI agents and CI pipelines:

```bash
# Non-interactive mode — all prompts auto-resolved
export GH_STACK_YES=1

gh-stack init                    # No confirmations
gh-stack submit -t "Title [WEB-1234]" -b "Description"  # Explicit PR details
gh-stack submit -n               # Or auto-generate titles
gh-stack sync
gh-stack restack

# Structured output
gh-stack status --json
gh-stack status --current --json
gh-stack ls
```

## License

MIT
