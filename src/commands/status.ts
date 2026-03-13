// gh-stack status — PR dashboard (CI, reviews)
// Port of reference/check-my-prs-fast.sh
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  readMetadata,
  metadataExists,
  getOrderedBranches,
  findStackForBranch,
} from "../lib/metadata.ts";
import { getMyOpenPrs, reviewEmoji, ciEmoji } from "../lib/github.ts";
import type { PrStatus } from "../types.ts";

export default async function status(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack status — PR dashboard

USAGE
  gh-stack status [options]

OPTIONS
  --current        Show only the current stack (or current PR if standalone)
  --json           Output as JSON (progress goes to stderr)

Shows open PRs across stacks with review state, CI status, and merge readiness.
Progress/spinner output goes to stderr so stdout stays clean for piping.
`);
    return;
  }

  const jsonMode = args.includes("--json");
  const currentOnly = args.includes("--current");

  // Progress goes to stderr so stdout is clean for agents
  process.stderr.write("Fetching open PRs...\n");

  const prs = await getMyOpenPrs();

  process.stderr.write(`Found ${prs.length} open PR(s)\n`);

  if (prs.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ stacks: [], standalone: [] }, null, 2));
    } else {
      console.log("No open PRs found. 🎉");
    }
    return;
  }

  // Build lookup by PR number
  const prMap = new Map<number, PrStatus>();
  for (const pr of prs) {
    prMap.set(pr.number, pr);
  }

  // Determine current branch and stack for --current filtering.
  // --current means: "show me the status of whatever branch I'm ON right now."
  // If that branch is in a stack → show that stack's PRs.
  // If standalone → show just that branch's PR.
  // Do NOT fall back to metadata's current_stack — that's stale state.
  let currentStackName: string | null = null;
  let currentBranch: string | null = null;
  let currentPrNumber: number | null = null;

  if (currentOnly) {
    try {
      currentBranch = await git.currentBranch();
    } catch {
      // Not on a branch — show nothing for --current
    }

    if (currentBranch && (await metadataExists())) {
      const meta = await readMetadata();
      if (meta) {
        // Only use findStackForBranch — no fallback to current_stack
        currentStackName = findStackForBranch(meta, currentBranch);

        // If not in any stack, find the PR for this branch directly
        if (!currentStackName) {
          for (const pr of prs) {
            if (pr.headRefName === currentBranch) {
              currentPrNumber = pr.number;
              break;
            }
          }
          // Also check metadata for the PR number
          if (!currentPrNumber && meta) {
            for (const stack of Object.values(meta.stacks)) {
              const branch = stack.branches[currentBranch];
              if (branch?.pr) {
                currentPrNumber = branch.pr;
                break;
              }
            }
          }
        }
      }
    }

    // If not in metadata at all, try to match by branch name from open PRs
    if (!currentStackName && !currentPrNumber && currentBranch) {
      for (const pr of prs) {
        if (pr.headRefName === currentBranch) {
          currentPrNumber = pr.number;
          break;
        }
      }
    }
  }

  // ── JSON mode ──
  if (jsonMode) {
    outputJson(prs, prMap, currentOnly, currentStackName, currentPrNumber);
    return;
  }

  // ── Human mode ──
  outputHuman(prs, prMap, currentOnly, currentStackName, currentBranch, currentPrNumber);
}

// ────────────────────────────────────────────────────────
// JSON output
// ────────────────────────────────────────────────────────

async function outputJson(
  prs: PrStatus[],
  prMap: Map<number, PrStatus>,
  currentOnly: boolean,
  currentStackName: string | null,
  currentPrNumber: number | null,
): Promise<void> {
  const stackedPrNumbers = new Set<number>();
  const stacks: any[] = [];

  if (await metadataExists()) {
    const meta = await readMetadata();
    if (meta) {
      for (const [stackName, stack] of Object.entries(meta.stacks)) {
        if (currentOnly && stackName !== currentStackName) continue;

        const ordered = getOrderedBranches(stack);
        const branches: any[] = [];

        for (const branchName of ordered) {
          const branch = stack.branches[branchName]!;
          const prNum = branch.pr;
          const pr = prNum ? prMap.get(prNum) : undefined;

          if (prNum && pr) {
            stackedPrNumbers.add(prNum);
            branches.push({
              branch: branchName,
              pr: prNum,
              title: pr.title,
              state: pr.state,
              isDraft: pr.isDraft,
              url: pr.url,
              review: pr.reviewDecision || "PENDING",
              ci: {
                total: pr.totalChecks,
                passed: pr.passedChecks,
                failed: pr.failedChecks,
                pending: pr.pendingChecks,
                failedNames: pr.failedNames,
              },
            });
          } else if (prNum) {
            // PR exists in metadata but not in open PRs (merged/closed)
            stackedPrNumbers.add(prNum);
            branches.push({
              branch: branchName,
              pr: prNum,
              title: branch.description || branchName,
              state: "CLOSED",
              isDraft: false,
              url: null,
              review: null,
              ci: null,
            });
          }
        }

        if (branches.length > 0 || !currentOnly) {
          stacks.push({
            name: stackName,
            description: stack.description,
            branches,
          });
        }
      }
    }
  }

  // Standalone PRs
  // In --current mode: only show the specific standalone PR for this branch
  // (and only if the branch isn't already in a stack)
  // Otherwise: show all standalone PRs
  const filteredStandalone = prs
    .filter((pr) => {
      if (stackedPrNumbers.has(pr.number)) return false;
      if (currentOnly) return pr.number === currentPrNumber;
      return true;
    })
    .toSorted(
      (a, b) => new Date(b.updatedAt || "").getTime() - new Date(a.updatedAt || "").getTime(),
    );

  const standalone = filteredStandalone.map((pr) => ({
    pr: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    url: pr.url,
    review: pr.reviewDecision || "PENDING",
    ci: {
      total: pr.totalChecks,
      passed: pr.passedChecks,
      failed: pr.failedChecks,
      pending: pr.pendingChecks,
      failedNames: pr.failedNames,
    },
  }));

  // --current mode: return a single unwrapped object (stack or standalone PR)
  if (currentOnly) {
    if (stacks.length > 0) {
      console.log(JSON.stringify(stacks[0], null, 2));
    } else if (standalone.length > 0) {
      console.log(JSON.stringify(standalone[0], null, 2));
    } else {
      console.log(JSON.stringify(null));
    }
    return;
  }

  console.log(JSON.stringify({ stacks, standalone }, null, 2));
}

// ────────────────────────────────────────────────────────
// Human-readable output
// ────────────────────────────────────────────────────────

async function outputHuman(
  prs: PrStatus[],
  prMap: Map<number, PrStatus>,
  currentOnly: boolean,
  currentStackName: string | null,
  currentBranch: string | null,
  currentPrNumber: number | null,
): Promise<void> {
  const stackedPrNumbers = new Set<number>();

  console.log();
  console.log(`${pc.bold("📊 My Open PRs")}  ${pc.dim(`(${prs.length} open)`)}`);
  console.log();

  // ── Stacked PRs ──
  if (await metadataExists()) {
    const meta = await readMetadata();
    if (meta) {
      for (const [stackName, stack] of Object.entries(meta.stacks)) {
        if (currentOnly && stackName !== currentStackName) continue;

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

        console.log(`${pc.cyan("📚 Stack:")} ${pc.yellow(stackName)}`);
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
          console.log(`   ${tree} ${formatted.line1}`);
          console.log(`      ${formatted.line2}`);
          console.log(`      ${pc.dim(pr.url)}`);

          for (const name of pr.failedNames) {
            console.log(`      ${pc.red(`↳ ${name}`)}`);
          }
        }

        console.log();
      }
    }
  }

  // ── Standalone PRs ──
  // In --current mode: only show if current branch is a standalone PR
  // Otherwise: show all standalone PRs
  {
    const standalonePrs = prs
      .filter((pr) => {
        if (stackedPrNumbers.has(pr.number)) return false;
        if (currentOnly) return pr.number === currentPrNumber;
        return true;
      })
      .toSorted(
        (a, b) => new Date(b.updatedAt || "").getTime() - new Date(a.updatedAt || "").getTime(),
      );

    if (standalonePrs.length > 0) {
      if (!currentOnly) {
        console.log(`${pc.cyan("📋 Standalone PRs")}`);
        console.log();
      }

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
  }

  // Footer
  console.log(pc.dim("─".repeat(40)));
}

function formatPr(pr: PrStatus): { line1: string; line2: string } {
  const stateIcon = pr.isDraft ? "📝" : "🔵";
  const reviewIcon = reviewEmoji(pr.reviewDecision);
  const reviewStr = reviewText(pr.reviewDecision);
  const ci = ciEmoji(pr);
  const title = pr.title.length > 70 ? pr.title.slice(0, 67) + "..." : pr.title;

  return {
    line1: `${stateIcon} #${pr.number}: ${title}`,
    line2: `${reviewIcon} ${reviewStr}  │  ${ci.icon} ${ci.text}`,
  };
}

function reviewText(decision: string | null | undefined): string {
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
