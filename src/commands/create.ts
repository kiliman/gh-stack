// gh-stack create — Create a new branch and add to the stack
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { findStackForBranch, addBranchToStack } from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";
import type { Branch } from "../types.ts";

export default async function create(args: string[]): Promise<void> {
  // Parse flags
  let descFlag: string | undefined;
  let branchArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--description":
        descFlag = args[++i];
        break;
      case "--help":
        console.log(`
gh-stack create — Create a new branch and add to the stack

USAGE
  gh-stack create <branch-name> [options]

Creates a new git branch off the current branch and adds it to the
current stack. The current branch must already be tracked in a stack.

OPTIONS
  --description <desc>  Description for the branch

EXAMPLES
  gh-stack create kiliman/feature-2          # Branch off current, add to stack
  gh-stack create kiliman/api --description "API layer"
`);
        return;
      default:
        if (!args[i]!.startsWith("--")) {
          branchArg = args[i];
        }
    }
  }

  // Branch name is required
  if (!branchArg) {
    p.cancel("Branch name is required.\n\n  Usage: gh-stack create <branch-name>");
    process.exit(1);
  }

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();

  // Current branch must be in a stack
  const stackName = findStackForBranch(meta, currentBranch);
  if (!stackName) {
    p.cancel(
      `Current branch ${pc.yellow(currentBranch)} is not in any stack.\n\n  Add it to a stack first with:\n    ${pc.green("gh-stack init")}`,
    );
    process.exit(1);
  }

  // New branch must not already exist
  if (await git.localBranchExists(branchArg)) {
    p.cancel(`Branch ${pc.yellow(branchArg)} already exists.`);
    process.exit(1);
  }

  p.intro(pc.cyan(`Create branch in ${pc.yellow(stackName)}`));

  // Create the new branch off current HEAD
  p.log.info(`Creating ${pc.yellow(branchArg)} off ${pc.yellow(currentBranch)}`);
  await git.createBranch(branchArg);

  // Add to the stack with parent = current branch
  const branchData: Branch = {
    parent: currentBranch,
    ...(descFlag && { description: descFlag }),
  };

  await addBranchToStack(meta, stackName, branchArg, branchData);

  p.outro(pc.green(`Created ${pc.yellow(branchArg)} → parent ${pc.yellow(currentBranch)}`));
}
