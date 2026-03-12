# git-stack — Implementation Plan

## What This Is

A unified CLI tool for managing stacked PRs in Git repositories that use **squash-merge** (where tools like Graphite break down). Replaces 7+ shell scripts with a single Bun-compiled executable.

**See `DESIGN.md` for the full spec, man page, and design decisions.**

## Why It Exists

beehiiv uses squash-merge when merging PRs into main. This causes Graphite and similar stacked-PR tools to lose track of branch relationships after merges, making rebasing nearly impossible. We built shell scripts that work around this by storing stack metadata in `.git/git-stack-metadata.json` and using temporary tags for stable rebase references.

The scripts work great but are hard to maintain (800+ lines of bash with `jq` piping), don't have proper TUI (no arrow keys), and lack safety features (no undo). Time to graduate to a proper tool.

## Tech Stack

- **Runtime:** Bun (TypeScript)
- **Build:** `bun build --compile` → standalone executable
- **TUI:** `@clack/prompts` (arrow key selectors, confirmations, spinners)
- **Colors:** `picocolors` (lightweight terminal colors)
- **Git:** Shell out to `git` and `gh` CLI (not libgit2 — keep it simple)
- **Package manager:** bun

## Project Structure

```
git-stack/
├── PLAN.md                     # This file
├── DESIGN.md                   # Full spec, man page, design decisions
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                # CLI entry point (subcommand router)
│   ├── commands/
│   │   ├── show.ts             # Default: visualize stack tree
│   │   ├── init.ts             # Create new stack
│   │   ├── add.ts              # Add branch to stack
│   │   ├── remove.ts           # Remove branch (re-link chain)
│   │   ├── switch.ts           # Switch branch or stack
│   │   ├── restack.ts          # Rebase children onto parents
│   │   ├── sync.ts             # Rebase base onto main + restack
│   │   ├── merge.ts            # Local squash-merge top-down
│   │   ├── update-prs.ts       # Update PR descriptions
│   │   ├── status.ts           # PR dashboard (CI, reviews)
│   │   ├── archive.ts          # Archive/restore stacks
│   │   ├── undo.ts             # Restore from snapshot
│   │   ├── insert.ts           # Insert branch at position
│   │   └── split.ts            # Guided PR split
│   ├── lib/
│   │   ├── metadata.ts         # Read/write metadata JSON
│   │   ├── git.ts              # Git command helpers
│   │   ├── github.ts           # GitHub CLI (gh) helpers
│   │   ├── ui.ts               # TUI helpers (prompts, tree rendering)
│   │   ├── snapshot.ts         # Snapshot/undo system
│   │   └── safety.ts           # Pre-flight checks (dirty tree, etc.)
│   └── types.ts                # Metadata schema types
├── reference/                  # Original shell scripts (read-only reference)
│   ├── git-stack-show.sh
│   ├── git-stack-init.sh
│   ├── git-stack-sync.sh
│   ├── git-stack-update-pr.sh
│   ├── check-my-prs-fast.sh
│   ├── git-stack-merge-design.md
│   └── example-metadata.json
└── dist/
    └── git-stack               # Compiled standalone binary
```

## Metadata Schema (v2)

```typescript
interface StackMetadata {
  version: 2;
  current_stack: string | null;
  stacks: Record<string, Stack>;
  archive?: Record<string, Stack>;
  snapshots?: Snapshot[];
}

interface Stack {
  description: string;
  last_branch: string | null;
  branches: Record<string, Branch>;
}

interface Branch {
  parent: string;            // "main" or another branch name
  pr?: number;               // GitHub PR number
  description?: string;      // Human-readable label
}

interface Snapshot {
  timestamp: string;         // ISO 8601
  operation: string;         // "restack" | "merge" | "sync" | "remove"
  branches: Record<string, string>;  // branch name → commit SHA
}
```

## Implementation Phases

### Phase 1: Core (MVP) — Port existing scripts

**Goal:** Replace all shell scripts with one binary. No new features — just consolidation.

1. **Project setup** — `package.json`, `tsconfig.json`, Bun build config
2. **`src/types.ts`** — Metadata schema types
3. **`src/lib/metadata.ts`** — Read/write/validate `.git/git-stack-metadata.json`
   - Auto-migrate v1 → v2 schema (add `version` field)
   - Handle missing file gracefully
4. **`src/lib/git.ts`** — Helpers: `currentBranch()`, `isCleanWorkingTree()`, `checkout()`, `rebase()`, `push()`, `mergeBase()`, etc.
5. **`src/lib/github.ts`** — Helpers: `getPrNumber()`, `getPrInfo()`, `updatePrBody()`, `closePr()`
6. **`src/lib/ui.ts`** — Tree rendering, branch/stack selectors via `@clack/prompts`
7. **`src/lib/safety.ts`** — Pre-flight: dirty tree check, detached HEAD check, metadata exists check
8. **`src/index.ts`** — Subcommand router (parse args, dispatch)
9. **`show` command** — Port `reference/git-stack-show.sh`
10. **`init` command** — Port `reference/git-stack-init.sh` (create stack flow)
11. **`add` command** — Port `reference/git-stack-init.sh --add` (add branch, `--create` flag)
12. **`remove` command** — Port `reference/git-stack-init.sh --remove` (with child re-parenting)
13. **`switch` command** — Port branch switching from show.sh + `--switch` from show.sh
14. **`restack` command** — Port `reference/git-stack-sync.sh` (tag-based rebase, `--resume`, `--dry-run`)
15. **`update-prs` command** — Port `reference/git-stack-update-pr.sh`
16. **`status` command** — Port `reference/check-my-prs-fast.sh`
17. **Build & test** — `bun build --compile`, test with real stacks in beehiiv/swarm

### Phase 2: New Features

18. **`sync` command** — Rebase base onto main + restack all (currently `--rebase` flag)
19. **`merge` command** — Local squash-merge top-down (from `reference/git-stack-merge-design.md`)
20. **`undo` command** — Snapshot before destructive ops, restore on undo
21. **`archive` command** — Archive closed stacks, list/restore

### Phase 3: Polish

22. **`insert` command** — Insert branch at specific position in stack
23. **`split` command** — Guided PR splitting helper
24. **Auto-update PRs** — After restack/merge, automatically run update-prs
25. **Shell completion** — Tab completion for subcommands and branch names
26. **README.md** — Installation, usage, examples

## Key Behaviors to Preserve

These are critical behaviors from the existing scripts that MUST be carried over:

### Tag-based rebase (from git-stack-sync.sh)
The restack command creates temporary tags (`stack-sync-*`) marking each branch's divergence point BEFORE rebasing starts. This is essential because after rebasing a parent, `git merge-base` returns wrong results for children. Tags give us stable references. Tags are cleaned up on exit (trap).

### Resume after conflicts (from git-stack-sync.sh)
State is saved to `.git/.git-stack-sync-state` before each rebase. On conflict: user resolves, runs `git rebase --continue`, then `git-stack restack --resume`. The resume flow checks: is rebase still in progress? Did it succeed? Did the user abort? Branch mismatch = likely aborted.

### Stack visualization with 👈 marker (from git-stack-update-pr.sh)
Each PR description gets a stack section with tree chars (┣━, ┗━), review emoji (✅/❌/👀/⏳), PR links, and a 👈 pointing to "this PR". The section is idempotent — existing `### 📚 Stacked on` sections are replaced.

### Force-push prompts (from git-stack-sync.sh)
After each successful rebase, immediately prompt to force-push that branch (don't batch them — user wants to see each one succeed before moving on).

### PR auto-detection (from git-stack-init.sh)
When adding a branch, auto-detect its PR number via `gh pr list --head <branch>`. Also auto-detect parent branch by checking if the branch's merge-base is on main's history.

### Dirty tree rejection (from git-stack-sync.sh)
Lines 109-115: If working tree is dirty (unless `--resume`), refuse to proceed and tell user to commit or stash.

## Installation (planned)

```bash
# From source
cd ~/Projects/oss/git-stack
bun install
bun run build

# Add to PATH
ln -s ~/Projects/oss/git-stack/dist/git-stack /usr/local/bin/git-stack
```

## Testing Strategy

Test against real stacks in `~/Projects/beehiiv/swarm`. The metadata file is in `.git/` (not committed), so it's safe to read/modify during development.

For automated tests: create temp git repos with fabricated branch structures and metadata files.
