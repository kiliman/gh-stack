// Git command helpers using Bun's shell API
import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import pc from "picocolors";

export const STACK_SYNC_TAG_PREFIX = "stack-sync-base";
export const STACK_SYNC_TAG_GLOB = `${STACK_SYNC_TAG_PREFIX}-*`;

// ── Lock contention (#69) ──────────────────────────────────────────────────
//
// Git doesn't wait for a lock: a checkout, rebase or config write that finds
// `index.lock` (or `config.lock`, a ref lock) already present fails at once.
// The usual holder is a background reader (an editor's or agent's `git
// status`) that grabs index.lock for a few milliseconds to save a refreshed
// stat cache, so the lock is gone almost immediately. Every gh-stack git call
// that takes a lock goes through runGit, which waits and retries instead.

/** git's message for a lock file that already exists (lockfile.c). */
const LOCK_HELD = /Unable to create '([^']+\.lock)': File exists/;

/** Waits between attempts: quick at first, then backing off (~5 s in all). */
const DEFAULT_LOCK_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 2000];
let lockRetryDelaysMs = DEFAULT_LOCK_RETRY_DELAYS_MS;

/** Shorten the retry schedule in tests; `null` restores the default. */
export function setLockRetryDelays(delays: number[] | null): void {
  lockRetryDelaysMs = delays ?? DEFAULT_LOCK_RETRY_DELAYS_MS;
}

/** The lock file another process holds, if git's output says one blocked it. */
export function heldLock(output: string): string | null {
  return LOCK_HELD.exec(output)?.[1] ?? null;
}

/**
 * A lock was still held after every retry. Nothing conflicted: the step can
 * simply run again once the other git process lets go.
 */
export class GitLockError extends Error {
  constructor(
    readonly lockPath: string,
    readonly command: string,
    /** The lock interrupted a rebase midway; it's paused, not conflicted. */
    readonly rebaseInProgress: boolean,
    /** How long gh-stack waited for it before giving up. */
    readonly waitedMs: number,
  ) {
    super(`another git process holds ${lockPath} (${command})`);
    this.name = "GitLockError";
  }
}

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `git <args>`, retrying while another process holds a lock it needs.
 * Retrying is safe because git takes the lock before changing anything: the
 * failed attempt left the repo as it was. Throws GitLockError when retries
 * run out; any other failure is returned for the caller to judge.
 *
 * `echo` replays git's output to the terminal (rebase progress and conflict
 * messages), leaving out the attempts a lock blocked.
 */
export async function runGit(args: string[], opts: { echo?: boolean } = {}): Promise<GitResult> {
  return retryLocks(args, opts.echo ?? false, async () => ({ next: args }));
}

/** Run `git <args>` with lock retries, throwing if it fails for another reason. */
export async function runGitOrThrow(args: string[], opts: { echo?: boolean } = {}): Promise<void> {
  const { exitCode, stderr } = await runGit(args, opts);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

interface Retry {
  next: string[];
  /** The retry resumes a rebase that a lock paused midway. */
  resumesRebase?: boolean;
}

/**
 * A rebase, retried around lock contention. A lock held when the rebase
 * starts fails it before anything happens ("could not detach HEAD"), so it
 * runs again as is. A lock that turns up midway makes git reschedule the
 * pick it couldn't apply and pause, with nothing conflicted: `git rebase
 * --continue` picks it up. Returns false only for a real conflict.
 * (Exported for tests; commands use rebaseOnto and rebase.)
 */
export async function runRebase(args: string[]): Promise<boolean> {
  const result = await retryLocks(args, true, async () => {
    if (!(await isRebaseInProgress())) return { next: args };
    // A conflict leaves unmerged paths; a lock-paused rebase doesn't.
    if (await hasUnmergedPaths()) return null;
    return { next: ["rebase", "--continue"], resumesRebase: true };
  });
  return result.exitCode === 0;
}

/**
 * The retry loop. When an attempt fails because a lock is held, `onLocked`
 * returns the command to retry with (or null to stop and return the failure).
 */
async function retryLocks(
  args: string[],
  echo: boolean,
  onLocked: () => Promise<Retry | null>,
): Promise<GitResult> {
  let retry: Retry = { next: args };
  let announced = false;
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    let shell = $`git ${retry.next}`.quiet().nothrow();
    // Resuming a lock-paused pick reuses the commit's message; never stop to
    // open an editor for it.
    if (retry.resumesRebase) shell = shell.env({ ...process.env, GIT_EDITOR: "true" });
    const raw = await shell;
    const result = {
      exitCode: raw.exitCode,
      stdout: raw.stdout.toString(),
      stderr: raw.stderr.toString(),
    };

    const lock = result.exitCode === 0 ? null : heldLock(result.stderr);
    const next = lock ? await onLocked() : null;
    if (!lock || !next) {
      if (echo) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
      }
      return result;
    }

    const delay = lockRetryDelaysMs[attempt];
    if (delay === undefined) {
      throw new GitLockError(lock, `git ${args.join(" ")}`, next.resumesRebase ?? false, waitedMs);
    }
    if (!announced) {
      console.error(pc.dim(`  Another git process holds ${lock}; waiting for it to finish…`));
      announced = true;
    }
    await Bun.sleep(delay);
    waitedMs += delay;
    retry = next;
  }
}

/** Whether the index has unmerged (conflicted) entries. */
async function hasUnmergedPaths(): Promise<boolean> {
  const out = await $`git diff --name-only --diff-filter=U`.quiet().nothrow().text();
  return out.trim() !== "";
}

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
 * Absolute path to this worktree's git dir. `gitDir()` is relative (`.git`) in
 * the main checkout, which can't identify a worktree from another one.
 */
export async function absoluteGitDir(): Promise<string> {
  const result = await $`git rev-parse --absolute-git-dir`.text();
  return result.trim();
}

/**
 * Get the absolute path to the repository's working-tree root.
 */
export async function repoRoot(): Promise<string> {
  const result = await $`git rev-parse --show-toplevel`.text();
  return result.trim();
}

/**
 * Check if working tree is clean (no uncommitted changes).
 * Refreshes the index first to avoid false positives from stale stat info.
 */
export async function isCleanWorkingTree(): Promise<boolean> {
  // Refresh index to avoid false positives from stat changes (timestamps, etc.).
  // Outside the try: a lock that never frees must surface, not read as dirty.
  // No -q: it also hides the lock message, and a refresh the lock blocked
  // leaves stale stat info that makes a clean tree look dirty. The output
  // ("needs update" lines) is captured and dropped.
  await runGit(["update-index", "--refresh"]);
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
 * Checkout a branch. Throws on failure — only use this where a failure is
 * unexpected (e.g. after ensureCleanWorkingTree). For user-facing branch
 * switching, prefer tryCheckout so a dirty-tree refusal can be rendered as a
 * clean message instead of a stack trace.
 */
export async function checkout(branch: string): Promise<void> {
  await runGitOrThrow(["checkout", branch]);
}

/**
 * Attempt to checkout a branch without throwing. Returns whether it succeeded
 * and git's stderr (which carries the "local changes would be overwritten"
 * message and the offending file list when a dirty tree blocks the switch).
 */
export async function tryCheckout(branch: string): Promise<{ ok: boolean; stderr: string }> {
  const { exitCode, stderr } = await runGit(["checkout", branch]);
  return { ok: exitCode === 0, stderr };
}

/**
 * Create and checkout a new branch from the current HEAD.
 */
export async function createBranch(name: string): Promise<void> {
  await runGitOrThrow(["checkout", "-b", name], { echo: true });
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

export type PushResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * `not-integrated`: origin's tip was fetched but isn't in the local
       * branch's history (--force-if-includes refused). `stale-lease`: origin
       * moved since the last fetch. `rejected`: anything else.
       */
      reason: "not-integrated" | "stale-lease" | "rejected";
      /**
       * git's stdout and stderr together. A local pre-push hook's output lands
       * on either, depending on the git version (stdout as of git 2.56).
       */
      output: string;
      /** Where a `rejected` push's full output was saved, when that worked. */
      logFile?: string;
    };

/** How many lines of a failed push's output `pushFailureHint` shows. */
const PUSH_OUTPUT_TAIL = 20;

/**
 * The one way gh-stack force-pushes a branch (restack, sync, merge's advance,
 * submit, join). Sets upstream, and works whether or not the branch exists on
 * origin yet.
 *
 * By default it's `--force-with-lease --force-if-includes`: the lease refuses
 * if origin moved since the last fetch, and --force-if-includes refuses if the
 * fetched tip was never brought into the local branch. That second check is
 * #28's root cause (a collapse's squash commit fetched, never pulled, then
 * overwritten), covered here for every command.
 *
 * `expect` gives the lease an explicit remote sha instead. Use it only for a
 * tip whose content was checked first (see lib/remote-guard.ts): git makes
 * --force-if-includes a no-op then, and the push still fails if origin moved
 * off that sha.
 */
export async function forcePushWithLease(
  branch: string,
  opts: { expect?: string } = {},
): Promise<PushResult> {
  const lease = opts.expect
    ? `--force-with-lease=refs/heads/${branch}:${opts.expect}`
    : "--force-with-lease";
  const { exitCode, stdout } =
    await $`git push -u ${lease} --force-if-includes origin ${branch} 2>&1`.nothrow().quiet();
  if (exitCode === 0) return { ok: true };
  const output = stdout.toString();
  const reason = output.includes("remote ref updated since checkout")
    ? "not-integrated"
    : output.includes("stale info")
      ? "stale-lease"
      : "rejected";
  if (reason !== "rejected") return { ok: false, reason, output };
  return { ok: false, reason, output, logFile: await savePushFailure(output) };
}

/**
 * Save a failed push's full output to `.git/.gh-stack/push-failure.log`. A
 * failing pre-push hook (a test suite, say) can print a thousand lines, so
 * `pushFailureHint` shows only the end and points here for the rest. Best
 * effort: a failed write returns undefined.
 */
async function savePushFailure(text: string): Promise<string | undefined> {
  try {
    const dir = `${await gitDir()}/.gh-stack`;
    await mkdir(dir, { recursive: true });
    const file = `${dir}/push-failure.log`;
    await Bun.write(file, text);
    return file;
  } catch {
    return undefined;
  }
}

/** Why a force-push was refused, and what to do, in gh-stack terms (plain lines). */
export function pushFailureHint(branch: string, result: PushResult): string[] {
  if (result.ok) return [];
  switch (result.reason) {
    case "not-integrated":
      return [
        `origin/${branch} has commits you fetched but never brought into local ${branch}, so git refused to overwrite them (--force-if-includes).`,
        `That's how a collapsed PR's squash commit gets lost (#28). See them: git log ${branch}..origin/${branch}`,
        `Bring them in (git pull --rebase origin ${branch}, or cherry-pick), then retry.`,
        `To drop them on purpose: gh-stack restack --overwrite-remote`,
      ];
    case "stale-lease":
      return [
        `origin/${branch} moved since your last fetch, so the lease refused.`,
        `Look at what's there first: git fetch origin ${branch} && git log ${branch}..origin/${branch}`,
      ];
    default: {
      // Show the end of git's output, not just its "failed to push" line: a
      // local pre-push hook prints its reason above that line, and a remote
      // rejection names the rule that refused the push.
      const lines = result.output.split("\n").filter((l) => l.trim() !== "");
      const tail = lines.slice(-PUSH_OUTPUT_TAIL);
      const hint = ["git push failed. The end of its output (a pre-push hook prints here too):"];
      hint.push(...tail.map((l) => `  ${l.trimEnd()}`));
      if (result.logFile && lines.length > tail.length) {
        hint.push(`Full output (${lines.length} lines): ${result.logFile}`);
      }
      return hint;
    }
  }
}

/**
 * Fetch commits from origin without moving any ref: no remote-tracking ref
 * update (`--refmap=`) and no FETCH_HEAD. The tracking refs are what
 * `--force-with-lease` and `--force-if-includes` compare against, so a check
 * that needs origin's objects must never advance them.
 */
export async function fetchObjectsOnly(refs: string[]): Promise<boolean> {
  if (refs.length === 0) return true;
  const { exitCode } = await $`git fetch --quiet --no-write-fetch-head --refmap= origin ${refs}`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

/**
 * Read the actual tip sha of every branch on origin in a single `ls-remote`
 * call. This queries the remote directly, so it is **authoritative** — unlike
 * `rev-parse origin/<branch>`, which reads the local remote-tracking ref that a
 * force-push can leave stale (a fresh fetch would correct it). Use this when a
 * correct answer about the remote's real state matters (e.g. the post-restack
 * sync verification — #23). Returns a map of branch name → sha.
 */
export async function remoteHeads(): Promise<Map<string, string>> {
  const heads = new Map<string, string>();
  const { exitCode, stdout } = await $`git ls-remote --heads origin`.nothrow().quiet();
  if (exitCode !== 0) return heads;
  const prefix = "refs/heads/";
  for (const line of stdout.toString().split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const sha = line.slice(0, tab).trim();
    const ref = line.slice(tab + 1).trim();
    if (sha && ref.startsWith(prefix)) heads.set(ref.slice(prefix.length), sha);
  }
  return heads;
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
 * Delete a local branch. Uses -D (force) since stacked branches are
 * routinely rebased and won't appear "merged" to git. Returns false if
 * the branch didn't exist or the delete failed.
 */
export async function deleteLocalBranch(branch: string): Promise<boolean> {
  const { exitCode } = await runGit(["branch", "-D", branch]);
  return exitCode === 0;
}

/**
 * Rename a local branch (`git branch -m`). Git moves the whole `branch.<old>`
 * config section to `branch.<new>`, so gh-stack membership rides along for free.
 * Returns false if the rename failed (e.g. the new name already exists).
 */
export async function renameBranch(oldName: string, newName: string): Promise<boolean> {
  const { exitCode } = await runGit(["branch", "-m", oldName, newName]);
  return exitCode === 0;
}

/**
 * Delete a branch on the remote (origin). Returns false on failure.
 */
export async function deleteRemoteBranch(branch: string): Promise<boolean> {
  const { exitCode } = await $`git push origin --delete ${branch}`.nothrow().quiet();
  return exitCode === 0;
}

/**
 * Create a temporary tag at a specific commit.
 */
export async function createTag(name: string, commit: string): Promise<void> {
  await runGitOrThrow(["tag", "-f", name, commit]);
}

/**
 * Delete tags matching a pattern.
 */
export async function deleteTagsMatching(pattern: string): Promise<void> {
  try {
    const result = await $`git tag -l ${pattern}`.text();
    const tags = result.trim().split("\n").filter(Boolean);
    for (const tag of tags) {
      await runGitOrThrow(["tag", "-d", tag]);
    }
  } catch {
    // No tags to delete — that's fine
  }
}

/**
 * Whether a ref (branch, tag, remote-tracking ref, or any revision) resolves.
 */
export async function refExists(ref: string): Promise<boolean> {
  const { exitCode } = await $`git rev-parse --verify --quiet ${ref}`.nothrow().quiet();
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
  return runRebase(["rebase", "--onto", newBase, oldBase, branch]);
}

/**
 * Move the current branch's ref to `ref` (working tree included).
 * Returns true if successful. Caller must have verified the tree is clean.
 */
export async function resetHard(ref: string): Promise<boolean> {
  const { exitCode } = await runGit(["reset", "--hard", ref]);
  return exitCode === 0;
}

/**
 * Simple rebase onto a target.
 * Returns true if successful, false if conflicts occurred.
 */
export async function rebase(target: string): Promise<boolean> {
  return runRebase(["rebase", target]);
}

/**
 * Squash-merge a branch into the current branch.
 * Returns true if successful.
 */
export async function mergeSquash(branch: string): Promise<boolean> {
  const { exitCode } = await runGit(["merge", "--squash", branch], { echo: true });
  return exitCode === 0;
}

/**
 * Commit with a message.
 */
export async function commit(message: string): Promise<void> {
  await runGitOrThrow(["commit", "-m", message], { echo: true });
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
 * Get all local branch names.
 */
export async function allLocalBranches(): Promise<string[]> {
  const result = await $`git branch --format=${"%(refname:short)"}`.text();
  return result.trim().split("\n").filter(Boolean);
}

/**
 * Map every local branch to its tip SHA, in one call.
 */
export async function localBranchTips(): Promise<Map<string, string>> {
  const result =
    await $`git for-each-ref --format=${"%(refname:short) %(objectname)"} refs/heads`.text();
  const tips = new Map<string, string>();
  for (const line of result.trim().split("\n").filter(Boolean)) {
    const [name, sha] = line.split(" ");
    if (name && sha) tips.set(name, sha);
  }
  return tips;
}

/**
 * Determine the trunk branch name. Prefers "main", falls back to "master"
 * if only that exists locally. Defaults to "main" when neither is present.
 */
export async function trunkBranch(): Promise<string> {
  if (await localBranchExists("main")) return "main";
  if (await localBranchExists("master")) return "master";
  return "main";
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
