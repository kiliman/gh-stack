// gh-stack init — Create a new stack from the current branch
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  readMetadata,
  initMetadata,
  createStack,
  addBranchToStack,
  metadataExists,
} from "../lib/metadata.ts";
import { getPrNumber } from "../lib/github.ts";
import type { StackMetadata, Branch } from "../types.ts";

export default async function init(args: string[]): Promise<void> {
  // Parse flags
  let nameFlag: string | undefined;
  let descFlag: string | undefined;
  let parentFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--name":
        nameFlag = args[++i];
        break;
      case "--description":
        descFlag = args[++i];
        break;
      case "--parent":
        parentFlag = args[++i];
        break;
      case "--help":
        console.log(`
gh-stack init — Create a new stack from the current branch

USAGE
  gh-stack init [options]

Creates a new stack and adds the current branch as the first entry.
Auto-detects PR number from GitHub.

OPTIONS
  --name <name>         Stack name (default: current branch name)
  --description <desc>  Stack description
  --parent <branch>     Parent for current branch (default: main)

EXAMPLES
  gh-stack init                              # Uses branch name as stack name
  gh-stack init --name my-feature            # Custom stack name
  gh-stack init --parent develop             # Different base branch
`);
        return;
    }
  }

  const branch = await git.currentBranch();
  const stackName = nameFlag || branch;
  const parent = parentFlag || "main";

  p.intro(pc.cyan("Create New Stack"));

  // Get or create metadata
  let meta: StackMetadata;
  if (await metadataExists()) {
    meta = (await readMetadata())!;
  } else {
    meta = await initMetadata();
  }

  // Check if stack already exists
  if (meta.stacks[stackName]) {
    p.cancel(`Stack "${stackName}" already exists`);
    process.exit(1);
  }

  // Show what we're doing
  p.log.info(`Stack: ${pc.yellow(stackName)}`);
  p.log.info(`Branch: ${pc.yellow(branch)}`);
  p.log.info(`Parent: ${pc.dim(parent)}`);

  // Auto-detect PR number
  const s = p.spinner();
  s.start("Looking for PR...");
  const prNumber = await getPrNumber(branch);
  s.stop(prNumber ? `Found PR #${prNumber}` : "No PR found");

  // Create the stack
  meta = await createStack(meta, stackName, descFlag || "");

  // Add branch to stack
  const branchData: Branch = {
    parent,
    ...(prNumber && { pr: prNumber }),
  };

  meta = await addBranchToStack(meta, stackName, branch, branchData);

  p.outro(pc.green("Stack created!"));

  // Show next steps
  console.log();
  console.log("  Next steps:");
  console.log(`    ${pc.blue("gh-stack create <branch>")}  — Add a branch to the stack`);
  console.log(`    ${pc.blue("gh-stack log")}              — View stack`);
  console.log();
}
