# Changelog

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
