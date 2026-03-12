// git-stack add — Add a branch to the current stack
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  readMetadata,
  addBranchToStack,
  getTopOfStack,
  getOrderedBranches,
} from "../lib/metadata.ts";
import { ensureMetadata, ensureCurrentStack } from "../lib/safety.ts";
import { getPrNumber } from "../lib/github.ts";
import { selectParent } from "../lib/ui.ts";
import type { Branch } from "../types.ts";

export default async function add(args: string[]): Promise<void> {
  // Parse flags
  let parentFlag: string | undefined;
  let descFlag: string | undefined;
  let createFlag: string | undefined;
  let branchArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--parent":
        parentFlag = args[++i];
        break;
      case "--description":
        descFlag = args[++i];
        break;
      case "--create":
        createFlag = args[++i];
        break;
      case "--help":
        console.log(`
git-stack add — Add a branch to the current stack

USAGE
  git-stack add [<branch>] [options]

OPTIONS
  --parent <branch>     Parent branch (default: top of stack)
  --create <branch>     Create new branch off top of stack and add it
  --description <desc>  Description for the branch
`);
        return;
      default:
        if (!args[i]!.startsWith("--")) {
          branchArg = args[i];
        }
    }
  }

  const meta = await ensureMetadata();
  const stackName = ensureCurrentStack(meta);
  const stack = meta.stacks[stackName]!;

  p.intro(pc.cyan(`Add branch to ${pc.yellow(stackName)}`));

  let branchToAdd: string;

  // --create: make a new branch off the top of the stack
  if (createFlag) {
    const topBranch = getTopOfStack(stack);
    if (!topBranch) {
      p.cancel("Stack has no branches yet. Add the base branch first.");
      process.exit(1);
    }

    const currentBranch = await git.currentBranch();
    if (currentBranch !== topBranch) {
      p.log.info(`Switching to ${pc.yellow(topBranch)}...`);
      await git.checkout(topBranch);
    }

    p.log.info(
      `Creating branch off top of stack: ${pc.yellow(topBranch)}`
    );
    await git.createBranch(createFlag);
    p.log.success(`Created branch: ${pc.yellow(createFlag)}`);

    branchToAdd = createFlag;
    parentFlag = topBranch;
  } else {
    branchToAdd = branchArg || (await git.currentBranch());
  }

  // Check if branch is already in the stack
  if (stack.branches[branchToAdd]) {
    p.cancel(
      `Branch ${pc.yellow(branchToAdd)} is already in stack ${pc.blue(stackName)}`
    );
    process.exit(1);
  }

  console.log(
    `  Adding: ${pc.yellow(branchToAdd)}`
  );
  console.log();

  // Get parent
  let parent = parentFlag;
  if (!parent) {
    // Default to top of stack
    const topBranch = getTopOfStack(stack);
    const ordered = getOrderedBranches(stack);

    if (ordered.length === 0) {
      parent = "main";
    } else {
      parent = await selectParent(stack, branchToAdd);
      if (!parent) {
        p.cancel("Cancelled");
        process.exit(0);
      }
    }
  }

  p.log.info(`Parent: ${pc.yellow(parent)}`);

  // Auto-detect PR number
  const s = p.spinner();
  s.start("Looking for PR...");
  const prNumber = await getPrNumber(branchToAdd);
  s.stop(prNumber ? `Found PR #${prNumber}` : "No PR found");

  // Get description
  let description = descFlag;
  if (description === undefined && !createFlag) {
    const result = await p.text({
      message: "Branch description (optional)",
      placeholder: "e.g., API layer",
    });
    if (!p.isCancel(result)) {
      description = (result as string) || undefined;
    }
  }

  // Add branch
  const branchData: Branch = {
    parent,
    ...(prNumber && { pr: prNumber }),
    ...(description && { description }),
  };

  await addBranchToStack(meta, stackName, branchToAdd, branchData);

  p.outro(
    pc.green(
      `Added ${pc.yellow(branchToAdd)} to stack ${pc.blue(stackName)}`
    )
  );
}
