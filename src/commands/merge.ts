// gh-stack merge — Local squash-merge top-down
// From reference/gh-stack-merge-design.md
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { findStackForBranch, getOrderedBranches, writeMetadata } from "../lib/metadata.ts";
import { ensureMetadata, ensureCleanWorkingTree } from "../lib/safety.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { closePr } from "../lib/github.ts";
import { confirmAction } from "../lib/ui.ts";

export default async function merge(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");

  if (args.includes("--help")) {
    console.log(`
gh-stack merge — Local squash-merge top-down

USAGE
  gh-stack merge [--dry-run]

Squash-merges the stack from top to bottom locally:
  PR3 → PR2 → PR1, then optionally rebases PR1 onto main.

This keeps all commits local (avoiding orphaned squash commits).
`);
    return;
  }

  await ensureCleanWorkingTree();

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(`Branch ${pc.blue(currentBranch)} not found in any stack`);
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);

  if (ordered.length <= 1) {
    p.log.info("Single branch stack — nothing to merge down.");
    p.log.info("Just merge via GitHub as normal.");
    return;
  }

  p.intro(pc.cyan("Git Stack Merge (Top-Down)"));

  p.log.info(`Stack: ${pc.yellow(stackName)}`);
  console.log();

  // Show the merge plan: from top to bottom
  const reversed = [...ordered].reverse();
  console.log(`  ${pc.bold("Merge plan:")}`);
  for (let i = 0; i < reversed.length - 1; i++) {
    const child = reversed[i]!;
    const parent = stack.branches[child]?.parent || "???";
    const childPr = stack.branches[child]?.pr;
    console.log(`    ${pc.yellow(child)}${childPr ? ` (#${childPr})` : ""} → ${pc.blue(parent)}`);
  }
  console.log(`    ${pc.blue(ordered[0]!)} → ${pc.green("main")} (via GitHub)`);
  console.log();

  if (dryRun) {
    p.outro(pc.yellow("[DRY RUN] No changes made"));
    return;
  }

  const confirmed = await confirmAction("Merge stack top-down?");
  if (!confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Take snapshot
  await takeSnapshot(meta, stackName, "merge");

  // Merge top-down: for each branch from top to bottom (skip the base)
  for (let i = 0; i < reversed.length - 1; i++) {
    const childBranch = reversed[i]!;
    const parentBranch = stack.branches[childBranch]?.parent;
    if (!parentBranch || parentBranch === "main") continue;

    const childPr = stack.branches[childBranch]?.pr;
    const childTitle = stack.branches[childBranch]?.description || childBranch;

    console.log();
    console.log(pc.cyan("━".repeat(40)));
    console.log(`${pc.blue("Merge:")} ${pc.yellow(childBranch)} → ${pc.blue(parentBranch)}`);
    console.log(pc.cyan("━".repeat(40)));
    console.log();

    // Checkout parent
    p.log.info(`Checking out ${pc.yellow(parentBranch)}...`);
    await git.checkout(parentBranch);

    // Squash merge child
    p.log.info(`Squash-merging ${pc.yellow(childBranch)}...`);
    const success = await git.mergeSquash(childBranch);

    if (!success) {
      p.log.error("Merge conflict — resolve and try again");
      process.exit(2);
    }

    // Commit
    const commitMsg = childPr ? `squash: ${childTitle} (#${childPr})` : `squash: ${childTitle}`;

    await git.commit(commitMsg);
    p.log.success(`Merged ${childBranch} into ${parentBranch}`);
  }

  // Optionally rebase base onto main
  console.log();
  const baseBranch = ordered[0]!;
  const rebaseConfirmed = await confirmAction(`Rebase ${pc.yellow(baseBranch)} onto latest main?`);

  if (rebaseConfirmed) {
    p.log.info("Fetching latest main...");
    await git.fetchMain();

    p.log.info(`Checking out ${pc.yellow(baseBranch)}...`);
    await git.checkout(baseBranch);

    const success = await git.rebase("origin/main");
    if (success) {
      p.log.success("Rebased onto main");
    } else {
      p.log.error("Rebase conflict — resolve manually");
      process.exit(2);
    }
  }

  // Close intermediate PRs
  console.log();
  const closePrs = await confirmAction("Close intermediate PRs on GitHub?");

  if (closePrs) {
    const basePr = stack.branches[ordered[0]!]?.pr;
    for (let i = 1; i < ordered.length; i++) {
      const prNum = stack.branches[ordered[i]!]?.pr;
      if (prNum) {
        const comment = basePr
          ? `Merged locally into base PR #${basePr}. See the base PR for the full stack.`
          : "Merged locally into base PR.";
        const ok = await closePr(prNum, comment);
        if (ok) {
          p.log.success(`Closed PR #${prNum}`);
        } else {
          p.log.warn(`Could not close PR #${prNum}`);
        }
      }
    }
  }

  // Archive the stack
  if (!meta.archive) meta.archive = {};
  meta.archive[stackName] = { ...stack };
  delete meta.stacks[stackName];
  if (meta.current_stack === stackName) {
    const remaining = Object.keys(meta.stacks);
    meta.current_stack = remaining.length > 0 ? remaining[0]! : null;
  }
  await writeMetadata(meta);

  p.outro(pc.green("Stack merge complete! Stack archived."));

  console.log();
  console.log("  Next steps:");
  console.log(`    1. Push ${pc.yellow(baseBranch)} and let CI run`);
  console.log(`    2. Squash-merge ${pc.yellow(baseBranch)} into main via GitHub`);
}
