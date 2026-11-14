// Git command helpers using Bun's shell API
import { $ } from "bun";
import { createHash } from "node:crypto";
import { appendFile, mkdir, realpath, stat } from "node:fs/promises";
import pc from "picocolors";
import { type LandedCopy, landedCopy } from "./landed-copies.ts";

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
/**
 * `git config` words it differently, naming the config file rather than its
 * lock (and it already waits about a second on its own before failing).
 */
const CONFIG_LOCK_HELD = /could not lock config file (.+): File exists/;

/** Waits between attempts: quick at first, then backing off (~5 s in all). */
const DEFAULT_LOCK_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 2000];
let lockRetryDelaysMs = DEFAULT_LOCK_RETRY_DELAYS_MS;

/** Shorten the retry schedule in tests; `null` restores the default. */
export function setLockRetryDelays(delays: number[] | null): void {
  lockRetryDelaysMs = delays ?? DEFAULT_LOCK_RETRY_DELAYS_MS;
}

/** The lock file another process holds, if git's output says one blocked it. */
export function heldLock(output: string): string | null {
  const lock = LOCK_HELD.exec(output)?.[1];
  if (lock) return lock;
  const config = CONFIG_LOCK_HELD.exec(output)?.[1];
  return config ? `${config}.lock` : null;
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
    /** Who had it open when gh-stack gave up. */
    readonly holder: LockHolder,
    /** The other worktree the command ran in, if not this one (#78). */
    readonly worktree: string | null = null,
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
 * messages), leaving out the attempts a lock blocked. `cwd` runs it in
 * another worktree (#78).
 */
export async function runGit(
  args: string[],
  opts: { echo?: boolean; cwd?: string } = {},
): Promise<GitResult> {
  return retryLocks(args, opts.echo ?? false, opts.cwd, async () => ({ next: args }));
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
 * `cwd` runs it in the worktree that has the branch checked out (#78).
 * (Exported for tests; commands use rebaseBranch.)
 */
export async function runRebase(args: string[], cwd?: string): Promise<boolean> {
  const result = await retryLocks(args, true, cwd, async () => {
    if (!(await isRebaseInProgress(cwd))) return { next: args };
    // A conflict leaves unmerged paths; a lock-paused rebase doesn't.
    if (await hasUnmergedPaths(cwd)) return null;
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
  cwd: string | undefined,
  onLocked: () => Promise<Retry | null>,
): Promise<GitResult> {
  let retry: Retry = { next: args };
  let announced = false;
  let waitedMs = 0;
  let episode: LockEpisode | null = null;
  for (let attempt = 0; ; attempt++) {
    let shell = $`git ${retry.next}`.quiet().nothrow();
    if (cwd) shell = shell.cwd(cwd);
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
      await episode?.finish(result.exitCode === 0 ? "recovered" : "failed", attempt, waitedMs);
      return result;
    }

    const delay = lockRetryDelaysMs[attempt];
    if (delay === undefined) {
      // Who has it now? With lsof, nobody means a stale lock (a crashed git).
      const holder = await lockHolder(lock);
      await episode?.finish("gave-up", attempt, waitedMs, holder);
      throw new GitLockError(
        lock,
        `git ${args.join(" ")}`,
        next.resumesRebase ?? false,
        waitedMs,
        holder,
        cwd ?? null,
      );
    }
    if (!announced) {
      console.error(pc.dim(`  Another git process holds ${lock}; waiting for it to finish…`));
      announced = true;
      episode = startLockEpisode(lock, args);
    }
    await Bun.sleep(delay);
    waitedMs += delay;
    retry = next;
  }
}

// ── Who holds the lock (#71) ───────────────────────────────────────────────
//
// Every wait is logged to `.git/.gh-stack/lock-waits.log` (one JSON line per
// episode), with the process lsof found holding the lock. Git keeps the lock
// file open from taking the lock to committing it, so lsof sees any holder,
// including tools that use libgit2 and never show up in git's own trace2 log.

/** What lsof found: the holders, none (nobody has it open), or unknown (no lsof). */
export type LockHolder = { holders: string[] } | { unknown: true };

/**
 * Who has `lock` open right now, best effort: each holder as
 * "pid 123: git status --porcelain ← Code Helper (Plugin) ← Electron".
 */
export async function lockHolder(lock: string): Promise<LockHolder> {
  const lsof = await capture(["lsof", "-t", "--", lock]);
  // lsof exits 1 both for "nobody has it open" and for errors; a missing
  // binary throws (null). A file that's already gone has no holder either.
  if (lsof === null) return { unknown: true };
  const pids = lsof.stdout.split("\n").filter((p) => /^\d+$/.test(p.trim()));
  const holders: string[] = [];
  for (const pid of pids.slice(0, 3)) holders.push(await describeProcess(pid.trim()));
  return { holders };
}

/** "pid 123: <command> ← <parent> ← <grandparent>", from ps. */
async function describeProcess(pid: string): Promise<string> {
  const self = await capture(["ps", "-o", "ppid=,command=", "-p", pid]);
  const [ppid, ...command] = (self?.stdout.trim() ?? "").split(/\s+/);
  const chain: string[] = [];
  let parent = ppid;
  for (let i = 0; i < 3 && parent && parent !== "0" && parent !== "1"; i++) {
    const p = await capture(["ps", "-o", "ppid=,comm=", "-p", parent]);
    const [pp, ...comm] = (p?.stdout.trim() ?? "").split(/\s+/);
    if (!comm.length) break;
    chain.push(comm.join(" ").split("/").pop()!);
    parent = pp;
  }
  const what = command.join(" ").slice(0, 80) || "(exited)";
  return [`pid ${pid}: ${what}`, ...chain].join(" ← ");
}

/** Run a helper binary (lsof, ps) with a time limit; null if it can't run. */
async function capture(cmd: string[]): Promise<{ exitCode: number; stdout: string } | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout: 3000 });
    const stdout = await new Response(proc.stdout).text();
    return { exitCode: await proc.exited, stdout };
  } catch {
    return null;
  }
}

export function describeHolder(holder: LockHolder): string {
  if ("unknown" in holder) return "unknown (lsof unavailable)";
  return holder.holders.length ? holder.holders.join("; ") : "nobody has it open";
}

interface LockEpisode {
  finish(
    outcome: "recovered" | "failed" | "gave-up",
    attempt: number,
    waitedMs: number,
    holderAtEnd?: LockHolder,
  ): Promise<void>;
}

/**
 * Start logging a lock wait. The first holder lookup runs during the first
 * wait, so it costs no extra time; finish() writes the line. Never throws.
 */
function startLockEpisode(lock: string, args: string[]): LockEpisode {
  const time = new Date().toISOString();
  const firstHolder = lockHolder(lock);
  return {
    async finish(outcome, attempt, waitedMs, holderAtEnd) {
      try {
        const entry = {
          time,
          lock,
          worktree: (await $`git rev-parse --show-toplevel`.quiet().nothrow().text()).trim(),
          command: `git ${args.join(" ")}`,
          ghStack: process.argv.slice(2).join(" "),
          outcome,
          attempts: attempt + 1,
          waitedMs,
          holder: describeHolder(await firstHolder),
          ...(holderAtEnd ? { holderAtEnd: describeHolder(holderAtEnd) } : {}),
        };
        const dir = `${await absoluteGitDir()}/.gh-stack`;
        await mkdir(dir, { recursive: true });
        await appendFile(`${dir}/lock-waits.log`, `${JSON.stringify(entry)}\n`);
      } catch {
        // Diagnostics only: never let logging break the git step.
      }
    },
  };
}

/** Run a shell command in the worktree at `cwd`, or here when it's undefined. */
function inDir(shell: ReturnType<typeof $>, cwd: string | undefined): ReturnType<typeof $> {
  return cwd ? shell.cwd(cwd) : shell;
}

/** Whether the index has unmerged (conflicted) entries. */
async function hasUnmergedPaths(cwd?: string): Promise<boolean> {
  const out = await inDir($`git diff --name-only --diff-filter=U`, cwd)
    .quiet()
    .nothrow()
    .text();
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
export async function absoluteGitDir(cwd?: string): Promise<string> {
  const result = await inDir($`git rev-parse --absolute-git-dir`, cwd).text();
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
 * Check if working tree is clean (no uncommitted changes), here or in the
 * worktree at `cwd`. Untracked files don't count.
 * Refreshes the index first to avoid false positives from stale stat info.
 */
export async function isCleanWorkingTree(cwd?: string): Promise<boolean> {
  // Refresh index to avoid false positives from stat changes (timestamps, etc.).
  // Outside the try: a lock that never frees must surface, not read as dirty.
  // No -q: it also hides the lock message, and a refresh the lock blocked
  // leaves stale stat info that makes a clean tree look dirty. The output
  // ("needs update" lines) is captured and dropped.
  await runGit(["update-index", "--refresh"], { cwd });
  try {
    await inDir($`git diff-index --quiet HEAD --`, cwd).quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a rebase is currently in progress, here or in the worktree at `cwd`.
 */
export async function isRebaseInProgress(cwd?: string): Promise<boolean> {
  const dir = cwd ? await absoluteGitDir(cwd) : await gitDir();

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
 * `pushFailureHint` shows only part of it and points here for the rest. The
 * path is absolute, so it works from any directory (an agent's shell may sit
 * in a subfolder). Best effort: a failed write returns undefined.
 */
async function savePushFailure(text: string): Promise<string | undefined> {
  try {
    const dir = `${await absoluteGitDir()}/.gh-stack`;
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
      // rejection names the rule that refused the push. A hook that runs
      // several checks can fail early and then print pages of warnings, so the
      // lines that look like the failure come first when the end misses them.
      const lines = pushOutputLines(result.output);
      const tailStart = Math.max(0, lines.length - PUSH_OUTPUT_TAIL);
      const hint: string[] = [];
      const earlier = failureExcerpt(lines, tailStart);
      if (earlier.length > 0) {
        hint.push("git push failed. These lines above the end look like the failure:");
        hint.push(...earlier.map((l) => `  ${l}`));
        hint.push("The end of its output:");
      } else {
        hint.push("git push failed. The end of its output (a pre-push hook prints here too):");
      }
      hint.push(...lines.slice(tailStart).map((l) => `  ${l}`));
      if (result.logFile) hint.push(`Full output (${lines.length} lines): ${result.logFile}`);
      return hint;
    }
  }
}

/**
 * The one line that best says why a push was refused, for a one-line error
 * (`submit --json`'s message): the first line that looks like a failure, else
 * a runner's "script failed" line, else git's last line. Trimmed, with no
 * closing period, so it reads inside a sentence. Undefined for a lease
 * refusal, which pushFailureHint explains instead.
 */
export function pushFailureLine(result: PushResult): string | undefined {
  if (result.ok || result.reason !== "rejected") return undefined;
  const lines = pushOutputLines(result.output);
  const first = lines.find((l) => looksLikeFailure(l) && !isPushTrailer(l));
  const line = first ?? lines.find((l) => looksLikeFailure(l)) ?? lines.at(-1);
  return line?.trim().replace(/\.+$/, "") || undefined;
}

/** A failed push's output as display lines: no blank lines, no trailing space. */
function pushOutputLines(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
}

/** Most lines of the "look like the failure" excerpt shown above the tail. */
const FAILURE_EXCERPT_MAX = 24;
/** Lines of context kept around each failure line in that excerpt. */
const FAILURE_CONTEXT_BEFORE = 2;
const FAILURE_CONTEXT_AFTER = 2;

/**
 * Lines that mark a failed check in common hook output: a failure symbol at
 * the start (❌ in swarm's hook, × for a Biome error, ✖/✗/✘ elsewhere),
 * bun's `(fail)`, jest's `FAIL`, an error count or `error` word (tsc's
 * `error TS2322`), or a runner's failed/non-zero exit. A count of zero
 * ("0 errors", "0 fail") is a pass.
 */
const FAILURE_PATTERNS: RegExp[] = [
  /^\s*(❌|×|✖|✗|✘|💥)/u,
  /\(fail\)/,
  /^\s*FAIL\b/,
  /^\s*[1-9]\d* (fail|failed|failures?|errors?)\b/i,
  /\berror\b/i,
  /\b[1-9]\d* errors?\b/i,
  /\bfailed\b/i,
  /\bexit(ed)? (with )?(code|status) [1-9]/i,
  /\[remote rejected\]/,
];
const PASS_PATTERNS: RegExp[] = [/\b(0|no) (errors?|fail(ed|ures?)?)\b/i];

function looksLikeFailure(line: string): boolean {
  return FAILURE_PATTERNS.some((re) => re.test(line)) && !PASS_PATTERNS.some((re) => re.test(line));
}

/**
 * The generic lines every refused push ends with: git's "failed to push some
 * refs", and a hook runner's "script failed" (husky, pnpm's ELIFECYCLE, bun
 * run). They say *that* the hook failed, never which check, so they don't
 * count as the failure when a more specific line exists.
 */
function isPushTrailer(line: string): boolean {
  return (
    line.startsWith("error: failed to push some refs") ||
    /^husky - .*failed/.test(line) ||
    /ELIFECYCLE/.test(line) ||
    /^error: script ".*" exited with code/.test(line)
  );
}

/**
 * The failure lines in `lines[0, end)` (the part the tail doesn't show), each
 * with a little context, overlapping windows merged and gaps marked with "…".
 * Capped at FAILURE_EXCERPT_MAX lines, earliest first: the first failure is
 * usually the cause, and the log has the rest.
 */
function failureExcerpt(lines: string[], end: number): string[] {
  const above = lines.slice(0, end);
  const keep = above.map(() => false);
  let kept = 0;
  for (const [i, line] of above.entries()) {
    if (kept >= FAILURE_EXCERPT_MAX) break;
    if (!looksLikeFailure(line) || isPushTrailer(line)) continue;
    const from = Math.max(0, i - FAILURE_CONTEXT_BEFORE);
    const to = Math.min(end - 1, i + FAILURE_CONTEXT_AFTER);
    for (let j = from; j <= to && kept < FAILURE_EXCERPT_MAX; j++) {
      if (!keep[j]) kept++;
      keep[j] = true;
    }
  }
  const out: string[] = [];
  let prev = -1;
  for (const [i, line] of above.entries()) {
    if (!keep[i]) continue;
    if (prev >= 0 && i > prev + 1) out.push("…");
    out.push(line);
    prev = i;
  }
  return out;
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

// ── Branches in use by another worktree (#78) ──────────────────────────────
//
// git won't check out or rebase a branch another worktree is using: "fatal:
// '<branch>' is already used by worktree at '<path>'". A worktree uses a branch
// while it has it checked out, and also while it's rebasing it (HEAD is
// detached then, so `git worktree list` shows no branch for it). gh-stack
// rewrites such a branch from its own worktree instead, and that worktree's
// files move along with it. That's only safe when the worktree is clean and
// not in the middle of something, so the rewrite checks right before it runs,
// and commands check every branch up front (safety.ensureWorktreesReady) so
// they can stop before changing anything.

export interface Worktree {
  path: string;
  /** The branch it's using (checked out, or being rebased), or null. */
  branch: string | null;
  /** Its folder is gone; git still counts its branch as in use until it's pruned. */
  missing: boolean;
}

/** Every worktree of this repo, with the branch each one is using. */
export async function listWorktrees(): Promise<Worktree[]> {
  const out = await $`git worktree list --porcelain`.quiet().nothrow().text();
  const worktrees: Worktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
    const missing = lines.some((l) => l.startsWith("prunable")) || !(await isDir(path));
    let branch = ref ? shortBranch(ref) : null;
    if (!branch && !missing) branch = await branchBeingRebased(path);
    worktrees.push({ path, branch, missing });
  }
  return worktrees;
}

/** The branches the other worktrees are using, each with its worktree. */
export async function branchesInOtherWorktrees(): Promise<Map<string, Worktree>> {
  const here = await canonicalPath(await repoRoot());
  const held = new Map<string, Worktree>();
  for (const wt of await listWorktrees()) {
    if (wt.branch && (await canonicalPath(wt.path)) !== here) held.set(wt.branch, wt);
  }
  return held;
}

/** The worktree, other than this one, that's using `branch`; null when none is. */
export async function worktreeHolding(branch: string): Promise<Worktree | null> {
  return (await branchesInOtherWorktrees()).get(branch) ?? null;
}

export interface WorktreeProblem {
  /** Completes "…, and <problem>", e.g. "it has uncommitted changes". */
  problem: string;
  /** Commands that clear it, run from anywhere. */
  fixes: string[];
}

/**
 * Why a branch can't be rewritten in `wt` right now, with the commands that
 * clear it; null when it can.
 */
export async function worktreeProblem(wt: Worktree): Promise<WorktreeProblem | null> {
  const at = shellQuote(wt.path);
  if (wt.missing) {
    return {
      problem: "its folder is gone",
      fixes: ["git worktree prune   (forgets the missing worktree, which frees the branch)"],
    };
  }
  const op = await operationInProgress(wt.path);
  if (op) {
    return {
      problem: `it's in the middle of a ${op}`,
      fixes: [`git -C ${at} ${op} --continue`, `git -C ${at} ${op} --abort`],
    };
  }
  if (!(await isCleanWorkingTree(wt.path))) {
    return {
      problem: "it has uncommitted changes",
      fixes: [`git -C ${at} stash   (or commit them there)`],
    };
  }
  return null;
}

/** The refusal for a branch whose worktree isn't ready, fixes included. */
export function describeBlockedBranch(
  branch: string,
  wt: Worktree,
  why: WorktreeProblem,
): string[] {
  return [
    `${pc.yellow(branch)} is checked out in the worktree at ${wt.path}, and ${why.problem}.`,
    ...why.fixes.map((fix) => `    ${pc.green(fix)}`),
  ];
}

/**
 * A rewrite found the branch's worktree not ready. Commands check up front,
 * so this only fires when the worktree changed while the command ran.
 */
export class WorktreeBusyError extends Error {
  constructor(
    readonly branch: string,
    readonly worktree: Worktree,
    readonly why: WorktreeProblem,
  ) {
    super(`${branch} is checked out in the worktree at ${worktree.path}, and ${why.problem}`);
    this.name = "WorktreeBusyError";
  }
}

/** Where a rewrite ran: `worktree` is the other worktree's path, or null for this one. */
export interface RewriteResult {
  ok: boolean;
  worktree: string | null;
  /** Commits the rebase skipped because the target already had them (#79). */
  skipped?: LandedCopy[];
}

/**
 * Rebase `branch` onto `onto`, replaying the commits after `from`
 * (`git rebase --onto`), or with `from` null every commit `onto` lacks. Runs
 * in the worktree that has the branch checked out if another one does (#78);
 * otherwise checks it out here first. `ok` is false for a conflict, which
 * stays paused in the worktree the rebase ran in.
 */
export async function rebaseBranch(
  branch: string,
  onto: string,
  from: string | null,
): Promise<RewriteResult> {
  const args = from ? ["rebase", "--onto", onto, from] : ["rebase", onto];
  // The branch ref stays on its old tip until the rebase finishes, so it
  // bounds what `onto` gained when there's no explicit `from`.
  const since = from ?? (await revParse(branch));
  const skipped: LandedCopy[] = [];
  const wt = await readyWorktreeFor(branch);
  if (!wt) {
    await checkout(branch);
    const ok =
      (await runRebase([...args, branch])) || (await skipLandedCopies(onto, since, skipped));
    return { ok, worktree: null, skipped };
  }
  const ok = (await runRebase(args, wt)) || (await skipLandedCopies(onto, since, skipped, wt));
  return { ok, worktree: wt, skipped };
}

/**
 * A rebase onto `onto` stopped: while the commit it stopped on is a copy of a
 * change `onto` already has (#79, see landed-copies.ts), skip it, say so and
 * add it to `skipped`.
 * True once the rebase finishes; false when it stops on anything else, which
 * is left paused for the user like any conflict.
 */
async function skipLandedCopies(
  onto: string,
  since: string,
  skipped: LandedCopy[],
  cwd?: string,
): Promise<boolean> {
  let last: string | null = null;
  while (await isRebaseInProgress(cwd)) {
    const stopped = await stoppedCommit(cwd);
    // The same commit again means the skip itself failed: stop, don't spin.
    if (!stopped || stopped === last) return false;
    const copy = await landedCopy(stopped, onto, since, cwd);
    if (!copy) return false;
    reportSkippedCopy(copy, onto);
    skipped.push(copy);
    last = stopped;
    if (await runRebase(["rebase", "--skip"], cwd)) return true;
  }
  return false;
}

/** The commit a paused rebase stopped on (REBASE_HEAD), or null. */
async function stoppedCommit(cwd?: string): Promise<string | null> {
  const r = await inDir($`git rev-parse --verify -q REBASE_HEAD`, cwd)
    .quiet()
    .nothrow();
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

function reportSkippedCopy(copy: LandedCopy, ontoRef: string): void {
  // join rebases onto a sha; name it the way git's own output would.
  const onto = /^[0-9a-f]{40}$/.test(ontoRef) ? ontoRef.slice(0, 10) : ontoRef;
  console.log(`  ${pc.yellow("↷")} Skipped ${pc.yellow(copy.commit.slice(0, 10))} ${copy.subject}`);
  console.log(
    pc.dim(
      `    Already on ${onto} through ${copy.via.sha.slice(0, 10)} ${copy.via.subject} (${copy.present} of its ${copy.added} added lines are there).`,
    ),
  );
  if (copy.differs.length > 0) {
    console.log(pc.dim(`    Kept ${onto}'s version of ${copy.differs.join(", ")}.`));
  }
}

/**
 * Move `branch` to `ref`, files included, for a branch with no commits of its
 * own. Like rebaseBranch, it runs in the branch's worktree when another one
 * has it checked out.
 */
export async function resetBranch(branch: string, ref: string): Promise<RewriteResult> {
  const wt = await readyWorktreeFor(branch);
  if (!wt) {
    await checkout(branch);
    const { exitCode } = await runGit(["reset", "--hard", ref]);
    return { ok: exitCode === 0, worktree: null };
  }
  // --keep rather than --hard: in someone else's worktree it refuses instead
  // of overwriting anything.
  const { exitCode } = await runGit(["reset", "--keep", ref], { cwd: wt });
  return { ok: exitCode === 0, worktree: wt };
}

/**
 * Fast-forward `branch` to `ref`: in the worktree that has it checked out
 * (this one or another), otherwise by moving the ref, guarded on its current
 * tip. Fails rather than merging when it isn't a fast-forward.
 */
export async function fastForwardBranch(branch: string, ref: string): Promise<RewriteResult> {
  const wt = await readyWorktreeFor(branch);
  if (wt || (await currentBranch()) === branch) {
    const { exitCode } = await runGit(["merge", "--ff-only", "-q", ref], { cwd: wt ?? undefined });
    return { ok: exitCode === 0, worktree: wt };
  }
  const tip = await revParse(branch);
  if (!(await isAncestor(tip, ref))) return { ok: false, worktree: null };
  const { exitCode } = await runGit(["update-ref", `refs/heads/${branch}`, ref, tip]);
  return { ok: exitCode === 0, worktree: null };
}

/**
 * The path of the other worktree that has `branch` checked out, once it's
 * confirmed ready for the rewrite; null when no other worktree has it.
 */
async function readyWorktreeFor(branch: string): Promise<string | null> {
  const wt = await worktreeHolding(branch);
  if (!wt) return null;
  const why = await worktreeProblem(wt);
  if (why) throw new WorktreeBusyError(branch, wt, why);
  console.log(`  ${pc.yellow(branch)} is checked out in its worktree at ${wt.path}: working there`);
  return wt.path;
}

/** The rebase, merge, cherry-pick, revert or am the worktree at `path` is in the middle of. */
async function operationInProgress(path: string): Promise<string | null> {
  const dir = await absoluteGitDir(path).catch(() => null);
  if (!dir) return null;
  const has = (name: string) => Bun.file(`${dir}/${name}`).exists();
  if (await isDir(`${dir}/rebase-merge`)) return "rebase";
  if (await isDir(`${dir}/rebase-apply`)) {
    return (await has("rebase-apply/applying")) ? "am" : "rebase";
  }
  if (await has("MERGE_HEAD")) return "merge";
  if (await has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (await has("REVERT_HEAD")) return "revert";
  return null;
}

/** The branch the detached worktree at `path` is rebasing, if any. */
async function branchBeingRebased(path: string): Promise<string | null> {
  const dir = await absoluteGitDir(path).catch(() => null);
  if (!dir) return null;
  for (const name of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
    const file = Bun.file(`${dir}/${name}`);
    if (!(await file.exists())) continue;
    const ref = (await file.text()).trim();
    if (ref.startsWith("refs/heads/")) return shortBranch(ref);
  }
  return null;
}

function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

async function isDir(path: string): Promise<boolean> {
  return stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

/** The path with symlinks resolved (macOS's /tmp is /private/tmp), or as given if it's gone. */
async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/**
 * `git rebase`, aimed at the worktree a rebase stopped in when that's not this
 * one, for "resolve, then <cmd> --continue" advice.
 */
export function rebaseCommand(worktree: string | null): string {
  return worktree ? `git -C ${shellQuote(worktree)} rebase` : "git rebase";
}

/** `s` as one shell word, quoted only when it needs to be. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
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
