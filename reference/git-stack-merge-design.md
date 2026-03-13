# gh-stack-merge — Local Stack Merge Process

## Problem

When merging stacked PRs top-down via GitHub's squash merge, intermediate
squash commits are added to the **remote** branch only. If you locally rebase
before the final merge, those squash commits are lost because `git rebase`
replays only local commits.

This happened on 2026-03-10: PR2 and PR3 (1,500+ lines) were squash-merged
into PR1's branch on GitHub, but a local `burs` (bin/update --rebase --stash)
before the final merge overwrote the remote with a force-push, losing both
intermediate squash commits.

## Root Cause

- `git fetch origin main && git rebase origin/main` fetches **main**, not your feature branch
- Squash commits from GitHub live on `origin/<your-branch>`, not on your local branch
- Force-push after local rebase overwrites the remote, orphaning the squash commits

## Proposed Solution: `tmp/gh-stack-merge`

A local script that merges the stack down without GitHub's squash merge,
keeping everything under local control.

### Algorithm

```
Given stack: main → PR1 → PR2 → PR3 (top)

1. Ensure all PRs are approved and CI is green on the top branch
2. Start from the TOP of the stack and work down:

   # Merge PR3 into PR2
   git checkout PR2-branch
   git merge --squash PR3-branch
   git commit -m "squash: PR3 title (#PR3-number)"

   # Merge PR2 (now containing PR3) into PR1
   git checkout PR1-branch
   git merge --squash PR2-branch
   git commit -m "squash: PR2 title (#PR2-number)"

3. Now PR1 has everything. Rebase on latest main if needed:
   git fetch origin main
   git rebase origin/main

4. Force-push PR1 and let CI run
5. Squash merge PR1 into main via GitHub (normal process)
6. Close PR2 and PR3 on GitHub (they were merged locally)
```

### Key Differences from GitHub Squash Merge

| | GitHub squash (broken) | Local merge (proposed) |
|---|---|---|
| Where squash happens | Remote only | Local |
| Local branch has all code | No — squash commits on remote | Yes — always |
| Safe to rebase after | No — loses squash commits | Yes — everything is local |
| Can verify before push | No — blind trust | Yes — full local diff |

### Script Inputs

- Stack name (from metadata) or auto-detect from current branch
- Reads `.git/gh-stack-metadata.json` for branch order and PR numbers

### Script Flow

```bash
tmp/gh-stack-merge [stack-name]

# 1. Read stack metadata, build ordered branch list
# 2. Verify: all PRs approved? warn if not
# 3. Prompt: "Merge stack top-down? [y/n]"
# 4. For each branch from top to bottom (skip the base PR):
#    a. git checkout <parent-branch>
#    b. git merge --squash <child-branch>
#    c. git commit with squash message including PR number
#    d. echo "Merged <child> into <parent>"
# 5. Optionally rebase base PR onto main
# 6. Show final diff summary
# 7. Prompt: "Push and create/update PR? [y/n]"
```

### Edge Cases to Handle

- **Merge conflicts during squash**: Stop and let user resolve, then continue
- **Dirty working tree**: Require clean state or --stash flag
- **Branch not up to date**: Warn if remote has commits not in local
- **Already merged PRs**: Skip branches whose PRs are already merged/closed
- **Single PR stack**: Just rebase on main, nothing to squash

### Post-Merge Cleanup

- Close intermediate PRs on GitHub (with comment linking to base PR)
- Update stack metadata (remove merged branches)
- Optionally delete local and remote branches

### Safety Checks

- Never force-push main
- Verify branch is in the stack metadata before operating
- Show diff stats before each squash commit
- Dry-run mode: `--dry-run` to preview without executing

## Alternative Considered: Pull Before Rebase

Instead of a local merge script, we could modify `burs` to also pull the
current branch before rebasing:

```bash
# In bin/update, before the rebase:
git fetch origin "$current_branch"
git merge origin/"$current_branch" --ff-only  # get any squash commits
git rebase origin/main
```

This is simpler but less controlled — you're still relying on GitHub's squash
merge behavior and hoping the fetch catches everything.

## Status

- [ ] Design script
- [ ] Implement `tmp/gh-stack-merge`
- [ ] Test with a real stack
- [ ] Update `using-gh-stack-tools` skill
- [ ] Consider adding `--pull` flag to `burs` as a safety net
