# gh-stack — Claude Code Instructions

## Project Overview

A Bun-compiled CLI tool for managing stacked PRs in Git repos that use squash-merge. Replaces 7+ bash scripts with a single `gh-stack` binary.

**Key docs:**
- `PLAN.md` — Full implementation plan, project structure, phased approach, key behaviors to preserve
- `DESIGN.md` — Spec, man page, design decisions, metadata schema
- `reference/` — Original shell scripts being ported (read-only reference)

## Quick Reference

```bash
bun install              # Install deps
bun run build            # Compile standalone binary → dist/gh-stack
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
- `src/commands/` — One file per subcommand (init, create, submit, log, restack, etc.)
- `src/lib/` — Shared modules (metadata, git, github, ui, safety, snapshot)
- `src/types.ts` — Metadata schema types
- `reference/` — Original bash scripts for behavior reference

## Conventions

- Use `Bun.spawn` / `Bun.spawnSync` for git/gh commands
- All user-facing output goes through `@clack/prompts` or `picocolors`
- Never modify metadata without reading it fresh first (avoid stale state)
- Metadata lives under `.git/.gh-stack/` (v3: per-stack files + git branch config; never committed). The old v2 `.git/gh-stack-metadata.json` monolith is migrated by `gh-stack doctor`. See `src/lib/metadata.ts`, `src/lib/paths.ts`, `src/lib/branch-config.ts`.
- All destructive operations (restack, merge, sync, remove) must take a snapshot first
- Reject rebase operations if working tree is dirty (force user to stash/commit)
- Never force-push main

## Building

```bash
bun build --compile src/index.ts --outfile dist/gh-stack
```

The compiled binary can be symlinked to PATH:
```bash
ln -s ~/Projects/oss/gh-stack/dist/gh-stack /usr/local/bin/gh-stack
```

## Testing

Test against real stacks in `~/Projects/beehiiv/swarm` during development.
For automated tests, create temp git repos with fabricated branch structures.

## Release Process

When making changes, follow these steps:

1. **Update docs** — Keep `README.md` in sync with any command/flag changes
2. **Run tests** — `bun test` (must pass before committing)
3. **Commit** — Use conventional commits
4. **Bump version** — Update `package.json` version + add entry to `CHANGELOG.md`
5. **Tag** — `git tag -a v0.x.y -m "Release v0.x.y — summary"`
6. **Build** — `bun run build`
7. **Push** — `git push && git push origin v0.x.y`
8. **Publish** — `OTP=$(op item get npm --otp) && npm publish --otp="$OTP"`

The pre-push hook runs lint + typecheck + tests (output suppressed on success).
The prepublishOnly hook is a no-op since checks already ran on push.
