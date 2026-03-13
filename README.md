# gh-stack

Stacked PR manager for squash-merge workflows.

Manages stacked pull requests with metadata stored in `.git/gh-stack-metadata.json`. Designed for repositories that use squash-merge (where tools like Graphite break down).

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

## Quick Start

```bash
# Create a stack from your current branch
gh-stack init --name my-feature

# Add more branches to the stack
gh-stack add --create kiliman/pr2-WEB-1234

# View the stack
gh-stack                    # tree view (default)
gh-stack list               # numbered list

# Sync with main and restack all branches
gh-stack sync

# Check PR status across all stacks
gh-stack status
```

## Commands

### Stack Management

```
init [--name <name>] [--description <desc>] [--parent <branch>]
    Create a new stack and add the current branch as the first entry.

add [<branch>] [--parent <branch>] [--create <branch>] [--description <desc>]
    Add a branch to the current stack. Defaults to the current branch.
    --create <branch> makes a new branch off the top of stack first.

remove [<branch>]
    Remove a branch from the stack and re-parent its children.
    If omitted, an interactive selector is shown.
```

### Navigation

```
show
    Display the current stack as a tree with branch numbers,
    PR numbers, and descriptions. This is the default command.

list
    List branches with position numbers. Lightweight output for
    scripting and agents. (alias: ls)

switch [<number>]
    Switch to a branch by position number, or interactive picker.
    --stack    Switch between stacks instead of branches

status [--current] [--json]
    PR dashboard showing review state, CI status, and merge readiness.
    --current  Show only the current stack or standalone PR
    --json     Structured JSON output (progress goes to stderr)
```

### Rebase & Sync

```
restack [--resume] [--dry-run] [--verbose] [--yes]
    Rebase the current branch and all descendants onto their parents.
    Uses tag-based references for stable rebasing across the chain.

    On conflict:
        git rebase --continue
        gh-stack restack --resume

    (alias: rebase)

sync [--dry-run] [--yes]
    Fetch main, rebase the base branch onto main, then restack all
    children. Creates tags for ALL branches before any rebasing starts.
```

### Merge & Ship

```
merge [--dry-run]
    Squash-merge the stack top-down locally (PR3 -> PR2 -> PR1),
    then optionally rebase onto main. Keeps all commits local to
    avoid orphaned squash commits from GitHub-only merges.
    Can also close intermediate PRs and archives the stack on completion.

update-prs
    Update all PR descriptions with a stack visualization:

        ### 📚 Stacked on
        ⚫ main
        ┃
        ┣━ ✅ #123 Backend models 👈
        ┃
        ┗━ ⏳ #124 Frontend UI
```

### Maintenance

```
archive [--restore <name>]
    List archived stacks by default, or restore one by name.

undo
    Restore the last snapshot taken before a destructive operation.
```

## Not Implemented Yet

These are still intended, but not shipped in `v0.1.1`:

```text
split
    Guided helper for splitting a branch/PR into two and updating stack metadata.

insert
    Insert a branch into the middle of an existing stack and re-parent the chain.
```

## Global Options

```
--yes, -y      Skip all confirmations (for agents/CI)
--help         Show help for a command
--version, -V  Show version
```

## Environment Variables

```
GH_STACK_YES=1         Skip all confirmations (same as --yes)
GH_STACK_NO_COLOR=1    Disable colored output
```

## How It Works

### Tag-Based Rebasing

The critical insight: after rebasing a parent branch, `git merge-base` returns wrong results for its children. gh-stack solves this by creating temporary `stack-sync-*` tags marking each branch's divergence point **before** any rebasing starts, then using those stable references for `git rebase --onto`.

### Metadata

Stack metadata lives at `.git/gh-stack-metadata.json` (never committed):

```json
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
  }
}
```

### Snapshots

Before any destructive operation (restack, sync, merge, remove), gh-stack saves a snapshot of all branch HEADs. Run `gh-stack undo` to restore.

## Example Workflow

```bash
# Start a new stack
git checkout -b kiliman/api-layer-WEB-1234
# ... code, commit, push, create PR ...
gh-stack init --name api-feature

# Add second PR on top
gh-stack add --create kiliman/frontend-WEB-1234
# ... code, commit, push, create PR ...

# Update PR descriptions with stack visualization
gh-stack update-prs

# Later: sync everything with main
gh-stack sync --yes

# Check status
gh-stack status --current --json

# When PRs are approved, merge the stack
gh-stack merge
```

## Agent/CI Usage

gh-stack is designed to be used by AI agents and CI pipelines:

```bash
# Non-interactive mode
export GH_STACK_YES=1
gh-stack sync
gh-stack restack

# Structured output
gh-stack status --json
gh-stack status --current --json
gh-stack list

# Quick branch switching
gh-stack switch 2
```

## License

MIT
