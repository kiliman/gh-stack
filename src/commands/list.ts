// gh-stack list — Lightweight branch listing (agent-friendly)
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { findStackForBranch, getOrderedBranches, writeMetadata } from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";

export default async function list(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack list — List branches with numbers

USAGE
  gh-stack list
  gh-stack ls

Lightweight branch listing for quick reference and scripting.
Use the number with 'gh-stack checkout <number>' to jump to a branch.

ALIASES
  gh-stack ls
`);
    return;
  }

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();

  // The current stack is whichever stack the checked-out branch belongs to —
  // never the persisted `current_stack` hint. If this branch is in no stack,
  // there is no current stack; don't resurface a previously-used one.
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName || !meta.stacks[stackName]) {
    console.log("Branch is not in any stack.");
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);

  // We're on a branch in this stack — record it as current + its last_branch.
  meta.current_stack = stackName;
  stack.last_branch = currentBranch;
  await writeMetadata(meta);

  // Header
  console.log(`${pc.dim("Stack:")} ${pc.yellow(stackName)}`);
  if (stack.description) {
    console.log(`${pc.dim(stack.description)}`);
  }
  console.log();

  // List branches
  for (let i = 0; i < ordered.length; i++) {
    const branchName = ordered[i]!;
    const branch = stack.branches[branchName]!;
    const isCurrent = branchName === currentBranch;
    const prNum = branch.pr ? pc.dim(`#${branch.pr}`) : "";
    const marker = isCurrent ? pc.yellow(" (current)") : "";
    const num = pc.blue(`[${i + 1}]`);

    console.log(`  ${num} ${isCurrent ? pc.yellow(branchName) : branchName}${marker} ${prNum}`);
  }
  console.log();
}
