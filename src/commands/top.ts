// gh-stack top — Jump to the tip of the stack
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  findStackForBranch,
  getOrderedBranches,
  getChildren,
  writeMetadata,
} from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";

export default async function top(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack top — Jump to the tip of the stack

USAGE
  gh-stack top

Switches to the topmost (leaf) branch of the current stack.
Prompts if there are multiple leaf branches.
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

  // Find leaf branches (no children)
  const leaves = ordered.filter((b) => getChildren(stack, b).length === 0);

  if (leaves.length === 0) {
    p.log.warn("No branches in stack");
    return;
  }

  let target: string;
  if (leaves.length === 1) {
    target = leaves[0]!;
  } else {
    const result = await p.select({
      message: "Multiple tips — which branch?",
      options: leaves.map((l) => ({
        value: l,
        label: l,
        hint: stack.branches[l]?.pr ? `#${stack.branches[l]!.pr}` : undefined,
      })),
    });
    if (p.isCancel(result)) {
      p.cancel("Cancelled");
      process.exit(0);
    }
    target = result as string;
  }

  if (target === currentBranch) {
    p.log.info(`Already at the top: ${pc.yellow(currentBranch)}`);
    return;
  }

  await git.checkout(target);

  // Update tracking
  stack.last_branch = target;
  meta.current_stack = stackName;
  await writeMetadata(meta);

  p.log.success(`On ${pc.yellow(target)}`);
}
