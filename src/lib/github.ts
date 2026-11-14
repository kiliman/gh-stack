// GitHub CLI (gh) helpers
import { $ } from "bun";
import type { PrInfo, PrStatus } from "../types.ts";

let cachedNwo: string | null | undefined; // undefined = not yet looked up

/**
 * Get the repository's `owner/name` (once, cached for the process). Used to
 * construct PR URLs locally — `https://github.com/<nwo>/pull/<n>` — so the
 * stack visualization doesn't need a per-PR API call just for links.
 * Returns null if it can't be resolved (links degrade to plain `#<n>`).
 */
export async function getRepoNwo(): Promise<string | null> {
  if (cachedNwo !== undefined) return cachedNwo;
  try {
    const out = (await $`gh repo view --json nameWithOwner --jq .nameWithOwner`.text()).trim();
    cachedNwo = out.length > 0 ? out : null;
  } catch {
    cachedNwo = null;
  }
  return cachedNwo;
}

/** Build a PR URL from a cached nwo (or null if nwo is unknown). */
export function prUrlFor(nwo: string | null, prNumber: number): string | null {
  return nwo ? `https://github.com/${nwo}/pull/${prNumber}` : null;
}

/**
 * Get PR number for a branch (auto-detect via gh).
 * Returns null if no PR exists.
 */
export async function getPrNumber(branch: string): Promise<number | null> {
  try {
    const result = await $`gh pr list --head ${branch} --json number --jq '.[0].number'`.text();
    const num = parseInt(result.trim(), 10);
    return isNaN(num) ? null : num;
  } catch {
    return null;
  }
}

/**
 * Find the open PR whose head is `branch`, for adopting a PR opened outside
 * gh-stack. Unlike getPrNumber, returns null unless there is exactly one match
 * — a fork with the same branch name must never be adopted by accident.
 */
export async function findOpenPrForBranch(branch: string): Promise<number | null> {
  try {
    const out =
      await $`gh pr list --head ${branch} --state open --json number --jq '.[].number'`.text();
    const nums = out
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => parseInt(n, 10));
    return nums.length === 1 && !isNaN(nums[0]!) ? nums[0]! : null;
  } catch {
    return null;
  }
}

/** `gh pr view` failed even after retries; the message is gh's last stderr line. */
export class PrFetchError extends Error {
  constructor(
    readonly pr: number,
    readonly detail: string,
  ) {
    super(`couldn't read PR #${pr} from GitHub: ${detail}`);
    this.name = "PrFetchError";
  }
}

/** Waits before the 2nd and 3rd `gh pr view` attempts. */
const PR_VIEW_RETRY_DELAYS_MS = [400, 1200];

/**
 * gh's answers that mean "there is no such PR here": the PR doesn't exist, or
 * the repo has no GitHub remote. Retrying won't change them.
 */
const NO_SUCH_PR = [
  /could not resolve to a pullrequest/i,
  /no pull requests found/i,
  /no git remotes found/i,
  /none of the git remotes configured for this repository/i,
  /not a git repository/i,
];

/** gh isn't logged in: the state is unknown, and retrying won't change that. */
const NOT_LOGGED_IN = [/gh auth login/i, /GH_TOKEN environment variable/i];

/**
 * `gh pr view <n> --json <fields>`, parsed. Null when GitHub answers that
 * there's no such PR (see NO_SUCH_PR).
 *
 * Any other failure is retried, then thrown as PrFetchError. gh fails
 * transiently more often than one would think: rate limits, network blips,
 * and concurrent calls through a `gh auth switch` wrapper colliding in the
 * keyring (#66). A caller that read such a failure as an answer ("not
 * approved", "not merged") would make a wrong decision silently.
 */
export async function ghPrViewJson(prNumber: number, fields: string): Promise<any | null> {
  const delays = PR_VIEW_RETRY_DELAYS_MS;
  let detail = "";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      // Jitter, so concurrent callers that collided don't collide again.
      await Bun.sleep(delays[attempt - 1]! + Math.floor(Math.random() * 200));
    }
    const { exitCode, stdout, stderr } = await $`gh pr view ${prNumber} --json ${fields}`
      .quiet()
      .nothrow();
    if (exitCode === 0) {
      try {
        return JSON.parse(stdout.toString().trim());
      } catch {
        // A successful call with unparseable output won't improve on retry.
        throw new PrFetchError(prNumber, "gh returned output that isn't JSON");
      }
    }
    const err = stderr.toString();
    // Checked first: "no GitHub remote" also mentions `gh auth login`.
    if (NO_SUCH_PR.some((re) => re.test(err))) return null;
    const lines = err
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    detail = lines.length > 0 ? lines.join(" / ") : `gh exited with status ${exitCode}`;
    if (NOT_LOGGED_IN.some((re) => re.test(err))) break;
  }
  throw new PrFetchError(prNumber, detail);
}

/**
 * Get PR info for a specific PR number; null when there's no such PR. Throws
 * PrFetchError when GitHub can't be read, so callers can't mistake a failed
 * fetch for a PR's state.
 */
export async function fetchPrInfo(prNumber: number): Promise<PrInfo | null> {
  const data = await ghPrViewJson(
    prNumber,
    "number,title,state,reviewDecision,isDraft,url,updatedAt,statusCheckRollup",
  );
  if (data == null) return null;
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    reviewDecision: data.reviewDecision || null,
    isDraft: data.isDraft || false,
    url: data.url,
    updatedAt: data.updatedAt,
    statusCheckRollup: data.statusCheckRollup || [],
  };
}

/**
 * Get PR info for a specific PR number, or null when it can't be read. For
 * callers where a missing answer is harmless (filling in a title); a caller
 * that decides something from the PR's state uses fetchPrInfo.
 */
export async function getPrInfo(prNumber: number): Promise<PrInfo | null> {
  try {
    return await fetchPrInfo(prNumber);
  } catch {
    return null;
  }
}

/**
 * Get all open PRs for the current user with full status info.
 */
export async function getMyOpenPrs(): Promise<PrStatus[]> {
  try {
    const result =
      await $`gh pr list --author @me --state open --json number,title,headRefName,reviewDecision,statusCheckRollup,isDraft,state,updatedAt,url --limit 50`.text();
    const data = JSON.parse(result.trim()) as any[];

    return data.map((pr) => {
      const checks = pr.statusCheckRollup || [];
      const validChecks = checks.filter((c: any) => c.name != null);
      const passed = validChecks.filter(
        (c: any) => c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL",
      ).length;
      const failed = validChecks.filter(
        (c: any) =>
          c.conclusion === "FAILURE" ||
          c.conclusion === "CANCELLED" ||
          c.conclusion === "TIMED_OUT",
      ).length;
      const pending = validChecks.filter(
        (c: any) => c.status === "IN_PROGRESS" || c.status === "QUEUED" || c.status === "PENDING",
      ).length;
      const failedNames = validChecks
        .filter(
          (c: any) =>
            c.conclusion === "FAILURE" ||
            c.conclusion === "CANCELLED" ||
            c.conclusion === "TIMED_OUT",
        )
        .map((c: any) => c.name)
        .slice(0, 3);

      return {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        reviewDecision: pr.reviewDecision || null,
        isDraft: pr.isDraft || false,
        url: pr.url,
        updatedAt: pr.updatedAt,
        headRefName: pr.headRefName,
        statusCheckRollup: checks,
        totalChecks: validChecks.length,
        passedChecks: passed,
        failedChecks: failed,
        pendingChecks: pending,
        failedNames,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Update a PR's body (description).
 */
export async function updatePrBody(prNumber: number, body: string): Promise<boolean> {
  try {
    // Write to a temp file to avoid shell escaping issues
    const tmpFile = `${await import("node:os").then((os) => os.tmpdir())}/gh-stack-pr-body-${prNumber}.md`;
    await Bun.write(tmpFile, body);
    await $`gh pr edit ${prNumber} --body-file ${tmpFile}`.quiet();
    const { unlink } = await import("node:fs/promises");
    await unlink(tmpFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Update a PR's title.
 */
export async function updatePrTitle(prNumber: number, title: string): Promise<boolean> {
  try {
    await $`gh pr edit ${prNumber} --title ${title}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Repoint a PR's base branch on GitHub (`gh pr edit --base <base>`). Used when a
 * stack advances past a merged bottom: the new bottom PR must retarget `main`.
 * Returns false on failure.
 */
export async function setPrBase(prNumber: number, base: string): Promise<boolean> {
  try {
    await $`gh pr edit ${prNumber} --base ${base}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get body text for a PR.
 */
export async function getPrBody(prNumber: number): Promise<string | null> {
  try {
    const result = await $`gh pr view ${prNumber} --json body --jq '.body'`.text();
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Get the merge state of a PR.
 * Returns { state, mergeable, mergeStateStatus, headRefName, headRefOid }.
 *
 * NOTE: `mergeable`/`mergeStateStatus` are computed against the PR's *recorded*
 * head (`headRefOid`), which GitHub occasionally fails to advance after a child
 * squash-merge lands on this branch. Compare `headRefOid` against the live ref
 * (`getBranchRefSha`) to detect that staleness — see `merge.ts`.
 */
/** A PR's merge state, plus what merging it left behind. */
export interface PrMergeResult {
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  headRefName: string;
  /** The PR's head; for a merged PR, its head when it merged. */
  headRefOid: string;
  /** The branch it targets (or merged into). */
  baseRefName: string;
  /** The commit merging it created on its base (for a squash merge, the squash commit). */
  mergeCommit: string | null;
  /** When it merged (ISO 8601); null if it hasn't. */
  mergedAt: string | null;
}

/**
 * A PR's merge state; null when there's no such PR. Throws PrFetchError when
 * GitHub can't be read (see ghPrViewJson).
 */
export async function fetchPrMergeState(prNumber: number): Promise<PrMergeResult | null> {
  const data = await ghPrViewJson(
    prNumber,
    "state,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,mergeCommit,mergedAt",
  );
  if (data == null) return null;
  return { ...data, mergeCommit: data.mergeCommit?.oid ?? null, mergedAt: data.mergedAt || null };
}

/** A PR's merge state, or null when it can't be read (after retries). */
export async function getPrMergeState(prNumber: number): Promise<PrMergeResult | null> {
  try {
    return await fetchPrMergeState(prNumber);
  } catch {
    return null;
  }
}

/** A commit as a patch (`git format-patch` style), from the GitHub API. Null if unavailable. */
export async function getCommitPatch(sha: string): Promise<string | null> {
  const nwo = await getRepoNwo();
  if (!nwo) return null;
  const { stdout, exitCode } =
    await $`gh api -H ${"Accept: application/vnd.github.patch"} repos/${nwo}/commits/${sha}`
      .nothrow()
      .quiet();
  const text = stdout.toString();
  return exitCode === 0 && text.trim() ? text : null;
}

/**
 * The files a commit changed (path, status, blob sha after the commit), from
 * the GitHub API. Null if unavailable, or if GitHub truncated the list (it
 * returns at most 300 files): a partial list can't prove anything.
 */
export async function getCommitFiles(
  sha: string,
): Promise<
  { filename: string; status: string; sha: string | null; before?: string | null }[] | null
> {
  const nwo = await getRepoNwo();
  if (!nwo) return null;
  const { stdout, exitCode } =
    await $`gh api repos/${nwo}/commits/${sha} --jq ${"[.files[] | {filename, status, sha}]"}`
      .nothrow()
      .quiet();
  if (exitCode !== 0) return null;
  try {
    const files: { filename: string; status: string; sha: string | null }[] = JSON.parse(
      stdout.toString(),
    );
    if (!Array.isArray(files) || files.length === 0 || files.length >= 300) return null;
    // The API gives no blob from before the commit, except that an added
    // file had none; a removed file has no blob after it.
    return files.map((f) => ({
      filename: f.filename,
      status: f.status,
      sha: f.status === "removed" ? null : f.sha,
      before: f.status === "added" ? null : undefined,
    }));
  } catch {
    return null;
  }
}

/**
 * Resolve the live SHA of a branch ref on the remote (`origin`), independent of
 * any PR's cached head. Returns null if the ref can't be resolved.
 */
export async function getBranchRefSha(branch: string): Promise<string | null> {
  const nwo = await getRepoNwo();
  if (!nwo) return null;
  try {
    const sha = (
      await $`gh api repos/${nwo}/git/ref/heads/${branch} --jq .object.sha`.text()
    ).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Force GitHub to re-read a PR's head branch by closing and immediately
 * reopening it. Used when the PR's recorded `headRefOid` is stuck behind the
 * live branch tip (a child squash-merge moved the branch but GitHub missed the
 * head-sync), which makes `mergePullRequest` reject a "Head branch is out of
 * date" even though every status read says the PR is clean.
 */
export async function resyncPrHead(prNumber: number): Promise<boolean> {
  try {
    await $`gh pr close ${prNumber}`.quiet();
    await $`gh pr reopen ${prNumber}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Close a PR with a comment.
 */
export async function closePr(prNumber: number, comment?: string): Promise<boolean> {
  try {
    if (comment) {
      await $`gh pr close ${prNumber} --comment ${comment}`.quiet();
    } else {
      await $`gh pr close ${prNumber}`.quiet();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get review decision emoji for display.
 */
export function reviewEmoji(decision: string | null | undefined): string {
  switch (decision) {
    case "APPROVED":
      return "\u2705"; // ✅
    case "CHANGES_REQUESTED":
      return "\u274C"; // ❌
    case "REVIEW_REQUIRED":
      return "\uD83D\uDC40"; // 👀
    default:
      return "\u23F3"; // ⏳
  }
}

/**
 * Get CI status emoji for display.
 */
export function ciEmoji(status: {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  pendingChecks: number;
}): { icon: string; text: string } {
  if (status.totalChecks === 0) {
    return { icon: "\u26AA", text: "No checks" };
  }
  if (status.failedChecks > 0) {
    return { icon: "\u274C", text: `${status.failedChecks} failed` };
  }
  if (status.pendingChecks > 0) {
    return { icon: "\uD83D\uDFE1", text: `${status.pendingChecks} running` };
  }
  if (status.passedChecks === status.totalChecks) {
    return {
      icon: "\u2705",
      text: `All passing (${status.totalChecks})`,
    };
  }
  return { icon: "\u26AA", text: "Unknown" };
}
