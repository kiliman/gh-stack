// gh-stack log — Display current stack tree (default command)
import * as p from "../lib/output.ts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  readMetadata,
  metadataExists,
  findStackForBranch,
  writeMetadata,
} from "../lib/metadata.ts";
import { renderStackTree } from "../lib/ui.ts";
import { gateLegacyMetadata } from "../lib/safety.ts";

export default async function log(_args: string[]): Promise<void> {
  // Check if metadata exists
  if (!(await metadataExists())) {
    await gateLegacyMetadata(); // exits with a migrate hint if a v2 file remains
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

  // The current stack is whichever stack the checked-out branch belongs to —
  // never the persisted `current_stack` hint. If this branch is in no stack,
  // there is no current stack; don't resurface a previously-used one.
  const stackName = findStackForBranch(meta, branch);

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

  // We're on a branch in this stack — record it as current + its last_branch.
  meta.current_stack = stackName;
  stack.last_branch = branch;
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
  console.log(pc.dim(`Tip: Switch stacks with 'gh-stack checkout --stack'`));
  console.log();
}
