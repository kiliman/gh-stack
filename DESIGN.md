# gh-stack — Unified Stacked PR Manager

## Retro

First of all, our "poor man's" stacked PR scripts are amazing. I'm glad we were able to figure out a solution when we had so much difficulty with Graphite's tooling.

The issue we had was that beehiiv uses squash-merge when merging the PR into main. This caused a ton of problems with how Graphite tracked the stacked PRs and made rebasing very difficult.

### What we built (shell scripts)

| Script | Purpose | Maps to |
|--------|---------|---------|
| `tmp/gh-stack` | Visualize stack, switch branches | `gh-stack show`, `gh-stack switch` |
| `tmp/gh-stack-init` | Create stacks, add/remove branches | `gh-stack init`, `gh-stack add`, `gh-stack remove` |
| `tmp/gh-stack-sync` | Rebase/restack children onto parents | `gh-stack restack`, `gh-stack sync` |
| `tmp/git-restack` | Symlink → gh-stack-sync | `gh-stack restack` |
| `tmp/gh-stack-update-pr` | Update PR descriptions with stack viz | `gh-stack update-prs` |
| `tmp/gh-stack-migrate` | One-time migration (can retire) | N/A |
| `tmp/gh-stack-merge.md` | Merge-down design doc | `gh-stack merge` |
| `tmp/check-my-prs-fast` | PR status dashboard | `gh-stack status` |

---

## A. Happy path (single PR)

1. New work is requested, create a new branch off of main for a ticket
2. Hack, hack, hack
3. Commit, push, create PR
4. Review, Approve
5. Squash-merge PR to main
6. Done

## B. Happy path (stacked PRs)

Here's what would happen if we decide we need to split work into a separate PR to make it easier to review:

1. New work is requested, create a new branch off of main for a ticket
2. Hack, hack, hack
3. Commit, push, create PR
4. Create a new stack from this branch PR1 (base main)
5. Submit PR1 for Review
6. Create new branch on this stack from PR1
7. Hack, hack, hack
8. Commit, push, create PR2
9. Address issues for PR1 by switching to PR1 in stack
10. Hack, hack, hack
11. Force push PR1
12. Restack (rebase) from PR1 up to PR2, etc
13. Each rebase force pushes
14. All PRs in stack approved
15. Squash-merge down from PR2 to PR1 locally (to ensure local always has latest rebase)
16. Force push PR1
17. Squash-merge down PR1 to main (from GitHub, since we can't commit or push directly to main from local)
18. Done

## C. Other scenarios

1. **Sync with main** — Long running stacks should sync up with main regularly, so need a sync that rebases PR1 on latest main, and restacks entire stack
2. **Split a PR** — Ability to split an existing PR in stack. Create a new branch from source branch, cherry pick commits or files from source to new branch and remove/update files on source branch until both branches are correct. Update the stack metadata accordingly.
3. **Switch stacks** — Working on multiple stacks should allow us to switch stacks as easily as switching branches (tracks last branch on each stack)
4. **Archive stacks** — Currently we auto-close stacks once all PRs are merged. Save to archived metadata so we can go back to a previous stack for historical reasons.
5. **Abandon a PR mid-stack** — PR2 gets scrapped but PR1 and PR3 are still good. Remove a branch from the middle of a stack and re-link PR1 → PR3.
6. **Insert a PR into stack** — Need to add a new branch between two existing ones (e.g., split PR1 into PR1a → PR1b, or insert a prep PR between PR1 and PR2). Update parent pointers and restack.

## Needs (mapped to subcommands)

| # | Need | Subcommand | Ref |
|---|------|------------|-----|
| 1 | Create a new stack from an existing branch/PR | `gh-stack init` | B4 |
| 2 | Add branch to current stack (from top, or with explicit parent) | `gh-stack add` | B6 |
| 3 | Switch to another PR/branch in current stack | `gh-stack switch` | B9 |
| 4 | Restack from current PR to tip, force pushing each step | `gh-stack restack` | B12 |
| 5 | Merge down stack after approval (local squash-merge) | `gh-stack merge` | B15 |
| 6 | Sync base branch with main, then restack entire stack | `gh-stack sync` | C1 |
| 7 | Update PR descriptions with stack visualization | `gh-stack update-prs` | B8 |
| 8 | Split PR and update stack metadata | `gh-stack split` | C2 |
| 9 | Switch between stacks | `gh-stack switch --stack` | C3 |
| 10 | View archived stacks | `gh-stack archive` | C4 |
| 11 | PR status dashboard (CI, reviews, merge state) | `gh-stack status` | — |
| 12 | Remove branch from stack (re-link parent chain) | `gh-stack remove` | C5 |
| 13 | Insert branch into stack at specific position | `gh-stack insert` | C6 |
| 14 | Undo last destructive operation | `gh-stack undo` | — |

## Design Decisions

### Runtime: Bun

Switching from bash to **Bun** for:
- Proper JSON handling (no more `jq` piping)
- Interactive TUI via `@clack/prompts` (arrow key selection, spinners, confirmations)
- Easier error handling and state management
- Standalone executable via `bun build --compile` for easy distribution
- TypeScript for type safety on metadata schema

### Safety

- **Dirty working tree** — Reject any command that requires rebasing if the working tree is dirty. Force the user to stash or commit first.
- **Snapshot before destructive ops** — Before restack, merge, sync, or remove, save current branch HEADs to metadata as a snapshot. `gh-stack undo` restores from the last snapshot.
- **Conflict handling** — When a rebase hits conflicts, exit with a notice. User resolves (e.g., in GitKraken GUI), then runs `gh-stack restack --resume`.
- **Never force-push main** — Hard block, no exceptions.
- **Merge-down safety** — Always do squash-merge locally (not on GitHub) so local branch always has all commits. This prevents the bug where `git rebase origin/main` orphans GitHub-only squash commits (see `gh-stack-merge.md`).

### Metadata

Same location: `.git/gh-stack-metadata.json` (persists, not committed).

New additions:
- `archive` key for closed stacks
- `snapshots` array for undo history (last N snapshots of branch HEADs)
- `version` field for future schema migrations

---

## Man Page

```
GIT-STACK(1)                     Git Stack Manager                     GIT-STACK(1)

NAME
    gh-stack — Unified stacked PR manager for squash-merge workflows

SYNOPSIS
    gh-stack <command> [options]

DESCRIPTION
    Manages stacked pull requests with metadata stored in
    .git/gh-stack-metadata.json. Designed for repositories that use
    squash-merge (where tools like Graphite break down).

    All commands operate on the "current stack" unless --stack is specified.

COMMANDS

  Stack Management
  ────────────────

    init [--name <name>] [--description <desc>]
        Create a new stack and add the current branch as the first entry.
        If --name is omitted, prompts interactively.

        Options:
            --name <name>         Stack name (skip prompt)
            --description <desc>  Stack description

        Examples:
            gh-stack init
            gh-stack init --name podcast-mvp --description "Podcast MVP features"

    add [<branch>] [--parent <branch>] [--create] [--description <desc>]
        Add a branch to the current stack. Defaults to the current branch.

        Options:
            --parent <branch>     Parent branch (skip prompt; default: top of stack)
            --create              Create a new branch off the top of stack first
            --description <desc>  Description for the branch

        Examples:
            gh-stack add
            gh-stack add --create kiliman/new-feature-WEB-1234
            gh-stack add --parent kiliman/pr1-branch --description "API layer"

    remove <branch>
        Remove a branch from the current stack and re-link the parent chain.
        If the removed branch has children, they are re-parented to the
        removed branch's parent.

        Example:
            gh-stack remove kiliman/abandoned-pr-WEB-5678

    insert <branch> --after <branch>
        Insert a branch into the stack after the specified branch.
        Re-parents the next branch in the chain to point to the inserted one.

        Example:
            gh-stack insert kiliman/prep-work-WEB-9999 --after kiliman/pr1-WEB-1234

  Navigation
  ──────────

    show
        Display the current stack as a tree with PR numbers, titles,
        review status, and CI state. Highlights the current branch.
        This is the default command when no subcommand is given.

        Aliases: (none — this is the default)

    switch [<number>]
        Switch to a branch in the current stack by its position number.
        If no number given, shows interactive selector with arrow keys.

        Options:
            --stack               Switch between stacks instead of branches

        Examples:
            gh-stack switch         # interactive branch picker
            gh-stack switch 2       # jump to branch #2 in stack
            gh-stack switch --stack # interactive stack picker

    status
        Show a dashboard of all open PRs across all stacks with:
        review state (✅/❌/👀/⏳), CI status (pass/fail/pending counts),
        draft state, and merge readiness.

        Uses local caching — only fetches updates for PRs that changed.

  Rebase & Sync
  ─────────────

    restack [--resume] [--dry-run] [--verbose]
        Rebase the current branch and all its descendants onto their
        respective parents. Prompts before each rebase and force-push.

        If a rebase conflict occurs, resolve it and run:
            git rebase --continue
            gh-stack restack --resume

        Options:
            --resume    Continue after resolving rebase conflicts
            --dry-run   Show what would happen without executing
            --verbose   Show diagnostic info (tag vs merge-base comparison)

        Aliases: rebase

    sync [--dry-run]
        Fetch latest main, rebase the base branch onto main, then
        restack all children. Equivalent to: rebase base onto main +
        restack from base to tip.

        Options:
            --dry-run   Show what would happen without executing

  Merge & Ship
  ────────────

    merge [--dry-run]
        Squash-merge the stack top-down locally:
        PR3 → PR2 → PR1, then optionally rebase PR1 onto main.

        This keeps all commits local (avoiding the bug where GitHub-only
        squash commits get orphaned by a local rebase).

        After merge:
        - Close intermediate PRs on GitHub (with comment linking to base PR)
        - Archive the stack in metadata
        - Optionally delete local and remote branches

        Options:
            --dry-run   Preview the merge plan without executing

  PR Descriptions
  ───────────────

    update-prs
        Update all PR descriptions in the current stack with a
        standardized stack visualization section:

            ### 📚 Stacked on
            ⚫ main
            ┃
            ┣━ ✅ #123 Backend models 👈
            ┃
            ┗━ ⏳ #124 Frontend UI

        Can be run from any branch in the stack.

  Maintenance
  ───────────

    archive [--list] [--restore <name>]
        Manage archived stacks (stacks whose PRs are all merged).

        Options:
            --list              List all archived stacks
            --restore <name>    Restore an archived stack to active

    undo
        Restore the last snapshot taken before a destructive operation
        (restack, merge, sync, remove). Resets branch HEADs to their
        saved positions.

    split <branch>
        Interactive helper to split a branch into two. Creates a new
        branch, lets you cherry-pick or move commits/files between them,
        and updates the stack metadata.

        This is a guided process — not fully automated.

GLOBAL OPTIONS
    --stack <name>    Operate on a specific stack (override current)
    --help            Show help for a command
    --version         Show version

METADATA
    Stored in .git/gh-stack-metadata.json (not committed).

    Schema:
        {
          "version": 2,
          "current_stack": "podcast-mvp",
          "stacks": {
            "podcast-mvp": {
              "description": "Podcast MVP features",
              "last_branch": "kiliman/pr2-WEB-1234",
              "branches": {
                "kiliman/pr1-WEB-1234": {
                  "parent": "main",
                  "pr": 21306,
                  "description": "Backend models"
                },
                "kiliman/pr2-WEB-1234": {
                  "parent": "kiliman/pr1-WEB-1234",
                  "pr": 21452,
                  "description": "Frontend UI"
                }
              }
            }
          },
          "archive": { ... },
          "snapshots": [ ... ]
        }

ENVIRONMENT
    GIT_STACK_NO_COLOR    Disable colored output
    GIT_STACK_VERBOSE     Always show verbose output

EXIT CODES
    0    Success
    1    Error (invalid args, missing metadata, git failure)
    2    Conflict (rebase paused, user action needed)

SEE ALSO
    git-rebase(1), gh(1)

EXAMPLES

    # Full stacked PR workflow
    gh-stack init --name podcast-mvp
    gh-stack add --description "Backend models"
    # ... hack, push, create PR ...
    gh-stack add --create kiliman/frontend-WEB-1234 --description "Frontend UI"
    # ... hack, push, create PR ...
    gh-stack update-prs
    gh-stack restack
    gh-stack merge

    # Daily workflow
    gh-stack                   # show current stack
    gh-stack switch 2          # jump to PR #2
    gh-stack sync              # sync with latest main
    gh-stack status            # check CI and reviews
    gh-stack switch --stack    # switch to different stack

                                                                   gh-stack v2.0.0
```

---

## Implementation Plan

### Phase 1: Core (MVP)

Port the existing working scripts into a single Bun CLI. No new features — just consolidation.

1. **Project setup** — `tools/gh-stack/` with `package.json`, `tsconfig.json`, Bun build config
2. **Metadata module** — Read/write `.git/gh-stack-metadata.json` with TypeScript types
3. **`show`** (default) — Port `tmp/gh-stack` visualization
4. **`init`** — Port `tmp/gh-stack-init` (create stack + add first branch)
5. **`add`** — Port `tmp/gh-stack-init --add` (add branch, `--create` flag)
6. **`remove`** — Port `tmp/gh-stack-init --remove` (with re-parenting)
7. **`switch`** — Port interactive branch/stack switching from `tmp/gh-stack`
8. **`restack`** — Port `tmp/gh-stack-sync` (tag-based rebase, `--resume`, `--dry-run`)
9. **`update-prs`** — Port `tmp/gh-stack-update-pr`
10. **`status`** — Port `tmp/check-my-prs-fast`

Build standalone executable: `bun build --compile src/index.ts --outfile gh-stack`

### Phase 2: New Features

11. **`sync`** — Rebase base onto main + restack (currently `--rebase` flag on sync script)
12. **`merge`** — Local squash-merge top-down (from `gh-stack-merge.md` design)
13. **`undo`** — Snapshot/restore system for destructive operations
14. **`archive`** — Archive closed stacks, list/restore

### Phase 3: Polish

15. **`insert`** — Insert branch into stack at specific position
16. **`split`** — Guided PR splitting helper
17. **TUI improvements** — Arrow key navigation everywhere via `@clack/prompts`
18. **Auto-update PRs** — After restack/merge, automatically run `update-prs`
19. **Shell completion** — Tab completion for subcommands and branch names

### Dependencies

```json
{
  "dependencies": {
    "@clack/prompts": "^0.9",
    "picocolors": "^1.1"
  }
}
```

No `jq` dependency — Bun handles JSON natively.
No `gh` dependency for metadata — only for GitHub API calls (PR info, updates).
