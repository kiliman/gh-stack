// gh-stack restack — Rebase children onto updated parents
// Port of reference/gh-stack-sync.sh — the most critical command
import * as p from "../lib/output.ts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  findStackForBranch,
  stackBase,
  buildRebaseChain,
  getOrderedBranches,
  saveRestackState,
  loadRestackState,
  clearRestackState,
  readMetadata,
  writeMetadata,
} from "../lib/metadata.ts";
import {
  ensureMetadata,
  ensureCleanWorkingTree,
  ensureNotMain,
  ensureValidStack,
} from "../lib/safety.ts";
import { takeSnapshot, findPreRewriteSha } from "../lib/snapshot.ts";
import { confirmAction } from "../lib/ui.ts";
import type { StackMetadata } from "../types.ts";

export default async function restack(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const resume = args.includes("--resume");
  const verbose = args.includes("--verbose") || args.includes("-v");

  // --onto <branch>: re-root the current stack onto a new base (e.g. move a
  // split stack from its parent branch onto main once the parent has merged).
  let ontoFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--onto" && args[i + 1]) ontoFlag = args[++i];
  }

  if (args.includes("--help")) {
    console.log(`
gh-stack restack — Rebase children onto updated parents

USAGE
  gh-stack restack [options]
  gh-stack restack --onto <branch>    Re-root the current stack onto <branch>

OPTIONS
  --onto <ref> Re-root the stack onto a new base ref (changes stack base)
  --yes, -y   Skip confirmations (auto-accept all rebases and pushes)
  --resume    Resume after resolving rebase conflicts
  --dry-run   Show what would happen without executing
  --verbose   Show diagnostic info (snapshot vs merge-base)

EXAMPLES
  gh-stack restack              Interactive (prompts before each rebase)
  gh-stack restack --yes        Non-interactive (for agents/CI)
  gh-stack restack --resume     Continue after resolving conflicts
  gh-stack restack --onto main  Re-root a split stack onto main after its
                                parent stack has merged

ALIASES
  gh-stack rebase
`);
    return;
  }

  // Reject if a git rebase is already in progress (unless we're resuming).
  // Letting commands run on top of a half-finished rebase produces deeply
  // confusing state — better to make the user finish or abort first.
  if (!resume && (await git.isRebaseInProgress())) {
    p.cancel(
      `Git rebase already in progress.\n\n  Finish or abort it first:\n    ${pc.green("git rebase --continue")}\n    ${pc.red("git rebase --abort")}\n\n  Then re-run ${pc.green("gh-stack restack")} (or ${pc.green("gh-stack restack --resume")} to continue).`,
    );
    process.exit(1);
  }

  // Ensure clean working tree (unless resuming)
  if (!resume) {
    await ensureCleanWorkingTree();
  }

  const meta = await ensureMetadata();
  const rebasedBranches: string[] = [];

  p.intro(pc.cyan("Git Stack Restack"));

  // Silently drop any leftover temp tags from older versions of gh-stack
  // (pre-snapshot). Keeps users upgrading from <0.4 from seeing stale tags.
  await git.deleteTagsMatching(git.STACK_SYNC_TAG_GLOB);

  if (ontoFlag) {
    await handleReroot(meta, ontoFlag, rebasedBranches, dryRun, verbose);
  } else if (resume) {
    await handleResume(meta, rebasedBranches, verbose);
  } else {
    await handleFreshRestack(meta, rebasedBranches, dryRun, verbose);
  }

  // Summary
  console.log();
  if (rebasedBranches.length === 0) {
    p.log.warn("No branches were rebased");
  } else {
    p.log.success("Rebased branches:");
    for (const branch of rebasedBranches) {
      console.log(`  ${pc.green("✓")} ${branch}`);
    }
  }

  p.outro(pc.green("Stack Restack Complete!"));
}

async function handleResume(
  meta: StackMetadata,
  rebasedBranches: string[],
  verbose: boolean,
): Promise<void> {
  p.log.warn("Resuming from saved state...");

  const state = await loadRestackState();
  if (!state) {
    p.cancel("No saved state found. Nothing to resume.");
    process.exit(1);
  }

  // Check if rebase is still in progress
  if (await git.isRebaseInProgress()) {
    p.cancel(
      `Rebase still in progress.\n\n  Complete it first:\n    ${pc.green("git rebase --continue")}\n\n  Or abort:\n    ${pc.red("git rebase --abort")}`,
    );
    process.exit(1);
  }

  const currentBranch = await git.currentBranch();
  const expectedBranch = state.chain[state.current_index]!;

  // Check for branch mismatch (likely means rebase was aborted)
  if (currentBranch !== expectedBranch) {
    p.log.warn("Branch mismatch detected");
    p.log.info(`Expected: ${pc.blue(expectedBranch)}`);
    p.log.info(`Current:  ${pc.blue(currentBranch)}`);
    console.log();
    p.log.info("This likely means the rebase was aborted. Cleaning up stale state...");
    await clearRestackState();
    console.log();
    console.log(`  State cleared. To sync the stack, run from the desired branch:`);
    console.log(`    ${pc.green("gh-stack restack")}`);
    return;
  }

  // Rebase completed successfully
  p.log.success("Rebase completed successfully");
  rebasedBranches.push(expectedBranch);
  await clearRestackState();

  // Prompt to push the resumed branch
  await promptPush(expectedBranch);

  // Continue with remaining branches in chain
  const stackName = state.stack_name;
  const stack = meta.stacks[stackName];
  if (!stack) return;

  const chain = state.chain;
  const currentIndex = state.current_index + 1;

  if (currentIndex < chain.length) {
    await processChain(meta, stackName, chain, currentIndex, rebasedBranches, false, verbose);
  }
}

async function handleFreshRestack(
  meta: StackMetadata,
  rebasedBranches: string[],
  dryRun: boolean,
  verbose: boolean,
): Promise<void> {
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(
      `Branch ${pc.blue(currentBranch)} is not in any stack.\n\n  Add it with:\n    ${pc.green("gh-stack add")}`,
    );
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  await ensureValidStack(meta, stackName);

  // Build the rebase chain from current branch
  p.log.info("Building rebase chain...");
  let chain = buildRebaseChain(stack, currentBranch);

  if (chain.length === 0) {
    p.cancel("Could not build rebase chain");
    process.exit(1);
  }

  // Show the chain
  p.log.success(`Found ${chain.length} branch(es) to process:`);
  for (const branch of chain) {
    const parent = stack.branches[branch]?.parent || "(unknown)";
    console.log(`  ${pc.yellow("→")} ${branch} ${pc.blue(`(parent: ${parent})`)}`);
  }
  console.log();

  // Skip the stack's root branch (parent = base) when the base is the trunk —
  // rebasing onto trunk is `sync`'s job, not restack's. For a split stack
  // whose base is a sibling branch, the root SHOULD be rebased onto that base
  // so changes propagate, so we don't skip it.
  const base = stackBase(stack);
  const baseIsTrunk = base === "main" || base === "master";
  const baseBranches = baseIsTrunk ? chain.filter((b) => stack.branches[b]?.parent === base) : [];
  if (baseBranches.length > 0) {
    p.log.warn(`Skipping base branch(es) (parent: ${base}):`);
    for (const baseBranch of baseBranches) {
      console.log(`  ${pc.cyan("Skip:")} ${baseBranch} ${pc.blue(`(parent: ${base})`)}`);
    }
    console.log();
    console.log(`  ${pc.dim("This is a restack — propagating changes from parent to children.")}`);
    console.log(
      `  ${pc.dim(`To include rebasing onto ${base}, use: ${pc.green("gh-stack sync")}`)}`,
    );
    console.log();

    chain = chain.filter((b) => stack.branches[b]?.parent !== base);

    if (chain.length === 0) {
      p.log.warn("No branches to process after skipping base branches");
      console.log();
      console.log("  Either:");
      console.log("    1. Run from a child branch (e.g., PR2)");
      console.log(`    2. Use ${pc.green("gh-stack sync")} to include rebasing base onto main`);
      return;
    }

    p.log.success(`Processing ${chain.length} branch(es):`);
    for (const branch of chain) {
      const parent = stack.branches[branch]?.parent || "(unknown)";
      console.log(`  ${pc.yellow("→")} ${branch} ${pc.blue(`(parent: ${parent})`)}`);
    }
    console.log();
  }

  if (!dryRun) {
    // Take snapshot before destructive operation. This preserves the current
    // tip of every branch so subsequent restacks (after a parent is rewritten)
    // can find the correct rebase base.
    await takeSnapshot(meta, stackName, "restack");
  }

  // Process the chain
  await processChain(meta, stackName, chain, 0, rebasedBranches, dryRun, verbose);
}

/**
 * Re-root the current stack onto a new base (`restack --onto <newBase>`).
 *
 * Used to move a split stack off its parent-stack branch and onto the trunk
 * once that parent stack has merged. The root branch is rebased with
 * `git rebase --onto <newBase> <oldBaseTip> <root>`, where oldBaseTip is the
 * tip of the current base branch — so only the root's own commits replay onto
 * the new base (the now-merged parent commits are dropped). Children then
 * restack onto the moved root via the normal chain logic.
 */
async function handleReroot(
  meta: StackMetadata,
  newBase: string,
  rebasedBranches: string[],
  dryRun: boolean,
  verbose: boolean,
): Promise<void> {
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(`Branch ${pc.blue(currentBranch)} is not in any stack.`);
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  await ensureValidStack(meta, stackName);

  const oldBase = stackBase(stack);
  if (oldBase === newBase) {
    p.log.warn(
      `${pc.yellow(stackName)} is already based on ${pc.yellow(newBase)} — nothing to do.`,
    );
    return;
  }

  // The root is the branch whose parent is the current base.
  const ordered = getOrderedBranches(stack);
  const root = ordered[0];
  if (!root) {
    p.cancel("Stack has no branches");
    process.exit(1);
  }

  // The rebase base = the tip the root was built on (the old base branch).
  // Prefer the live branch tip; fall back to merge-base if it's already gone.
  let oldBaseTip: string | null = null;
  let oldBaseSource = "old-base branch tip";
  if (await git.localBranchExists(oldBase)) {
    oldBaseTip = await git.revParse(oldBase);
  } else {
    oldBaseTip = await git.mergeBase(root, newBase);
    oldBaseSource = "merge-base (old base branch is gone — verify the result)";
  }

  if (!oldBaseTip) {
    p.cancel(
      `Could not determine the old base for ${pc.yellow(root)}.\n\n  Re-root manually with: ${pc.green(
        `git rebase --onto ${newBase} <old-base> ${root}`,
      )}`,
    );
    process.exit(1);
  }

  p.log.info(`Re-rooting ${pc.yellow(stackName)}: ${pc.dim(oldBase)} → ${pc.green(newBase)}`);
  p.log.info(`Root branch: ${pc.yellow(root)}`);
  if (verbose) {
    p.log.info(`Rebase base: ${oldBaseTip.slice(0, 8)} (${oldBaseSource})`);
  }
  console.log();

  if (dryRun) {
    p.log.warn(`[DRY RUN] Would rebase ${root} onto ${newBase} (from ${oldBaseTip.slice(0, 8)})`);
    const children = ordered.slice(1);
    if (children.length > 0) {
      p.log.info(`[DRY RUN] Would restack ${children.length} child branch(es) onto the moved root`);
    }
    return;
  }

  const confirmed = await confirmAction(
    `Re-root ${pc.yellow(stackName)} onto ${pc.yellow(newBase)}?`,
  );
  if (!confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Snapshot before rewriting, then commit the new base into metadata.
  await takeSnapshot(meta, stackName, "reroot");
  stack.base = newBase;
  stack.branches[root]!.parent = newBase;
  await writeMetadata(meta);

  // Rebase the root onto the new base, dropping the old base's commits.
  p.log.info(`Checking out ${pc.yellow(root)}...`);
  await git.checkout(root);
  p.log.info(`Rebasing ${pc.yellow(root)} onto ${pc.yellow(newBase)}...`);
  const ok = await git.rebaseOnto(newBase, oldBaseTip, root);

  if (!ok) {
    console.log();
    p.log.error("Rebase conflict — resolve and run:");
    console.log(`  ${pc.green("git rebase --continue")}`);
    console.log(
      `  ${pc.green("gh-stack restack")}   ${pc.dim("(from the first child, to restack the rest)")}`,
    );
    process.exit(2);
  }

  rebasedBranches.push(root);
  await promptPush(root);

  // Restack the children onto the moved root.
  const children = ordered.slice(1);
  if (children.length > 0) {
    const chain = buildRebaseChain(stack, children[0]!);
    await processChain(meta, stackName, chain, 0, rebasedBranches, false, verbose);
  }
}

async function processChain(
  meta: StackMetadata,
  stackName: string,
  chain: string[],
  startIndex: number,
  rebasedBranches: string[],
  dryRun: boolean,
  verbose: boolean,
): Promise<void> {
  const stack = meta.stacks[stackName]!;

  for (let i = startIndex; i < chain.length; i++) {
    const branch = chain[i]!;
    const parent = stack.branches[branch]?.parent;

    if (!parent) {
      p.log.warn(`Skipping ${branch} (no parent defined)`);
      continue;
    }

    console.log();
    console.log(pc.cyan("━".repeat(40)));
    console.log(`${pc.blue("Branch:")}  ${branch}`);
    console.log(`${pc.blue("Parent:")}  ${parent}`);
    console.log(pc.cyan("━".repeat(40)));
    console.log();

    // Check if already up to date
    if (await git.isAncestor(parent, branch)) {
      p.log.success("Already up to date with parent");
      continue;
    }

    // Dry run mode
    if (dryRun) {
      p.log.warn(`[DRY RUN] Would rebase ${branch} onto ${parent}`);
      continue;
    }

    // Prompt for rebase
    const confirmed = await confirmAction(`Rebase ${pc.yellow(branch)} onto ${pc.yellow(parent)}?`);
    if (!confirmed) {
      p.log.warn("Skipping rebase");
      continue;
    }

    // Resolve the rebase base.
    //
    //   Strategy:
    //     1. Look for a recent snapshot where the parent's recorded tip is no
    //        longer an ancestor of the parent's current tip AND is still an
    //        ancestor of the child. That recorded SHA is the orphaned
    //        old-parent tip — exactly the rebase base we need.
    //     2. Fall back to `merge-base(branch, parent)` if no snapshot tells us
    //        the parent was rewritten (typical case: parent only had commits
    //        appended, not rebased).
    //
    //   The child-ancestry check (issue #5) prevents stale snapshots from
    //   older sessions — where the child has already been rebased past the
    //   recorded point — from being used as a rebase base.
    //
    //   Re-read metadata fresh because previous iterations of this loop may
    //   have updated snapshots.
    const freshMeta = (await readMetadata()) ?? meta;
    const oldBaseFromSnapshot = await findPreRewriteSha(freshMeta, parent, branch);
    const oldBaseFromMergeBase = await git.mergeBase(branch, parent);
    const oldBase = oldBaseFromSnapshot ?? oldBaseFromMergeBase;

    if (verbose) {
      console.log();
      console.log(pc.yellow("  Diagnostic: base resolution"));
      console.log(
        `  ${pc.cyan("Snapshot pre-rewrite tip:")} ${oldBaseFromSnapshot?.slice(0, 8) ?? "(none)"}`,
      );
      console.log(
        `  ${pc.cyan("Current merge-base:")}      ${oldBaseFromMergeBase?.slice(0, 8) ?? "(none)"}`,
      );
      if (
        oldBaseFromSnapshot &&
        oldBaseFromMergeBase &&
        oldBaseFromSnapshot !== oldBaseFromMergeBase
      ) {
        console.log(
          `  ${pc.yellow("⚠ Parent was rewritten")} — using snapshot base (would have replayed parent commits otherwise)`,
        );
      }
      console.log();
    }

    // Checkout the branch
    p.log.info(`Checking out ${pc.yellow(branch)}...`);
    await git.checkout(branch);

    // Save state for resume
    await saveRestackState({
      current_index: i,
      stack_name: stackName,
      chain,
    });

    let success: boolean;
    if (oldBase) {
      const sourceLabel = oldBaseFromSnapshot ? "snapshot" : "merge-base";
      p.log.info(
        `Rebasing onto ${pc.yellow(parent)} (base: ${oldBase.slice(0, 8)} from ${sourceLabel})`,
      );

      if (verbose) {
        const count = await git.commitCount(oldBase, branch);
        console.log(`  Moving ${count} commit(s)`);
      }

      success = await git.rebaseOnto(parent, oldBase, branch);
    } else {
      p.log.warn("Could not determine rebase base — using simple rebase");
      success = await git.rebase(parent);
    }

    if (success) {
      p.log.success("Rebase successful");
      rebasedBranches.push(branch);
      await clearRestackState();

      // Prompt to push immediately (don't batch)
      await promptPush(branch);
    } else {
      // Conflict!
      console.log();
      console.log(pc.red("━".repeat(40)));
      console.log(pc.red("  Rebase Conflict"));
      console.log(pc.red("━".repeat(40)));
      console.log();
      console.log(pc.yellow("Conflicts detected during rebase."));
      console.log();
      console.log("  Please resolve the conflicts, then:");
      console.log(`    ${pc.green("git rebase --continue")}`);
      console.log(`    ${pc.green("gh-stack restack --resume")}`);
      console.log();
      console.log("  Or abort the rebase:");
      console.log(`    ${pc.red("git rebase --abort")}`);
      process.exit(2);
    }
  }
}

async function promptPush(branch: string): Promise<void> {
  ensureNotMain(branch);

  if (!(await git.remoteBranchExists(branch))) return;

  const localSha = await git.revParse(branch);
  let remoteSha: string;
  try {
    remoteSha = await git.revParse(`origin/${branch}`);
  } catch {
    return;
  }

  if (localSha === remoteSha) return;

  console.log();
  console.log(pc.cyan("━".repeat(40)));
  console.log(pc.blue("  Push Rebased Branch?"));
  console.log(pc.cyan("━".repeat(40)));
  console.log();
  console.log(`${pc.blue("Branch:")} ${branch}`);
  console.log(pc.yellow("⚠ Branch is out of sync with remote"));
  console.log(`  Local:  ${localSha.slice(0, 8)}`);
  console.log(`  Remote: ${remoteSha.slice(0, 8)}`);
  console.log();

  const confirmed = await confirmAction("Push with --force-with-lease?");
  if (confirmed) {
    p.log.info(`Pushing ${branch}...`);
    const ok = await git.forcePushWithLease(branch);
    if (ok) {
      p.log.success("Pushed successfully");
    } else {
      p.log.error("Push failed — you may need to push manually later");
    }
  } else {
    p.log.warn("Skipping push (you'll need to push manually)");
  }
}
