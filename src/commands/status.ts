// git-stack status — PR dashboard (CI, reviews)
// Port of reference/check-my-prs-fast.sh
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  readMetadata,
  metadataExists,
  getOrderedBranches,
} from "../lib/metadata.ts";
import {
  getMyOpenPrs,
  reviewEmoji,
  ciEmoji,
} from "../lib/github.ts";
import type { PrStatus, StackMetadata } from "../types.ts";

export default async function status(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
git-stack status — PR dashboard

USAGE
  git-stack status

Shows all open PRs across all stacks with review state,
CI status, draft state, and merge readiness.
`);
    return;
  }

  const s = p.spinner();
  s.start("Fetching open PRs...");

  const prs = await getMyOpenPrs();

  s.stop(`Found ${prs.length} open PR(s)`);

  if (prs.length === 0) {
    console.log("No open PRs found. 🎉");
    return;
  }

  // Build lookup by PR number
  const prMap = new Map<number, PrStatus>();
  for (const pr of prs) {
    prMap.set(pr.number, pr);
  }

  // Track which PRs are in stacks
  const stackedPrNumbers = new Set<number>();

  console.log();
  console.log(
    `${pc.bold("📊 My Open PRs")}  ${pc.dim(`(${prs.length} open)`)}`
  );
  console.log();

  // ── Stacked PRs ──
  if (await metadataExists()) {
    const meta = await readMetadata();
    if (meta) {
      for (const [stackName, stack] of Object.entries(meta.stacks)) {
        const ordered = getOrderedBranches(stack);

        // Find which PRs in this stack are still open
        const openPrsInStack: number[] = [];
        for (const branch of ordered) {
          const prNum = stack.branches[branch]?.pr;
          if (prNum && prMap.has(prNum)) {
            openPrsInStack.push(prNum);
            stackedPrNumbers.add(prNum);
          }
        }

        if (openPrsInStack.length === 0) continue;

        console.log(
          `${pc.cyan("📚 Stack:")} ${pc.yellow(stackName)}`
        );
        if (stack.description) {
          console.log(`   ${pc.dim(stack.description)}`);
        }
        console.log();

        for (let i = 0; i < openPrsInStack.length; i++) {
          const prNum = openPrsInStack[i]!;
          const pr = prMap.get(prNum)!;
          const isLast = i === openPrsInStack.length - 1;
          const tree = isLast ? "┗━" : "┣━";

          if (i > 0) {
            console.log("   ┃");
          }

          const formatted = formatPr(pr);
          // First line with tree
          console.log(`   ${tree} ${formatted.line1}`);
          console.log(`      ${formatted.line2}`);
          console.log(`      ${pc.dim(pr.url)}`);

          // Failed check names
          for (const name of pr.failedNames) {
            console.log(`      ${pc.red(`↳ ${name}`)}`);
          }
        }

        console.log();
      }
    }
  }

  // ── Standalone PRs ──
  const standalonePrs = prs
    .filter((pr) => !stackedPrNumbers.has(pr.number))
    .sort(
      (a, b) =>
        new Date(b.updatedAt || "").getTime() -
        new Date(a.updatedAt || "").getTime()
    );

  if (standalonePrs.length > 0) {
    console.log(`${pc.cyan("📋 Standalone PRs")}`);
    console.log();

    for (const pr of standalonePrs) {
      const formatted = formatPr(pr);
      console.log(formatted.line1);
      console.log(`   ${formatted.line2}`);
      console.log(`   ${pc.dim(pr.url)}`);

      for (const name of pr.failedNames) {
        console.log(`   ${pc.red(`↳ ${name}`)}`);
      }
      console.log();
    }
  }

  // Footer
  console.log(pc.dim("─".repeat(40)));
}

function formatPr(pr: PrStatus): { line1: string; line2: string } {
  // State icon
  const stateIcon = pr.isDraft ? "📝" : "🔵";

  // Review status
  const reviewIcon = reviewEmoji(pr.reviewDecision);
  const reviewText = reviewText_(pr.reviewDecision);

  // CI status
  const ci = ciEmoji(pr);

  const title = pr.title.length > 70 ? pr.title.slice(0, 67) + "..." : pr.title;

  return {
    line1: `${stateIcon} #${pr.number}: ${title}`,
    line2: `${reviewIcon} ${reviewText}  │  ${ci.icon} ${ci.text}`,
  };
}

function reviewText_(decision: string | null | undefined): string {
  switch (decision) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "REVIEW_REQUIRED":
      return "Needs review";
    default:
      return "Pending";
  }
}
