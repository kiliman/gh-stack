// gh-stack delete — Delete a branch from the stack (re-link parent chain)
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { removeBranchFromStack, getChildren } from "../lib/metadata.ts";
import {
  ensureMetadata,
  ensureCurrentStack,
  ensureValidStack,
  resolveStackForBranchArg,
} from "../lib/safety.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { selectBranch, confirmAction } from "../lib/ui.ts";
import * as git from "../lib/git.ts";

export default async function deleteCmd(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack delete — Delete a branch from the stack

USAGE
  gh-stack delete [<branch>] [options]

Removes the branch from the stack and deletes the underlying git branch,
re-parenting any children to the removed branch's parent. If the deleted
branch was pushed, its remote counterpart is deleted too.

If no branch is specified, shows an interactive selector.

OPTIONS
  -k, --keep-branch   Only remove from the stack metadata; leave the
                      local and remote git branches untouched
      --no-remote     Delete the local branch but keep the remote branch
`);
    return;
  }

  const keepBranch = args.includes("--keep-branch") || args.includes("-k");
  const noRemote = args.includes("--no-remote");
  const positional = args.filter((a) => !a.startsWith("-"));

  const meta = await ensureMetadata();
  // The branch to delete names its own stack — resolve from it so
  // `delete <branch>` works from anywhere. Only fall back to the current stack
  // (the branch you're on) in interactive mode, when no branch was given.
  const stackName = positional[0]
    ? resolveStackForBranchArg(meta, positional[0]!)
    : ensureCurrentStack(meta);
  await ensureValidStack(meta, stackName);
  const stack = meta.stacks[stackName]!;
  const currentBranch = await git.currentBranch();

  p.intro(pc.cyan("Delete Branch from Stack"));

  // Get branch to delete
  let branchName = positional[0];
  if (!branchName) {
    branchName = (await selectBranch(stack, "Select branch to delete", currentBranch)) ?? undefined;
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

  // Discover what actually exists in git so we report (and delete) accurately
  const hasLocal = !keepBranch && (await git.localBranchExists(branchName));
  const hasRemote = !keepBranch && !noRemote && (await git.remoteBranchExists(branchName));

  // Show what will happen
  const children = getChildren(stack, branchName);
  p.log.info(`Removing: ${pc.yellow(branchName)} from stack ${pc.blue(stackName)}`);
  p.log.info(`Parent was: ${pc.dim(branch.parent)}`);

  if (children.length > 0) {
    p.log.info(
      `Re-parenting ${children.length} child branch${children.length > 1 ? "es" : ""} to ${pc.dim(branch.parent)}`,
    );
    for (const child of children) {
      console.log(`    ${pc.dim("→")} ${child}`);
    }
  }

  if (keepBranch) {
    p.log.info(pc.dim("Keeping git branch (--keep-branch) — stack metadata only"));
  } else {
    if (hasLocal) p.log.info(`Deleting local branch ${pc.yellow(branchName)}`);
    if (hasRemote) p.log.info(`Deleting remote branch ${pc.yellow(`origin/${branchName}`)}`);
    if (!hasLocal && !hasRemote) {
      p.log.info(pc.dim("No git branch found to delete — stack metadata only"));
    }
  }

  // Confirm (respects --yes / GH_STACK_YES — no interactive hang for agents)
  const confirmed = await confirmAction(`Delete ${pc.yellow(branchName)}?`);
  if (!confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Take snapshot before destructive operation
  await takeSnapshot(meta, stackName, "delete");

  // If we're sitting on the branch we're about to delete, git won't let us
  // remove it — move to the parent (or trunk) first.
  if (hasLocal && branchName === currentBranch) {
    const fallback = (await git.localBranchExists(branch.parent))
      ? branch.parent
      : await git.trunkBranch();
    await git.checkout(fallback);
    p.log.info(`Switched to ${pc.blue(fallback)} (was on the deleted branch)`);
  }

  // Remove from metadata (re-parents children, fixes last_branch)
  await removeBranchFromStack(meta, stackName, branchName);

  // Delete the actual git branch(es)
  if (hasRemote) {
    const ok = await git.deleteRemoteBranch(branchName);
    if (ok) {
      p.log.success(`Deleted remote branch ${pc.dim(`origin/${branchName}`)}`);
    } else {
      p.log.warn(
        `Could not delete remote branch ${pc.dim(`origin/${branchName}`)} (delete it manually)`,
      );
    }
  }
  if (hasLocal) {
    const ok = await git.deleteLocalBranch(branchName);
    if (ok) {
      p.log.success(`Deleted local branch ${pc.dim(branchName)}`);
    } else {
      p.log.warn(`Could not delete local branch ${pc.dim(branchName)} (delete it manually)`);
    }
  }

  p.outro(pc.green(`Removed ${pc.yellow(branchName)} from stack ${pc.blue(stackName)}`));
}
