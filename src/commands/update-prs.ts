// gh-stack update-prs — Update PR descriptions with stack visualization
// Port of reference/gh-stack-update-pr.sh
import * as p from "../lib/output.ts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { findStackForBranch, getOrderedBranches, stackBase } from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";
import { getPrInfo, getPrBody, updatePrBody, reviewEmoji } from "../lib/github.ts";
import type { StackMetadata, Stack } from "../types.ts";

/** The ref a stack is rooted on, for rendering the base node of the viz. */
export interface BaseRef {
  label: string; // "main" or a branch name (for split stacks)
  prNumber?: number | null;
  prUrl?: string | null;
}

/**
 * Resolve the base node for a stack's visualization. For a split stack whose
 * base is a branch in another stack, look up that branch's PR so the viz can
 * link to it (instead of always showing "main").
 */
export async function resolveBaseRef(meta: StackMetadata, stack: Stack): Promise<BaseRef> {
  const base = stackBase(stack);
  if (base === "main" || base === "master") return { label: base };

  const ownerName = findStackForBranch(meta, base);
  const prNumber = ownerName ? (meta.stacks[ownerName]?.branches[base]?.pr ?? null) : null;
  let prUrl: string | null = null;
  if (prNumber) {
    const info = await getPrInfo(prNumber);
    prUrl = info?.url ?? null;
  }
  return { label: base, prNumber, prUrl };
}

export default async function updatePrs(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack update-prs — Update PR descriptions with stack visualization

USAGE
  gh-stack update-prs

Updates all PRs in the current stack with a standardized stack section
showing the tree structure, PR links, and review status.
`);
    return;
  }

  const meta = await ensureMetadata();
  const branch = await git.currentBranch();
  const stackName = findStackForBranch(meta, branch);

  if (!stackName) {
    p.cancel(`Branch ${pc.blue(branch)} not found in any stack`);
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);

  p.intro(pc.cyan("Update PR Descriptions"));
  p.log.info(`Stack: ${pc.yellow(stackName)}`);
  p.log.info(`Found ${ordered.length} branch(es) in stack`);
  console.log();

  // Collect PR info for all branches
  const s = p.spinner();
  s.start("Fetching PR info from GitHub...");

  interface BranchPrInfo {
    branch: string;
    prNumber: number | null;
    prTitle: string;
    prUrl: string | null;
    reviewEmojiStr: string;
  }

  const branchInfos: BranchPrInfo[] = [];

  for (const branchName of ordered) {
    const branchMeta = stack.branches[branchName]!;
    const prNumber = branchMeta.pr ?? null;
    let prTitle = branchMeta.description || branchName;
    let prUrl: string | null = null;
    let review = "PENDING";

    if (prNumber) {
      const info = await getPrInfo(prNumber);
      if (info) {
        prTitle = info.title || prTitle;
        prUrl = info.url;
        review = info.reviewDecision || "PENDING";
      }
    }

    branchInfos.push({
      branch: branchName,
      prNumber,
      prTitle,
      prUrl,
      reviewEmojiStr: reviewEmoji(review),
    });
  }

  s.stop("Fetched PR info");

  const baseRef = await resolveBaseRef(meta, stack);

  // Update each PR
  let updated = 0;
  let skipped = 0;

  for (let targetIdx = 0; targetIdx < branchInfos.length; targetIdx++) {
    const target = branchInfos[targetIdx]!;

    if (!target.prNumber) {
      p.log.info(`${pc.dim("⏭")} ${target.branch} — no PR, skipping`);
      skipped++;
      continue;
    }

    // Build stack visualization for this PR
    const stackViz = buildStackViz(branchInfos, targetIdx, baseRef);

    // Get current PR body and replace/append stack section
    const currentBody = await getPrBody(target.prNumber);
    if (currentBody === null) {
      p.log.warn(`Could not fetch body for PR #${target.prNumber}`);
      skipped++;
      continue;
    }

    // Remove existing stack section
    let updatedBody = currentBody;
    const stackSectionIdx = updatedBody.indexOf("### 📚 Stacked on");
    if (stackSectionIdx !== -1) {
      updatedBody = updatedBody.slice(0, stackSectionIdx).trimEnd();
    }

    // Append new stack section
    const newBody = updatedBody ? `${updatedBody}\n\n${stackViz}` : stackViz;

    // Update PR
    const ok = await updatePrBody(target.prNumber, newBody);
    if (ok) {
      p.log.success(`PR #${target.prNumber} ${target.prTitle}`);
      updated++;
    } else {
      p.log.error(`Failed to update PR #${target.prNumber}`);
    }
  }

  console.log();
  p.outro(
    pc.green(
      `Done! Updated ${updated} PR(s)${skipped > 0 ? `, skipped ${skipped} without PRs` : ""}`,
    ),
  );
}

interface BranchPrInfo {
  branch: string;
  prNumber: number | null;
  prTitle: string;
  prUrl: string | null;
  reviewEmojiStr: string;
}

export function buildStackViz(
  branches: BranchPrInfo[],
  targetIndex: number,
  base: BaseRef = { label: "main" },
): string {
  const lines: string[] = ["### 📚 Stacked on", ""];

  // Base node: link to the base PR if there is one (split stacks), else the
  // plain ref name. `**bold**` renders in markdown but not inside <pre>.
  const baseLink = base.prNumber
    ? `${base.prUrl ? `<a href="${base.prUrl}">#${base.prNumber}</a>` : `#${base.prNumber}`} ${base.label}`
    : null;

  if (branches.length === 1) {
    lines.push(`- ⚫ ${baseLink ?? `**${base.label}**`}`);
    return lines.join("\n");
  }

  lines.push("<pre>");
  lines.push(`⚫ ${baseLink ?? base.label}`);
  lines.push("┃");

  for (let i = 0; i < branches.length; i++) {
    const info = branches[i]!;
    const isLast = i === branches.length - 1;
    const isTarget = i === targetIndex;

    // PR link
    let prLink: string;
    if (info.prNumber) {
      prLink = info.prUrl ? `<a href="${info.prUrl}">#${info.prNumber}</a>` : `#${info.prNumber}`;
    } else {
      prLink = "(no PR yet)";
    }

    // 👈 marker for the current PR
    const marker = isTarget ? " 👈" : "";

    // Tree character
    const tree = isLast ? "┗━" : "┣━";

    lines.push(`${tree} ${info.reviewEmojiStr} ${prLink} ${info.prTitle}${marker}`);

    if (!isLast) {
      lines.push("┃");
    }
  }

  lines.push("</pre>");
  return lines.join("\n");
}
