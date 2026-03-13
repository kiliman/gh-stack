// gh-stack init — Create a new stack with the current branch
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
import { selectParent } from "../lib/ui.ts";
import type { StackMetadata, Branch } from "../types.ts";

export default async function init(args: string[]): Promise<void> {
  const branch = await git.currentBranch();

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
gh-stack init — Create a new stack

USAGE
  gh-stack init [--name <name>] [--description <desc>] [--parent <branch>]

OPTIONS
  --name <name>         Stack name (skip prompt)
  --description <desc>  Stack description
  --parent <branch>     Parent branch for current branch (default: main)
`);
        return;
    }
  }

  p.intro(pc.cyan("Create New Stack"));

  console.log(
    `  Initializing stack with: ${pc.yellow(branch)}`
  );
  console.log();

  // Get or create metadata
  let meta: StackMetadata;
  if (await metadataExists()) {
    meta = (await readMetadata())!;
  } else {
    meta = await initMetadata();
    p.log.success("Initialized empty stack metadata");
  }

  // Get stack name
  let stackName = nameFlag;
  if (!stackName) {
    const result = await p.text({
      message: "Stack name",
      placeholder: "e.g., podcast-mvp",
      validate: (val = "") => {
        if (!val.trim()) return "Stack name is required";
        if (meta.stacks[val.trim()]) return `Stack "${val}" already exists`;
      },
    });
    if (p.isCancel(result)) {
      p.cancel("Cancelled");
      process.exit(0);
    }
    stackName = result as string;
  }

  // Check if stack already exists
  if (meta.stacks[stackName]) {
    p.cancel(`Stack "${stackName}" already exists`);
    process.exit(1);
  }

  // Get stack description
  let description = descFlag;
  if (description === undefined) {
    const result = await p.text({
      message: "Stack description (optional)",
      placeholder: "e.g., Podcast MVP features",
    });
    if (p.isCancel(result)) {
      p.cancel("Cancelled");
      process.exit(0);
    }
    description = (result as string) || "";
  }

  // Create the stack
  meta = await createStack(meta, stackName, description);
  p.log.success(`Created stack: ${pc.blue(stackName)}`);

  // Get parent branch
  let parent: string | undefined = parentFlag;
  if (!parent) {
    parent = (await selectParent(null, branch)) ?? undefined;
    if (!parent) {
      p.cancel("Cancelled");
      process.exit(0);
    }
  }

  p.log.info(`Parent: ${pc.yellow(parent)}`);

  // Auto-detect PR number
  const s = p.spinner();
  s.start("Looking for PR...");
  const prNumber = await getPrNumber(branch);
  s.stop(prNumber ? `Found PR #${prNumber}` : "No PR found");

  // Get branch description
  let branchDesc: string | undefined;
  if (!nameFlag) {
    // Only prompt for branch description in interactive mode
    const result = await p.text({
      message: "Branch description (optional)",
      placeholder: "e.g., Backend models",
    });
    if (!p.isCancel(result)) {
      branchDesc = (result as string) || undefined;
    }
  }

  // Add branch to stack
  const branchData: Branch = {
    parent,
    ...(prNumber && { pr: prNumber }),
    ...(branchDesc && { description: branchDesc }),
  };

  meta = await addBranchToStack(meta, stackName, branch, branchData);

  p.log.success(`Added ${pc.yellow(branch)} to stack`);

  p.outro(pc.green("Stack initialized!"));

  console.log();
  console.log("  Next steps:");
  console.log(
    `    ${pc.blue("gh-stack add")}          — Add more branches`
  );
  console.log(
    `    ${pc.blue("gh-stack")}              — View stack`
  );
  console.log(
    `    ${pc.blue("gh-stack restack")}      — Sync stack`
  );
}
