// gh-stack down — Move to parent branch (downstack)
import * as p from "../lib/output.ts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { findStackForBranch, writeMetadata } from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";

export default async function down(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack down — Move to parent branch (downstack)

USAGE
  gh-stack down [steps]

OPTIONS
  [steps]    Number of levels to move down (default: 1)
`);
    return;
  }

  const steps = parseInt(args[0] || "1", 10);
  if (isNaN(steps) || steps < 1) {
    p.cancel("Invalid step count");
    process.exit(1);
  }

  const meta = await ensureMetadata();
  let currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(`Branch ${pc.yellow(currentBranch)} is not in any stack`);
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;

  for (let i = 0; i < steps; i++) {
    const branchMeta = stack.branches[currentBranch];
    if (!branchMeta) {
      p.log.warn(`${pc.yellow(currentBranch)} is not tracked in the stack`);
      return;
    }

    const parent = branchMeta.parent;
    if (parent === "main" || parent === "master") {
      if (i === 0) {
        p.log.warn(`${pc.yellow(currentBranch)} is already at the bottom of the stack`);
      } else {
        p.log.info(`Reached bottom of stack at ${pc.yellow(currentBranch)} after ${i} step(s)`);
      }
      return;
    }

    currentBranch = parent;
  }

  await git.checkout(currentBranch);

  // Update tracking
  stack.last_branch = currentBranch;
  meta.current_stack = stackName;
  await writeMetadata(meta);

  p.log.success(`On ${pc.yellow(currentBranch)}`);
}
