// gh-stack bottom — Jump to the base of the stack
import * as p from "../lib/output.ts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { findStackForBranch, getOrderedBranches, writeMetadata } from "../lib/metadata.ts";
import { ensureMetadata, checkoutOrExit } from "../lib/safety.ts";

export default async function bottom(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack bottom — Jump to the base of the stack

USAGE
  gh-stack bottom

Switches to the bottom-most branch of the current stack
(the first branch above trunk).
`);
    return;
  }

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(`Branch ${pc.yellow(currentBranch)} is not in any stack`);
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);

  if (ordered.length === 0) {
    p.log.warn("No branches in stack");
    return;
  }

  const target = ordered[0]!;

  if (target === currentBranch) {
    p.log.info(`Already at the bottom: ${pc.yellow(currentBranch)}`);
    return;
  }

  await checkoutOrExit(target);

  // Update tracking
  stack.last_branch = target;
  meta.current_stack = stackName;
  await writeMetadata(meta);

  p.log.success(`On ${pc.yellow(target)}`);
}
