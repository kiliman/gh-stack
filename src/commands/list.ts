// gh-stack list — Lightweight branch listing (agent-friendly)
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  findStackForBranch,
  getOrderedBranches,
  writeMetadata,
} from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";

export default async function list(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack list — List branches with numbers

USAGE
  gh-stack list
  gh-stack ls

Lightweight branch listing for quick reference and scripting.
Use the number with 'gh-stack switch <number>' to jump to a branch.

ALIASES
  gh-stack ls
`);
    return;
  }

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();

  // Find which stack contains the current branch
  let stackName = findStackForBranch(meta, currentBranch);
  if (!stackName) stackName = meta.current_stack;

  if (!stackName || !meta.stacks[stackName]) {
    console.log("No active stack found.");
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);

  // Update tracking
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
