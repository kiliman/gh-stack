// Git command helpers using Bun's shell API
import { $ } from "bun";
import { createHash } from "node:crypto";

export const STACK_SYNC_TAG_PREFIX = "stack-sync-base";
export const STACK_SYNC_TAG_GLOB = `${STACK_SYNC_TAG_PREFIX}-*`;

/**
 * Get the current branch name.
 * Throws if in detached HEAD state.
 */
export async function currentBranch(): Promise<string> {
  const result = await $`git rev-parse --abbrev-ref HEAD`.text();
  const branch = result.trim();
  if (branch === "HEAD") {
    throw new Error("Detached HEAD state — please checkout a branch first");
  }
  return branch;
}

/**
 * Check if we're inside a git repository.
 */
export async function isGitRepo(): Promise<boolean> {
  try {
    await $`git rev-parse --git-dir`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the path to the .git directory (handles worktrees too).
 */
export async function gitDir(): Promise<string> {
  const result = await $`git rev-parse --git-dir`.text();
  return result.trim();
}

/**
 * Check if working tree is clean (no uncommitted changes).
 */
export async function isCleanWorkingTree(): Promise<boolean> {
  try {
    await $`git diff-index --quiet HEAD --`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a rebase is currently in progress.
 */
export async function isRebaseInProgress(): Promise<boolean> {
  const dir = await gitDir();

  // Check if either directory exists by trying to read a known file
  try {
    const stat1 = await Bun.file(`${dir}/rebase-merge/interactive`).exists();
    if (stat1) return true;
  } catch {}

  try {
    const stat2 = await Bun.file(`${dir}/rebase-apply/rebasing`).exists();
    if (stat2) return true;
  } catch {}

  // Also check the directories themselves
  const { exitCode: code1 } = await $`test -d ${dir}/rebase-merge`.nothrow().quiet();
  const { exitCode: code2 } = await $`test -d ${dir}/rebase-apply`.nothrow().quiet();

  return code1 === 0 || code2 === 0;
}

/**
 * Checkout a branch.
 */
export async function checkout(branch: string): Promise<void> {
  await $`git checkout ${branch}`.quiet();
}

/**
 * Create and checkout a new branch from the current HEAD.
 */
export async function createBranch(name: string): Promise<void> {
  await $`git checkout -b ${name}`;
}

/**
 * Get the SHA of a ref.
 */
export async function revParse(ref: string): Promise<string> {
  const result = await $`git rev-parse ${ref}`.text();
  return result.trim();
}

/**
 * Get the merge-base of two refs.
 * Returns null if no common ancestor is found.
 */
export async function mergeBase(ref1: string, ref2: string): Promise<string | null> {
  try {
    const result = await $`git merge-base ${ref1} ${ref2}`.text();
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Check if ref1 is an ancestor of ref2.
 */
export async function isAncestor(ancestor: string, descendant: string): Promise<boolean> {
  const { exitCode } = await $`git merge-base --is-ancestor ${ancestor} ${descendant}`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

/**
 * Force-push a branch with lease protection.
 */
export async function forcePushWithLease(branch?: string): Promise<boolean> {
  try {
    if (branch) {
      await $`git push --force-with-lease origin ${branch}`;
    } else {
      await $`git push --force-with-lease`;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a branch exists on the remote.
 */
export async function remoteBranchExists(branch: string): Promise<boolean> {
  const { exitCode } = await $`git ls-remote --exit-code --heads origin ${branch}`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

/**
 * Check if a branch exists locally.
 */
export async function localBranchExists(branch: string): Promise<boolean> {
  const { exitCode } = await $`git show-ref --verify --quiet refs/heads/${branch}`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

/**
 * Create a temporary tag at a specific commit.
 */
export async function createTag(name: string, commit: string): Promise<void> {
  await $`git tag -f ${name} ${commit}`.quiet();
}

/**
 * Delete tags matching a pattern.
 */
export async function deleteTagsMatching(pattern: string): Promise<void> {
  try {
    const result = await $`git tag -l ${pattern}`.text();
    const tags = result.trim().split("\n").filter(Boolean);
    for (const tag of tags) {
      await $`git tag -d ${tag}`.quiet();
    }
  } catch {
    // No tags to delete — that's fine
  }
}

/**
 * Check if a tag exists.
 */
export async function tagExists(name: string): Promise<boolean> {
  const { exitCode } = await $`git rev-parse --verify ${name}`.nothrow().quiet();
  return exitCode === 0;
}

/**
 * Perform a rebase: rebase branch onto newBase, starting from oldBase.
 * Uses `git rebase --onto <newBase> <oldBase> <branch>`.
 * Returns true if successful, false if conflicts occurred.
 */
export async function rebaseOnto(
  newBase: string,
  oldBase: string,
  branch: string,
): Promise<boolean> {
  const { exitCode } = await $`git rebase --onto ${newBase} ${oldBase} ${branch}`.nothrow();
  return exitCode === 0;
}

/**
 * Simple rebase onto a target.
 * Returns true if successful, false if conflicts occurred.
 */
export async function rebase(target: string): Promise<boolean> {
  const { exitCode } = await $`git rebase ${target}`.nothrow();
  return exitCode === 0;
}

/**
 * Squash-merge a branch into the current branch.
 * Returns true if successful.
 */
export async function mergeSquash(branch: string): Promise<boolean> {
  const { exitCode } = await $`git merge --squash ${branch}`.nothrow();
  return exitCode === 0;
}

/**
 * Commit with a message.
 */
export async function commit(message: string): Promise<void> {
  await $`git commit -m ${message}`;
}

/**
 * Fetch origin main.
 */
export async function fetchMain(): Promise<void> {
  await $`git fetch origin main`.quiet();
}

/**
 * Get count of commits between two refs.
 */
export async function commitCount(from: string, to: string): Promise<number> {
  try {
    const result = await $`git rev-list --count ${from}..${to}`.text();
    return parseInt(result.trim(), 10);
  } catch {
    return 0;
  }
}

/**
 * Build a deterministic temp tag name for a branch.
 * Includes a readable slug plus a stable hash to avoid collisions.
 */
export function tempBaseTagName(branch: string): string {
  const slug =
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "branch";
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 10);
  return `${STACK_SYNC_TAG_PREFIX}-${slug}-${hash}`;
}
