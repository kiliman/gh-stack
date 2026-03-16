# gh-stack → Graphite Parity Plan

> **Goal:** Bring `gh-stack` to feature parity with `gt` (Graphite CLI) where it makes sense — we go directly against GitHub (no Graphite backend), so not everything applies. This plan covers command renames, new commands, and workflow improvements.
>
> **No back-compat needed** — we're pre-1.0 and this tool is for us. Old command names get removed, not aliased.

---

## Terms (add to `--help`)

Adopt Graphite's vocabulary consistently across all commands and help text:

| Term | Definition |
|------|-----------|
| **trunk** | The base branch of the repository (usually `main`). Replace hardcoded "main" references with "trunk" in UI. |
| **stack** | A chain of dependent branches, each branching off the previous one. |
| **upstack** | Branches that depend on the current branch (children/descendants). |
| **downstack** | Branches the current branch depends on (parents/ancestors back to trunk). |
| **tracked** | A branch that gh-stack knows about (exists in metadata). |
| **submit** | Push branches to remote and create/update PRs. |

---

## Command Rename Map

Clean renames — no aliases, no backward compat:

| Old | New | Graphite equiv | What changes |
|---|---|---|---|
| `show` | **`log`** | `gt log` | Rename. Still the default command. |
| `list` / `ls` | **`log short`** | `gt log short` | Becomes a subcommand of `log`. Keep `ls` as shortcut. |
| `add` | **`create`** | `gt create` | Complete rework — see below. |
| `remove` | **`delete`** | `gt delete` | Rename only. |
| `switch` | **`checkout`** | `gt checkout` | Rename. Navigation splits into `up`/`down`/`top`/`bottom`. |
| `update-prs` | *(absorbed into `submit`)* | `gt submit` | No longer a standalone command. |
| `restack` | **`restack`** | `gt restack` | ✅ No change. Keep `rebase` alias. |
| `sync` | **`sync`** | `gt sync` | ✅ No change. |
| `status` | **`status`** | N/A | ✅ No change. gt doesn't have CLI status — this is our advantage. |
| `merge` | **`merge`** | `gt merge` | ✅ No change. |
| `undo` | **`undo`** | `gt undo` | ✅ No change. |
| `archive` | **`archive`** | N/A | ✅ No change. |

---

## The Core Workflow (What We're Optimizing For)

This is the happy path that should feel effortless:

```bash
# 1. You're on kiliman/feature-1, already pushed with a PR open
#    You realize you want to stack more work on top

gh-stack init
# → Smart detection: sees current branch has a PR
# → Creates stack named after current branch (or prompts)
# → Adds current branch with parent=main, auto-detects PR number
# → Minimal prompts — just works

# 2. Create the next branch in the stack
gh-stack create kiliman/feature-2
# → Creates git branch off current branch (kiliman/feature-1)
# → Adds to stack with parent=kiliman/feature-1
# → Switches to the new branch
# → You're ready to code

# 3. Do your work, commit normally
git add . && git commit -m "Add feature 2"

# 4. Ship it
gh-stack submit
# → Walks downstack: trunk → feature-1 → feature-2 (current)
# → Pushes each branch (force-with-lease)
# → Creates PR for feature-2 targeting feature-1 as base
# → feature-1 already has a PR, just pushes
# → Updates all PR descriptions with stack visualization
# → Done!
```

---

## New & Reworked Commands

### 🔴 P0 — `init` (Rework: Smart Stack Creation)

**Current problem:** `init` asks too many questions — stack name, description, parent branch, branch description. Too much friction for the common case.

**New behavior:**
1. Detect current branch
2. Auto-detect if current branch has a PR (`gh pr list --head`)
3. Default stack name = current branch name (skip prompt, allow `--name` override)
4. Default parent = `main` (skip prompt unless ambiguous)
5. Auto-detect PR number
6. Skip description prompts (allow `--description` flag)
7. One-shot: create stack + add current branch in ~1 second

**Smart defaults (minimal prompting):**
```bash
# Common case — just works with zero prompts:
gh-stack init
# → Stack "kiliman/feature-1" created
# → Added kiliman/feature-1 (PR #42, parent: main)

# Override stack name:
gh-stack init --name my-epic-feature

# Full control:
gh-stack init --name my-feature --description "Epic feature" --parent develop
```

**Implementation:**
- Remove interactive prompts for stack name (default to branch name)
- Remove interactive prompt for parent (default to `main`)
- Remove interactive prompt for branch description
- Keep `--name`, `--description`, `--parent` flags for overrides
- Keep spinner for PR detection

---

### 🔴 P0 — `create <branch-name>` (Rework: One-Step Branch + Stack)

**Current problem:** `add` is confusing — it can add an existing branch OR create one (`--create` flag). The common workflow is always "create a new branch and add it to the stack."

**New behavior:**
```bash
gh-stack create kiliman/feature-2
# 1. Figures out current branch is in the stack
# 2. Creates git branch kiliman/feature-2 off current HEAD
# 3. Adds to stack with parent = current branch
# 4. Checks out the new branch
# 5. Done — you're on the new branch, ready to work
```

**Edge cases:**
- If current branch is NOT in the stack → error with helpful message
- If branch name already exists → error
- Auto-detect PR? No — branch is brand new, no PR yet. That's what `submit` is for.

**Flags:**
- `-m, --message <msg>` — Create with an initial commit (stage all + commit)
- `--description <desc>` — Branch description in metadata

**What about adding existing branches?** Use `track` (Priority 3) for that use case. `create` always creates a new branch.

---

### 🔴 P0 — `submit` (New: Push + Create PRs + Update Stack Viz)

**The killer feature.** This is what makes the whole workflow click.

**Behavior:**
1. Determine scope: trunk → current branch (downstack only)
2. Validate: check working tree is clean, branches are properly restacked
3. For each branch in order (bottom-up):
   a. **Push:** `git push -u --force-with-lease origin <branch>`
   b. **Create PR** (if none exists):
      - `gh pr create --base <parent-branch> --head <branch> --title <title>`
      - Prompt for title interactively (default: prettified branch name)
      - Store PR number in metadata
   c. **Update PR base** (if PR exists but base is wrong):
      - `gh pr edit <num> --base <parent-branch>`
4. Run stack viz update on all PRs (current `update-prs` logic)
5. Report results

**Scope rule:**
- `submit` = **downstack only** (trunk → current branch)
- This is the safe default — you're submitting what you've been working on
- `sync` and `restack` are the commands that go upstack

**Flags:**
- `--draft` / `-d` — Create new PRs as drafts
- `--dry-run` — Show what would happen without doing anything
- `--no-edit` / `-n` — Don't prompt for PR title (use branch name as title)
- `--edit` / `-e` — Prompt for title on ALL PRs (even existing ones)

**Idempotent:** Run it as many times as you want. Already-pushed branches get pushed again (force-with-lease is safe). Already-created PRs just get their stack viz updated.

**PR title generation:**
- Default: Convert branch name to title (`kiliman/add-podcast-feed` → `Add podcast feed`)
- With `-n`/`--no-edit`: Use the auto-generated title without prompting
- With `-e`/`--edit`: Prompt for every PR

---

### 🟡 P1 — Navigation Commands

Replace the current `switch` command with focused navigation:

#### `up [steps]`
- Move to child branch (upstack)
- Prompt if multiple children
- `-n, --steps` — Move N levels (default: 1)

#### `down [steps]`
- Move to parent branch (downstack)
- Always unambiguous (one parent)
- `-n, --steps` — Move N levels (default: 1)

#### `top`
- Jump to the leaf (tip) of the current stack
- Prompt if multiple leaves

#### `bottom`
- Jump to the first branch above trunk

#### `checkout [branch]`
- Interactive branch picker (if no arg)
- Direct checkout by name (if arg given)
- `--stack` — Switch between stacks (replaces `switch --stack`)

---

### 🟡 P1 — `modify`

Amend + auto-restack in one step:

```bash
# Make changes, then:
gh-stack modify -m "Updated implementation"
# → Amends current commit (or creates new with --commit)
# → Auto-restacks all descendants
```

**Flags:**
- `-m, --message` — Commit message
- `-a, --all` — Stage all changes before committing
- `-c, --commit` — Create new commit instead of amending
- `-e, --edit` — Open editor for commit message

---

### 🟡 P1 — `rename [name]`

```bash
gh-stack rename kiliman/better-name
# → Renames git branch
# → Updates metadata (branch key + any parent references)
# → Updates remote tracking if branch was pushed
```

---

### 🟢 P2 — Nice-to-Have

#### `track [branch]`
- Add an existing branch to the current stack
- Prompt to select parent
- Auto-detect PR
- This is what old `add` did for existing branches

#### `untrack [branch]`
- Remove from metadata without deleting the git branch

#### `info [branch]`
- Single-branch detail view: parent, children, PR, CI, reviews

#### `fold`
- Fold current branch's changes into parent
- Restack descendants onto parent
- Remove branch from metadata

#### `move`
- Re-parent current branch onto a different branch
- Restack descendants

---

## Commands We're Skipping

Graphite-specific or not worth the complexity:

| gt command | Why skip |
|---|---|
| `auth` | We use `gh` CLI auth |
| `dash` | No web UI |
| `pr` | `gh pr view` already exists |
| `feedback`, `demo`, `docs`, `changelog` | Graphite onboarding/community |
| `completion` | Maybe later |
| `config`, `aliases` | We use env vars + flags |
| `absorb` | Cool but very complex |
| `get` | We assume local-first |
| `pop` | Niche — delete + keep changes |
| `split`, `squash`, `reorder` | Complex, use git directly |
| `abort`/`continue` | We use `restack --resume` |
| `freeze`/`unfreeze` | Niche |
| `revert` | Experimental even in gt |
| `trunk` | Trivial |
| `parent`/`children` | `log` shows this |

---

## Implementation Plan

### Phase 1: Core Workflow (v0.2.0)

**Goal:** The init → create → submit workflow works end-to-end.

| # | Task | Effort | Notes |
|---|------|--------|-------|
| 1 | Rework `init` — smart defaults, minimal prompts | S | Simplify existing code, remove prompts |
| 2 | Rework `add` → `create` — one-step branch creation | M | New behavior, not just rename |
| 3 | Implement `submit` command | L | Push + PR create + update stack viz |
| 4 | Rename `show` → `log`, `remove` → `delete`, `switch` → `checkout` | S | Router + file renames + help text |
| 5 | Add TERMS section to `--help` | XS | Update `printHelp()` |
| 6 | Remove `update-prs` as standalone (fold into submit) | S | Move logic to shared lib |
| 7 | Update all help text to use new names | S | Grep and replace |
| 8 | Update DESIGN.md / man page | S | Reflect new commands |

### Phase 2: Navigation + Modify (v0.3.0)

| # | Task | Effort | Notes |
|---|------|--------|-------|
| 1 | `up` / `down` commands | S | Simple parent/child traversal |
| 2 | `top` / `bottom` commands | S | Find leaf / find base |
| 3 | `checkout` (interactive picker) | S | Mostly rename of `switch` |
| 4 | `modify` command | M | Amend + auto-restack |
| 5 | `rename` command | M | Git branch rename + metadata update |

### Phase 3: Polish (v0.4.0)

| # | Task | Effort | Notes |
|---|------|--------|-------|
| 1 | `track` / `untrack` | S | Old `add` behavior for existing branches |
| 2 | `info` | S | Single-branch detail |
| 3 | `fold` | M | Merge into parent + restack |
| 4 | `move` | M | Re-parent + restack |

---

## File Changes Summary (Phase 1)

```
src/index.ts                    — Update router, rename cases, add submit, update help
src/commands/init.ts            — Rework: smart defaults, minimal prompts
src/commands/add.ts             → src/commands/create.ts (complete rewrite)
src/commands/submit.ts          — NEW: push + PR create + stack viz
src/commands/show.ts            → src/commands/log.ts (rename + update references)
src/commands/remove.ts          → src/commands/delete.ts (rename)
src/commands/switch.ts          → src/commands/checkout.ts (rename)
src/commands/update-prs.ts      — Extract buildStackViz to lib, command becomes internal
src/lib/github.ts               — Add createPr(), editPrBase() helpers
src/lib/submit.ts               — NEW: shared submit logic (push, PR create, viz update)
```
