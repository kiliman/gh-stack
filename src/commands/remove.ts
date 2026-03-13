// gh-stack remove — Remove a branch from the stack (re-link parent chain)
import * as p from "@clack/prompts";
import pc from "picocolors";
import { removeBranchFromStack, getChildren } from "../lib/metadata.ts";
import { ensureMetadata, ensureCurrentStack, ensureValidStack } from "../lib/safety.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { selectBranch } from "../lib/ui.ts";
import * as git from "../lib/git.ts";

export default async function remove(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack remove — Remove a branch from the stack

USAGE
  gh-stack remove [<branch>]

Removes the branch and re-parents its children to its parent.
If no branch is specified, shows interactive selector.
`);
    return;
  }

  const meta = await ensureMetadata();
  const stackName = ensureCurrentStack(meta);
  await ensureValidStack(meta, stackName);
  const stack = meta.stacks[stackName]!;
  const currentBranch = await git.currentBranch();

  p.intro(pc.cyan("Remove Branch from Stack"));

  // Get branch to remove
  let branchName = args[0];
  if (!branchName) {
    branchName = (await selectBranch(stack, "Select branch to remove", currentBranch)) ?? undefined;
    if (!branchName) {
      p.cancel("Cancelled");
      process.exit(0);
    }
  }

  // Validate
  const branch = stack.branches[branchName];
  if (!branch) {
    p.cancel(`Branch ${pc.yellow(branchName)} not found in stack ${pc.blue(stackName)}`);
    process.exit(1);
  }

  // Show what will happen
  const children = getChildren(stack, branchName);
  p.log.info(`Removing: ${pc.yellow(branchName)}`);
  p.log.info(`Parent was: ${pc.dim(branch.parent)}`);

  if (children.length > 0) {
    p.log.info(
      `Re-parenting ${children.length} child branch${children.length > 1 ? "es" : ""} to ${pc.dim(branch.parent)}`,
    );
    for (const child of children) {
      console.log(`    ${pc.dim("→")} ${child}`);
    }
  }

  // Confirm
  const confirmed = await p.confirm({
    message: `Remove ${pc.yellow(branchName)} from stack?`,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Take snapshot before destructive operation
  await takeSnapshot(meta, stackName, "remove");

  // Remove branch
  await removeBranchFromStack(meta, stackName, branchName);

  p.outro(pc.green(`Removed ${pc.yellow(branchName)} from stack ${pc.blue(stackName)}`));
}
