// gh-stack show — Display current stack tree (default command)
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  readMetadata,
  metadataExists,
  findStackForBranch,
  writeMetadata,
} from "../lib/metadata.ts";
import { renderStackTree } from "../lib/ui.ts";

export default async function show(_args: string[]): Promise<void> {
  // Check if metadata exists
  if (!(await metadataExists())) {
    p.log.warn("No stack metadata found");
    console.log();
    console.log(`  Create your first stack with:`);
    console.log(`    ${pc.green("gh-stack init")}`);
    process.exit(1);
  }

  const meta = await readMetadata();
  if (!meta) {
    p.cancel("Failed to read stack metadata");
    process.exit(1);
  }

  const branch = await git.currentBranch();

  // Find which stack contains the current branch
  const branchStackName = findStackForBranch(meta, branch);
  let stackName = branchStackName;

  if (!stackName) {
    // Fall back to current_stack
    stackName = meta.current_stack;
  }

  if (!stackName || !meta.stacks[stackName]) {
    p.log.warn(`Branch ${pc.blue(branch)} is not in any stack`);
    console.log();
    console.log(`  Add it to a stack with:`);
    console.log(`    ${pc.green("gh-stack add")}`);
    console.log();
    console.log(`  Or create a new stack:`);
    console.log(`    ${pc.green("gh-stack init")}`);
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;

  // Update current_stack and last_branch
  meta.current_stack = stackName;
  if (branchStackName === stackName) {
    stack.last_branch = branch;
  }
  await writeMetadata(meta);

  // Header
  console.log();
  console.log(`${pc.blue("📚 PR Stack:")} ${pc.yellow(stackName)}`);
  if (stack.description) {
    console.log(`   ${pc.dim(stack.description)}`);
  }
  console.log();

  // Render tree
  const tree = renderStackTree(stack, branch);
  console.log(tree);
  console.log();

  // Tip
  console.log(pc.dim(`Tip: Switch stacks with 'gh-stack switch --stack'`));
  console.log();
}
