// GitHub CLI (gh) helpers
import { $ } from "bun";
import type { PrInfo, PrStatus } from "../types.ts";

/**
 * Get PR number for a branch (auto-detect via gh).
 * Returns null if no PR exists.
 */
export async function getPrNumber(branch: string): Promise<number | null> {
  try {
    const result =
      await $`gh pr list --head ${branch} --json number --jq '.[0].number'`.text();
    const num = parseInt(result.trim(), 10);
    return isNaN(num) ? null : num;
  } catch {
    return null;
  }
}

/**
 * Get PR info for a specific PR number.
 */
export async function getPrInfo(prNumber: number): Promise<PrInfo | null> {
  try {
    const result =
      await $`gh pr view ${prNumber} --json number,title,state,reviewDecision,isDraft,url,updatedAt,statusCheckRollup`.text();
    const data = JSON.parse(result.trim());
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
        (c: any) =>
          c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL"
      ).length;
      const failed = validChecks.filter(
        (c: any) =>
          c.conclusion === "FAILURE" ||
          c.conclusion === "CANCELLED" ||
          c.conclusion === "TIMED_OUT"
      ).length;
      const pending = validChecks.filter(
        (c: any) =>
          c.status === "IN_PROGRESS" ||
          c.status === "QUEUED" ||
          c.status === "PENDING"
      ).length;
      const failedNames = validChecks
        .filter(
          (c: any) =>
            c.conclusion === "FAILURE" ||
            c.conclusion === "CANCELLED" ||
            c.conclusion === "TIMED_OUT"
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
export async function updatePrBody(
  prNumber: number,
  body: string
): Promise<boolean> {
  try {
    // Write to a temp file to avoid shell escaping issues
    const tmpFile = `${await import("node:os").then((os) => os.tmpdir())}/git-stack-pr-body-${prNumber}.md`;
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
 * Get PR body text.
 */
export async function getPrBody(prNumber: number): Promise<string | null> {
  try {
    const result =
      await $`gh pr view ${prNumber} --json body --jq '.body'`.text();
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Close a PR with a comment.
 */
export async function closePr(
  prNumber: number,
  comment?: string
): Promise<boolean> {
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
export function reviewEmoji(
  decision: string | null | undefined
): string {
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
