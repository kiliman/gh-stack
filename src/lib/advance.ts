// Advancing a stack past merged bottom PRs.
//
// When the bottom PR of a stack lands on `main` — whether merged by
// `gh-stack merge --approved` or squash-merged outside the tool (the GitHub UI)
// — the rest of the stack must be *advanced*: drop the merged branch from the
// stack and re-root the new bottom onto `main`, replaying ONLY its own commits.
//
// The subtle part is the rebase fork-point. After a squash-merge, `main` carries
// a brand-new commit that is NOT in the child's history, so `merge-base(child,
// main)` resolves to the *original* fork — meaning a plain `git rebase main`
// would replay the already-squashed commits and conflict. The correct base is
// the merged branch's pre-merge tip; we resolve it exactly like `restack` does
// (snapshot pre-rewrite tip, falling back to `merge-base(child, mergedBranch)`)
// and rebase with `git rebase --onto main <merged-tip> <child>`.
//
// This module owns the planning (pure, unit-tested) and the per-step git/metadata
// mechanics. The GitHub squash-merge itself is injected by the caller so this
// stays free of `merge.ts`'s retry machinery.
import * as p from "./output.ts";
import pc from "picocolors";
import * as git from "./git.ts";
import type { StackMetadata } from "../types.ts";
import { removeBranchFromStack } from "./metadata.ts";
import { findPreRewriteSha } from "./snapshot.ts";
import { setPrBase } from "./github.ts";

/** What a single bottom branch needs: an active squash-merge, or just advancing
 *  past one that already merged outside the tool. */
export type MergeAction = "merge" | "advance-only";

/** The bottom-up review snapshot the planner reasons over. Pure data — no I/O. */
export interface BranchReview {
  branch: string;
  pr: number | null;
  /** PR state from GitHub: "MERGED" | "OPEN" | "CLOSED" | null (no PR). */
  prState: string | null;
  /** "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "PENDING" | null. */
  reviewDecision: string | null;
}

export interface PlannedStep {
  branch: string;
  pr: number | null;
  action: MergeAction;
}

export interface MergePlan {
  /** Contiguous bottom-up branches to process, in order. */
  steps: PlannedStep[];
  /** Where (and why) we stopped — null if the whole stack is included. */
  stop: { branch: string; reason: string } | null;
}

/**
 * Decide which bottom branches to drain, walking bottom-up over the ordered
 * stack. A branch already `MERGED` is always included as `advance-only` (the
 * stack is simply out of sync with reality and must catch up).
 *
 * When `approveAndMerge` is true (`merge --approved`), an unmerged branch is
 * included as a `merge` step only if it has a PR that is `APPROVED`; the first
 * branch that isn't stops the walk. When false (`sync` catching up to reality),
 * only already-merged branches are drained and the first unmerged branch stops
 * the walk regardless of its approval.
 */
export function planMerges(ordered: BranchReview[], opts: { approveAndMerge: boolean }): MergePlan {
  const steps: PlannedStep[] = [];

  for (const b of ordered) {
    if (b.prState === "MERGED") {
      steps.push({ branch: b.branch, pr: b.pr, action: "advance-only" });
      continue;
    }

    if (!opts.approveAndMerge) {
      // sync mode: we only advance past branches already merged on GitHub.
      return { steps, stop: { branch: b.branch, reason: "not merged yet" } };
    }

    if (b.pr == null) {
      return {
        steps,
        stop: { branch: b.branch, reason: "no PR yet — run gh-stack submit" },
      };
    }

    if (b.reviewDecision === "APPROVED") {
      steps.push({ branch: b.branch, pr: b.pr, action: "merge" });
      continue;
    }

    return { steps, stop: { branch: b.branch, reason: reviewReason(b.reviewDecision) } };
  }

  return { steps, stop: null };
}

function reviewReason(decision: string | null): string {
  switch (decision) {
    case "CHANGES_REQUESTED":
      return "changes requested";
    case "REVIEW_REQUIRED":
    case "PENDING":
    case null:
      return "not approved yet";
    default:
      return `review: ${decision}`;
  }
}

/**
 * Resolve the rebase fork-point for re-rooting `child` after `mergedBranch`
 * landed on the trunk. Mirrors restack's resolver:
 *   1. snapshot pre-rewrite tip of `mergedBranch` (handles the case where the
 *      merged branch was itself rebased earlier in a multi-merge cascade), then
 *   2. `merge-base(child, mergedBranch)` for the common case where the merged
 *      branch still sits at the tip the child was stacked on.
 * Returns null if neither resolves (caller must abort rather than guess).
 */
export async function resolveForkPoint(
  meta: StackMetadata,
  mergedBranch: string,
  child: string,
): Promise<string | null> {
  const fromSnapshot = await findPreRewriteSha(meta, mergedBranch, child);
  if (fromSnapshot) return fromSnapshot;
  return git.mergeBase(child, mergedBranch);
}

/** Outcome of advancing a single new bottom onto the trunk. */
export type AdvanceResult =
  | { ok: true }
  | { ok: false; reason: "conflict" | "no-fork-point" | "bad-fork-point"; forkPoint?: string };

/**
 * Re-root `child` (the branch that becomes the new bottom) onto `targetRef`,
 * dropping `mergedBranch`'s now-squashed commits, then drop `mergedBranch` from
 * the stack metadata (re-parenting `child` and any siblings onto the trunk),
 * push the rebased child, and repoint its PR base to `recordedBase`.
 *
 * The caller MUST have taken a snapshot first — on a rebase conflict this leaves
 * the in-progress `git rebase` for the user to resolve and returns `conflict`.
 */
export async function advanceNewBottom(opts: {
  meta: StackMetadata;
  stackName: string;
  mergedBranch: string;
  child: string;
  childPr: number | null;
  targetRef: string;
  recordedBase: string;
}): Promise<AdvanceResult> {
  const { meta, stackName, mergedBranch, child, childPr, targetRef, recordedBase } = opts;

  const forkPoint = await resolveForkPoint(meta, mergedBranch, child);
  if (!forkPoint) return { ok: false, reason: "no-fork-point" };

  // Guard: the fork-point must be an ancestor of the child, else `--onto` would
  // replay an unrelated range. Bail loudly rather than mangle history.
  if (!(await git.isAncestor(forkPoint, child))) {
    return { ok: false, reason: "bad-fork-point", forkPoint };
  }

  p.log.info(
    `Re-rooting ${pc.yellow(child)} onto ${pc.green(recordedBase)} ${pc.dim(`(base: ${forkPoint.slice(0, 8)})`)}`,
  );
  const ok = await git.rebaseOnto(targetRef, forkPoint, child);
  if (!ok) return { ok: false, reason: "conflict", forkPoint };

  // Push the rebased head first so the PR diff is clean before its base flips.
  await git.pushStackedBranch(child);
  if (childPr != null) {
    const moved = await setPrBase(childPr, recordedBase);
    if (moved) {
      p.log.success(`PR #${childPr} base → ${pc.green(recordedBase)}`);
    } else {
      p.log.warn(`Could not retarget PR #${childPr} — set its base to ${recordedBase} manually`);
    }
  }

  // Metadata last: re-parents child (and siblings) onto the merged branch's
  // parent (the trunk) and writes. Done after the git work succeeds so a failure
  // never leaves metadata describing a state git didn't reach.
  await removeBranchFromStack(meta, stackName, mergedBranch);
  return { ok: true };
}
