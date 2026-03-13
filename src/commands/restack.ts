// git-stack restack — Rebase children onto updated parents
// Port of reference/git-stack-sync.sh — the most critical command
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  readMetadata,
  findStackForBranch,
  buildRebaseChain,
  getOrderedBranches,
  saveRestackState,
  loadRestackState,
  clearRestackState,
  writeMetadata,
} from "../lib/metadata.ts";
import {
  ensureMetadata,
  ensureCleanWorkingTree,
  ensureNotMain,
} from "../lib/safety.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { confirmAction } from "../lib/ui.ts";
import type { StackMetadata } from "../types.ts";

export default async function restack(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const resume = args.includes("--resume");
  const verbose = args.includes("--verbose") || args.includes("-v");

  if (args.includes("--help")) {
    console.log(`
git-stack restack — Rebase children onto updated parents

USAGE
  git-stack restack [options]

OPTIONS
  --yes, -y   Skip confirmations (auto-accept all rebases and pushes)
  --resume    Resume after resolving rebase conflicts
  --dry-run   Show what would happen without executing
  --verbose   Show diagnostic info (tag vs merge-base)

EXAMPLES
  git-stack restack              Interactive (prompts before each rebase)
  git-stack restack --yes        Non-interactive (for agents/CI)
  git-stack restack --resume     Continue after resolving conflicts

ALIASES
  git-stack rebase
`);
    return;
  }

  // Ensure clean working tree (unless resuming)
  if (!resume) {
    await ensureCleanWorkingTree();
  }

  const meta = await ensureMetadata();
  const rebasedBranches: string[] = [];

  p.intro(pc.cyan("Git Stack Restack"));

  if (resume) {
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

  // Cleanup tags
  await git.deleteTagsMatching("stack-sync-*");

  p.outro(pc.green("Stack Restack Complete!"));
}

async function handleResume(
  meta: StackMetadata,
  rebasedBranches: string[],
  verbose: boolean
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
      `Rebase still in progress.\n\n  Complete it first:\n    ${pc.green("git rebase --continue")}\n\n  Or abort:\n    ${pc.red("git rebase --abort")}`
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
    p.log.info(
      "This likely means the rebase was aborted. Cleaning up stale state..."
    );
    await clearRestackState();
    console.log();
    console.log(
      `  State cleared. To sync the stack, run from the desired branch:`
    );
    console.log(`    ${pc.green("git-stack restack")}`);
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
    // Ensure temporary tags exist for remaining branches.
    // If sync created them upfront (correct!), they'll already be here.
    // If not (e.g., old state file), we create them as a fallback —
    // but NOTE: tags created after parent was rebased may be inaccurate.
    p.log.info("Checking base tags for remaining branches...");
    for (let i = currentIndex; i < chain.length; i++) {
      const branch = chain[i]!;
      const parent = stack.branches[branch]?.parent;
      if (!parent) continue;

      const tagName = `stack-sync-base-${git.sanitizeBranchForTag(branch)}`;
      if (await git.tagExists(tagName)) {
        const tagSha = await git.revParse(tagName);
        console.log(
          `  ${pc.green("✓")} Pre-existing tag for ${branch}: ${pc.cyan(tagName)} (${tagSha.slice(0, 8)})`
        );
      } else {
        // Fallback: create tag now (may be inaccurate if parent already rebased)
        p.log.warn(`No pre-existing tag for ${branch} — creating from current merge-base`);
        const mb = await git.mergeBase(branch, parent);
        if (mb) {
          await git.createTag(tagName, mb);
          console.log(
            `  ${pc.yellow("⚠")} Tagged base for ${branch}: ${pc.cyan(tagName)} (${mb.slice(0, 8)})`
          );
        }
      }
    }
    console.log();
  }

  await processChain(meta, stackName, chain, currentIndex, rebasedBranches, false, verbose);
}

async function handleFreshRestack(
  meta: StackMetadata,
  rebasedBranches: string[],
  dryRun: boolean,
  verbose: boolean
): Promise<void> {
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(
      `Branch ${pc.blue(currentBranch)} is not in any stack.\n\n  Add it with:\n    ${pc.green("git-stack add")}`
    );
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;

  // Check for stale tags from previous runs
  await handleStaleTags();

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
    console.log(
      `  ${pc.yellow("→")} ${branch} ${pc.blue(`(parent: ${parent})`)}`
    );
  }
  console.log();

  // Skip base branches (parent = main) unless this is a sync
  const baseBranches = chain.filter(
    (b) => stack.branches[b]?.parent === "main"
  );
  if (baseBranches.length > 0) {
    p.log.warn("Skipping base branch(es) (parent: main):");
    for (const base of baseBranches) {
      console.log(`  ${pc.cyan("Skip:")} ${base} ${pc.blue("(parent: main)")}`);
    }
    console.log();
    console.log(
      `  ${pc.dim("This is a restack — propagating changes from parent to children.")}`
    );
    console.log(
      `  ${pc.dim(`To include rebasing onto main, use: ${pc.green("git-stack sync")}`)}`
    );
    console.log();

    chain = chain.filter((b) => stack.branches[b]?.parent !== "main");

    if (chain.length === 0) {
      p.log.warn("No branches to process after skipping base branches");
      console.log();
      console.log("  Either:");
      console.log("    1. Run from a child branch (e.g., PR2)");
      console.log(
        `    2. Use ${pc.green("git-stack sync")} to include rebasing base onto main`
      );
      return;
    }

    p.log.success(`Processing ${chain.length} branch(es):`);
    for (const branch of chain) {
      const parent = stack.branches[branch]?.parent || "(unknown)";
      console.log(
        `  ${pc.yellow("→")} ${branch} ${pc.blue(`(parent: ${parent})`)}`
      );
    }
    console.log();
  }

  // Take snapshot before destructive operation
  await takeSnapshot(meta, stackName, "restack");

  // Create temporary tags for stable base references
  p.log.info("Creating temporary base tags...");
  for (const branch of chain) {
    const parent = stack.branches[branch]?.parent;
    if (!parent) continue;

    const mb = await git.mergeBase(branch, parent);
    if (mb) {
      const tagName = `stack-sync-base-${git.sanitizeBranchForTag(branch)}`;
      await git.createTag(tagName, mb);
      console.log(
        `  ${pc.green("✓")} Tagged base for ${branch}: ${pc.cyan(tagName)} (${mb.slice(0, 8)})`
      );
    }
  }
  console.log();

  // Process the chain
  await processChain(meta, stackName, chain, 0, rebasedBranches, dryRun, verbose);
}

async function processChain(
  meta: StackMetadata,
  stackName: string,
  chain: string[],
  startIndex: number,
  rebasedBranches: string[],
  dryRun: boolean,
  verbose: boolean
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
    const confirmed = await confirmAction(
      `Rebase ${pc.yellow(branch)} onto ${pc.yellow(parent)}?`
    );
    if (!confirmed) {
      p.log.warn("Skipping rebase");
      continue;
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

    // Use temporary tag as stable base reference
    const tagName = `stack-sync-base-${git.sanitizeBranchForTag(branch)}`;
    let success: boolean;

    if (await git.tagExists(tagName)) {
      const taggedBase = await git.revParse(tagName);
      p.log.info(
        `Using tagged base: ${pc.cyan(tagName)} (${taggedBase.slice(0, 8)})`
      );

      if (verbose) {
        const currentMb = await git.mergeBase(branch, parent);
        console.log();
        console.log(pc.yellow("  Diagnostic: Tag vs Merge-Base"));
        console.log(
          `  ${pc.cyan("Tagged base:")}      ${taggedBase.slice(0, 8)}`
        );
        if (currentMb) {
          console.log(
            `  ${pc.cyan("Current merge-base:")} ${currentMb.slice(0, 8)}`
          );
          if (taggedBase === currentMb) {
            console.log(
              `  ${pc.green("✓ Same")} — Parent hasn't been updated`
            );
          } else {
            console.log(
              `  ${pc.yellow("⚠ Different")} — Parent was rebased (tag protects us!)`
            );
          }
        }
        console.log();
      }

      p.log.info(`Rebasing onto ${pc.yellow(parent)}...`);
      const count = await git.commitCount(taggedBase, branch);
      if (verbose) {
        console.log(`  Moving ${count} commit(s)`);
      }

      success = await git.rebaseOnto(parent, tagName, branch);
    } else {
      // Fallback to merge-base
      p.log.warn("Tag not found, calculating merge-base...");
      const oldBase = await git.mergeBase(branch, parent);

      if (!oldBase) {
        p.log.warn("Could not find merge-base, using simple rebase");
        success = await git.rebase(parent);
      } else {
        p.log.info(`Found merge-base: ${oldBase.slice(0, 8)}`);
        success = await git.rebaseOnto(parent, oldBase, branch);
      }
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
      console.log(`    ${pc.green("git-stack restack --resume")}`);
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

async function handleStaleTags(): Promise<void> {
  try {
    const { $ } = await import("bun");
    const result = await $`git tag -l "stack-sync-*"`.text();
    const tags = result.trim();
    if (!tags) return;

    p.log.warn("Found stale stack-sync-* tags from a previous run");
    console.log();

    const action = await p.select({
      message: "What would you like to do?",
      options: [
        {
          value: "clean",
          label: "Clean up tags and start fresh",
        },
        {
          value: "resume",
          label: "Resume from previous sync (--resume)",
        },
        { value: "abort", label: "Abort (keep tags, exit)" },
      ],
    });

    if (p.isCancel(action) || action === "abort") {
      p.cancel("Aborted");
      process.exit(0);
    }

    if (action === "clean") {
      p.log.info("Cleaning up stale tags...");
      await git.deleteTagsMatching("stack-sync-*");
      p.log.success("Tags cleaned");
    }

    if (action === "resume") {
      // Re-run with --resume flag
      const { default: restack } = await import("./restack.ts");
      await restack(["--resume"]);
      process.exit(0);
    }
  } catch {
    // No stale tags — carry on
  }
}
