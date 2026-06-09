// gh-stack down — Move to parent branch (downstack)
import * as p from "../lib/output.ts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { findStackForBranch, stackBase, writeMetadata } from "../lib/metadata.ts";
import { ensureMetadata, checkoutOrExit } from "../lib/safety.ts";

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
  const base = stackBase(stack);
  let moved = 0;

  for (let i = 0; i < steps; i++) {
    const branchMeta = stack.branches[currentBranch];
    if (!branchMeta) {
      p.log.warn(`${pc.yellow(currentBranch)} is not tracked in the stack`);
      return;
    }

    // The stack bottoms out at its base (main for a normal stack, or the base
    // branch for a split stack). The root's parent IS the base — stop there
    // rather than crossing into a parent stack.
    const parent = branchMeta.parent;
    if (parent === base) {
      if (moved === 0) {
        p.log.warn(`${pc.yellow(currentBranch)} is already at the bottom of the stack`);
        return;
      }
      // Reached the bottom partway through a multi-step move — stop here but
      // still check out as far as we got.
      p.log.info(`Reached bottom of stack after ${moved} step(s)`);
      break;
    }

    currentBranch = parent;
    moved++;
  }

  await checkoutOrExit(currentBranch);

  // Update tracking
  stack.last_branch = currentBranch;
  meta.current_stack = stackName;
  await writeMetadata(meta);

  p.log.success(`On ${pc.yellow(currentBranch)}`);
}
