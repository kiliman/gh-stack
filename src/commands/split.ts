// gh-stack split — Cut a stack into two at a given branch.
//
// The branch you cut at (and everything above it) moves into a NEW stack whose
// base is the cut branch's parent — a branch that stays in the original stack.
// This is a pure metadata operation: no branches are moved or rebased in git,
// since stack membership is just bookkeeping on top of the real branch graph.
//
// Typical use: a long chain is in review and can't merge yet, but new work is
// piling on top. Split at the first "new work" branch so the original stack
// stays the review unit and the new stack rides on its tip. Once the original
// stack merges, re-root the new stack onto main with `gh-stack restack --onto main`.
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { buildRebaseChain, getOrderedBranches, stackBase, writeMetadata } from "../lib/metadata.ts";
import {
  ensureMetadata,
  ensureCurrentStack,
  ensureValidStack,
  resolveStackForBranchArg,
} from "../lib/safety.ts";
import { selectBranch, confirmAction } from "../lib/ui.ts";
import * as git from "../lib/git.ts";
import type { Stack } from "../types.ts";

const HELP = `
gh-stack split — Cut a stack into two at a branch

USAGE
  gh-stack split [<branch>] [options]

The branch you cut at — and every branch above it — moves into a new stack
whose base is the cut branch's parent (which stays in the original stack).
Purely a metadata operation: no git branches are moved or rebased.

If no branch is given, shows an interactive selector. You cannot split at the
stack's root branch (that would just rename the whole stack).

OPTIONS
  --name <name>   Name for the new stack (default: the cut branch name)

EXAMPLES
  gh-stack split feat-12                 # feat-12.. become a new stack based on feat-11
  gh-stack split feat-12 --name phase-2  # ...named "phase-2"

AFTER THE ORIGINAL STACK MERGES
  gh-stack restack --onto main           # re-root the split stack onto main
`;

export default async function split(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }

  // Parse flags
  let nameFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) nameFlag = args[++i];
  }
  const positional = args.filter((a) => !a.startsWith("-"));

  const meta = await ensureMetadata();
  // The cut branch names its own stack — resolve from it so `split <branch>`
  // works from anywhere. Only fall back to the current stack (the branch you're
  // on) in interactive mode, when no branch was given.
  const stackName = positional[0]
    ? resolveStackForBranchArg(meta, positional[0]!)
    : ensureCurrentStack(meta);
  await ensureValidStack(meta, stackName);
  const stack = meta.stacks[stackName]!;
  const currentBranch = await git.currentBranch();
  const base = stackBase(stack);

  p.intro(pc.cyan("Split Stack"));

  // Determine the cut branch
  let cutBranch = positional[0];
  if (!cutBranch) {
    cutBranch =
      (await selectBranch(
        stack,
        "Select the branch to cut at (it becomes the new stack's root)",
        currentBranch,
      )) ?? undefined;
    if (!cutBranch) {
      p.cancel("Cancelled");
      process.exit(0);
    }
  }

  // Validate
  const cut = stack.branches[cutBranch];
  if (!cut) {
    p.cancel(`Branch ${pc.yellow(cutBranch)} not found in stack ${pc.blue(stackName)}`);
    process.exit(1);
  }

  if (cut.parent === base) {
    p.cancel(
      `${pc.yellow(cutBranch)} is the root of ${pc.blue(stackName)} — there's nothing below it to split off.\n\n  Pick a branch higher up the stack.`,
    );
    process.exit(1);
  }

  // The new stack is the subtree rooted at the cut branch.
  const moving = buildRebaseChain(stack, cutBranch);
  const newBase = cut.parent; // stays in the original stack

  // Pick a name for the new stack (default = cut branch, auto-suffix on clash)
  let newName = nameFlag || cutBranch;
  if (!nameFlag) {
    let n = 2;
    while (meta.stacks[newName]) newName = `${cutBranch}-${n++}`;
  }
  if (meta.stacks[newName]) {
    p.cancel(`Stack "${newName}" already exists`);
    process.exit(1);
  }

  // Report the plan
  p.log.info(`Stack: ${pc.yellow(stackName)} (base: ${pc.dim(base)})`);
  p.log.info(`Cut at: ${pc.yellow(cutBranch)} (parent: ${pc.dim(newBase)})`);
  p.log.info(
    `Moving ${moving.length} branch${moving.length > 1 ? "es" : ""} into new stack ${pc.yellow(newName)} (base: ${pc.dim(newBase)})`,
  );
  for (const b of moving) {
    console.log(`    ${pc.dim("→")} ${b}`);
  }
  console.log();

  const confirmed = await confirmAction(
    `Split ${moving.length} branch(es) into ${pc.yellow(newName)} based on ${pc.yellow(newBase)}?`,
  );
  if (!confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // ── Pure metadata move ──
  const newStack: Stack = {
    description: stack.description ? `Split from ${stackName}` : "",
    last_branch: null,
    branches: {},
    base: newBase,
  };

  for (const b of moving) {
    newStack.branches[b] = stack.branches[b]!; // parent links stay valid within the subtree
    delete stack.branches[b];
  }

  meta.stacks[newName] = newStack;

  // Recompute last_branch for both stacks from their now-final graphs
  newStack.last_branch = getOrderedBranches(newStack).at(-1) ?? null;
  stack.last_branch = getOrderedBranches(stack).at(-1) ?? null;

  // Follow the user: if they're standing on a moved branch, make the new stack
  // current; otherwise leave the original stack current.
  meta.current_stack = moving.includes(currentBranch) ? newName : stackName;

  await writeMetadata(meta);

  p.outro(
    pc.green(
      `Split ${pc.yellow(stackName)} → ${pc.yellow(newName)} (${moving.length} branch(es), based on ${pc.yellow(newBase)})`,
    ),
  );
}
