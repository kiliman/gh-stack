// gh-stack switch — Switch between branches or stacks
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { writeMetadata, getOrderedBranches, findStackForBranch } from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";
import { selectBranch, selectStack } from "../lib/ui.ts";

export default async function switchCmd(args: string[]): Promise<void> {
  const isStackMode = args.includes("--stack");
  const numberArg = args.find((a) => /^\d+$/.test(a));

  if (args.includes("--help")) {
    console.log(`
gh-stack switch — Switch branch or stack

USAGE
  gh-stack switch <number>      Switch to branch by position (non-interactive)
  gh-stack switch               Interactive branch picker (arrow keys)
  gh-stack switch --stack       Switch between stacks (interactive)

EXAMPLES
  gh-stack switch 1             Jump to first branch in stack (base)
  gh-stack switch 2             Jump to second branch in stack

TIP
  Use 'gh-stack list' to see branch numbers.
`);
    return;
  }

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();

  if (isStackMode) {
    // ── Stack switching ──
    p.intro(pc.cyan("Switch Stack"));

    const stackName = await selectStack(meta, "Switch to stack");
    if (!stackName) {
      p.cancel("Cancelled");
      process.exit(0);
    }

    // Update current_stack
    meta.current_stack = stackName;
    await writeMetadata(meta);

    // Checkout last branch in stack
    const stack = meta.stacks[stackName]!;
    const lastBranch = stack.last_branch;

    if (lastBranch && lastBranch !== currentBranch) {
      p.log.info(`Switching to stack ${pc.yellow(stackName)}`);
      p.log.info(`Checking out ${pc.yellow(lastBranch)}`);
      await git.checkout(lastBranch);
    }

    p.outro(pc.green(`Switched to stack ${pc.yellow(stackName)}`));
  } else {
    // ── Branch switching ──
    // Find current stack
    let stackName = findStackForBranch(meta, currentBranch);
    if (!stackName) stackName = meta.current_stack;

    if (!stackName || !meta.stacks[stackName]) {
      p.cancel(`No active stack found.\n\n  Create one with:\n    ${pc.green("gh-stack init")}`);
      process.exit(1);
    }

    const stack = meta.stacks[stackName]!;
    const ordered = getOrderedBranches(stack);

    if (ordered.length === 0) {
      p.cancel("No branches in this stack");
      process.exit(1);
    }

    let targetBranch: string | null = null;

    if (numberArg) {
      // Switch by number
      const index = parseInt(numberArg, 10) - 1;
      if (index < 0 || index >= ordered.length) {
        p.cancel(`Invalid branch number. Valid range: 1-${ordered.length}`);
        process.exit(1);
      }
      targetBranch = ordered[index]!;
    } else {
      // Interactive selector
      targetBranch = await selectBranch(stack, "Switch to branch", currentBranch);
    }

    if (!targetBranch) {
      p.cancel("Cancelled");
      process.exit(0);
    }

    if (targetBranch === currentBranch) {
      p.log.info(`Already on ${pc.yellow(targetBranch)}`);
      return;
    }

    p.log.info(`Switching to ${pc.yellow(targetBranch)}`);
    await git.checkout(targetBranch);

    // Update last_branch
    stack.last_branch = targetBranch;
    meta.current_stack = stackName;
    await writeMetadata(meta);

    p.log.success(`On branch ${pc.yellow(targetBranch)}`);
  }
}
