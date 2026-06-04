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
import { detectBranchChain } from "../lib/chain.ts";
import type { StackMetadata } from "../types.ts";

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
    await suggestNextStep(meta, branch);
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

/**
 * The current branch isn't a tracked stack member. Inspect its local ancestry —
 * the same chain `submit` would self-heal — and point at the lowest-friction
 * next step:
 *   - sits on top of an existing stack  → `submit` to ADD it to that stack;
 *   - stacked on untracked branches only → `submit` to CREATE a new stack;
 *   - based directly on trunk            → `submit` to push + open a PR;
 *   - on trunk                           → `init`.
 */
async function suggestNextStep(meta: StackMetadata, branch: string): Promise<void> {
  const trunk = await git.trunkBranch();

  if (branch === trunk || branch === "main" || branch === "master") {
    p.log.warn(`You're on ${pc.blue(branch)} — not a stack branch`);
    console.log();
    console.log(`  Checkout a feature branch, then start a stack with:`);
    console.log(`    ${pc.green("gh-stack init")}`);
    console.log();
    return;
  }

  // Reconstruct trunk→current the way `submit` does (local branches whose tips
  // are ancestors of HEAD). [current] alone means it's based right off trunk.
  let chain: string[] = [branch];
  try {
    chain = await detectBranchChain(branch, trunk);
  } catch {
    // Fall back to treating it as a single branch off trunk.
  }

  // Is this chain sitting on top of an existing tracked stack? Find the nearest
  // ancestor in the chain that's already a stack member.
  let attachStack: string | null = null;
  for (let i = chain.length - 2; i >= 0; i--) {
    const owner = findStackForBranch(meta, chain[i]!);
    if (owner) {
      attachStack = owner;
      break;
    }
  }

  p.log.warn(`Branch ${pc.blue(branch)} isn't tracked in a stack yet`);
  console.log();

  if (attachStack) {
    // Extends an existing stack — submit ADDS the untracked tail to it.
    console.log(`  It sits on top of stack ${pc.yellow(attachStack)}:`);
    console.log();
    console.log(`  ${pc.dim(trunk)}`);
    for (let i = 0; i < chain.length; i++) {
      const b = chain[i]!;
      const isLast = i === chain.length - 1;
      const tree = isLast ? "  ┗━" : "  ┣━";
      const label = b === branch ? pc.yellow(b) + pc.dim(" (current)") : b;
      const tag = findStackForBranch(meta, b) ? pc.dim(" (in stack)") : pc.green(" +");
      console.log(`${tree} ${label}${tag}`);
      if (!isLast) console.log("  ┃");
    }
    console.log();
    console.log(`  Add it to the stack:`);
    console.log(`    ${pc.green("gh-stack submit")}`);
    console.log();
    return;
  }

  if (chain.length > 1) {
    // Stacked on untracked branches only — submit CREATES a new stack.
    console.log(`  It's stacked on ${chain.length - 1} other local branch(es):`);
    console.log();
    console.log(`  ${pc.dim(trunk)}`);
    for (let i = 0; i < chain.length; i++) {
      const b = chain[i]!;
      const isLast = i === chain.length - 1;
      const tree = isLast ? "  ┗━" : "  ┣━";
      const label = b === branch ? pc.yellow(b) + pc.dim(" (current)") : b;
      console.log(`${tree} ${label}`);
      if (!isLast) console.log("  ┃");
    }
    console.log();
    console.log(`  Create the stack and open PRs for the whole chain:`);
  } else {
    // A single branch based directly on trunk.
    console.log(`  It's based directly on ${pc.dim(trunk)}.`);
    console.log();
    console.log(`  Push it and open a PR — this also starts the stack:`);
  }
  console.log(`    ${pc.green("gh-stack submit")}`);
  console.log();
}
