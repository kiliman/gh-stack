# git-stack — Claude Code Instructions

## Project Overview

A Bun-compiled CLI tool for managing stacked PRs in Git repos that use squash-merge. Replaces 7+ bash scripts with a single `git-stack` binary.

**Key docs:**
- `PLAN.md` — Full implementation plan, project structure, phased approach, key behaviors to preserve
- `DESIGN.md` — Spec, man page, design decisions, metadata schema
- `reference/` — Original shell scripts being ported (read-only reference)

## Quick Reference

```bash
bun install              # Install deps
bun run build            # Compile standalone binary → dist/git-stack
bun run src/index.ts     # Run in dev mode
bun test                 # Run tests
```

## Tech Stack

- **Bun** — Runtime, bundler, test runner
- **TypeScript** — Strict mode
- **@clack/prompts** — Interactive TUI (arrow keys, confirmations, spinners)
- **picocolors** — Terminal colors
- **git / gh** — Shell out for git operations and GitHub API

## Architecture

- `src/index.ts` — CLI entry point, subcommand router
- `src/commands/` — One file per subcommand (show, init, add, restack, etc.)
- `src/lib/` — Shared modules (metadata, git, github, ui, safety, snapshot)
- `src/types.ts` — Metadata schema types
- `reference/` — Original bash scripts for behavior reference

## Conventions

- Use `Bun.spawn` / `Bun.spawnSync` for git/gh commands
- All user-facing output goes through `@clack/prompts` or `picocolors`
- Never modify metadata without reading it fresh first (avoid stale state)
- Metadata lives at `.git/git-stack-metadata.json` (never committed)
- All destructive operations (restack, merge, sync, remove) must take a snapshot first
- Reject rebase operations if working tree is dirty (force user to stash/commit)
- Never force-push main

## Building

```bash
bun build --compile src/index.ts --outfile dist/git-stack
```

The compiled binary can be symlinked to PATH:
```bash
ln -s ~/Projects/oss/git-stack/dist/git-stack /usr/local/bin/git-stack
```

## Testing

Test against real stacks in `~/Projects/beehiiv/swarm` during development.
For automated tests, create temp git repos with fabricated branch structures.
