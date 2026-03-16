// gh-stack init — Create a new stack, auto-detecting branch chains
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  readMetadata,
  initMetadata,
  createStack,
  addBranchToStack,
  metadataExists,
  findStackForBranch,
} from "../lib/metadata.ts";
import { getPrNumber } from "../lib/github.ts";
import { isAutoYes } from "../lib/ui.ts";
import type { StackMetadata, Branch } from "../types.ts";

const HELP = `
gh-stack init — Create a new stack from the current branch

USAGE
  gh-stack init [options]

Creates a new stack and adds the current branch. If the current branch
is part of a chain of branches (e.g. main → feat-1 → feat-2), init
auto-detects the chain and offers to add all branches to the stack.

Best used from the TOP of your branch chain so all branches are found.

OPTIONS
  --name <name>         Stack name (default: current branch name)
  --description <desc>  Stack description
  --parent <branch>     Parent/trunk branch (default: main)

EXAMPLES
  gh-stack init                              # Auto-detect chain, use defaults
  gh-stack init --name my-feature            # Custom stack name
  gh-stack init --parent develop             # Different trunk branch
`;

/**
 * Detect a chain of branches from trunk to the current branch.
 *
 * Walks down from the current branch by finding local branches whose
 * tips are strict ancestors of the current branch. Sorts by commit
 * distance (closest = direct parent) to reconstruct the chain.
 *
 * Returns branches in bottom-up order: [closest-to-trunk, ..., current]
 */
async function detectBranchChain(currentBranch: string, trunk: string): Promise<string[]> {
  const allBranches = await git.allLocalBranches();

  // Branches to exclude: current, trunk, and always main/master
  const excluded = new Set([currentBranch, trunk, "main", "master"]);

  // Find branches that are strict ancestors of current (and not trunk)
  const ancestors: { name: string; distance: number }[] = [];

  for (const branch of allBranches) {
    if (excluded.has(branch)) continue;

    // Is this branch's tip an ancestor of current?
    if (await git.isAncestor(branch, currentBranch)) {
      // How many commits between this branch and current?
      const distance = await git.commitCount(branch, currentBranch);
      if (distance > 0) {
        ancestors.push({ name: branch, distance });
      }
    }
  }

  // Sort by distance descending (furthest from current = closest to trunk)
  ancestors.sort((a, b) => b.distance - a.distance);

  // Build chain: ancestors (sorted trunk→current) + current branch
  const chain = ancestors.map((a) => a.name);
  chain.push(currentBranch);

  return chain;
}

export default async function init(args: string[]): Promise<void> {
  // Parse flags
  let nameFlag: string | undefined;
  let descFlag: string | undefined;
  let parentFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--name":
        nameFlag = args[++i];
        break;
      case "--description":
        descFlag = args[++i];
        break;
      case "--parent":
        parentFlag = args[++i];
        break;
      case "--help":
        console.log(HELP);
        return;
    }
  }

  const branch = await git.currentBranch();
  const trunk = parentFlag || "main";

  p.intro(pc.cyan("Create New Stack"));

  // Get or create metadata
  let meta: StackMetadata;
  if (await metadataExists()) {
    meta = (await readMetadata())!;
  } else {
    meta = await initMetadata();
  }

  // Check if current branch is already in a stack
  const existingStack = findStackForBranch(meta, branch);
  if (existingStack) {
    p.cancel(`Branch ${pc.yellow(branch)} is already in stack ${pc.yellow(existingStack)}`);
    process.exit(1);
  }

  // ── Detect branch chain ──
  const s = p.spinner();
  s.start("Detecting branch chain...");
  const chain = await detectBranchChain(branch, trunk);
  s.stop(chain.length > 1 ? `Found ${chain.length} branches in chain` : `Single branch: ${branch}`);

  // Show detected chain
  if (chain.length > 1) {
    console.log();
    console.log(`  ${pc.dim(trunk)}`);
    for (let i = 0; i < chain.length; i++) {
      const isLast = i === chain.length - 1;
      const tree = isLast ? "  ┗━" : "  ┣━";
      const label = chain[i] === branch ? pc.yellow(chain[i]!) + pc.dim(" (current)") : chain[i];
      console.log(`${tree} ${label}`);
      if (!isLast) console.log("  ┃");
    }
    console.log();

    // Confirm chain
    if (!isAutoYes()) {
      const confirmed = await p.confirm({
        message: "Create stack with all branches?",
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.cancel("Cancelled");
        process.exit(0);
      }
    }
  }

  // ── Determine stack name ──
  const stackName = nameFlag || branch;

  if (meta.stacks[stackName]) {
    p.cancel(`Stack "${stackName}" already exists`);
    process.exit(1);
  }

  // ── Create stack ──
  meta = await createStack(meta, stackName, descFlag || "");

  // ── Add branches with PR detection ──
  const prSpinner = p.spinner();
  prSpinner.start("Detecting PRs...");

  let prCount = 0;
  for (let i = 0; i < chain.length; i++) {
    const branchName = chain[i]!;
    const parent = i === 0 ? trunk : chain[i - 1]!;

    // Auto-detect PR
    const prNumber = await getPrNumber(branchName);
    if (prNumber) prCount++;

    const branchData: Branch = {
      parent,
      ...(prNumber && { pr: prNumber }),
    };

    meta = await addBranchToStack(meta, stackName, branchName, branchData);
  }

  prSpinner.stop(prCount > 0 ? `Found ${prCount} PR(s)` : "No PRs found");

  p.outro(pc.green(`Stack ${pc.yellow(stackName)} created with ${chain.length} branch(es)!`));

  // Next steps
  console.log();
  if (chain.length === 1) {
    console.log("  Next steps:");
    console.log(`    ${pc.blue("gh-stack create <branch>")}  — Add a branch to the stack`);
  } else {
    console.log("  Next steps:");
    console.log(`    ${pc.blue("gh-stack submit")}           — Push and create PRs`);
  }
  console.log(`    ${pc.blue("gh-stack log")}              — View stack`);
  console.log();
}
