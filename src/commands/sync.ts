// gh-stack sync — Fetch main, rebase base branch onto main, then restack all
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { $ } from "bun";
import * as git from "../lib/git.ts";
import {
  findStackForBranch,
  getOrderedBranches,
  removeBranchFromStack,
  saveRestackState,
  stackBase,
  writeMetadata,
} from "../lib/metadata.ts";
import { ensureMetadata, ensureCleanWorkingTree, ensureValidStack } from "../lib/safety.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { confirmAction } from "../lib/ui.ts";
import { getPrInfo } from "../lib/github.ts";
import { planMerges, advanceNewBottom, type BranchReview } from "../lib/advance.ts";
import type { StackMetadata } from "../types.ts";

export default async function sync(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");

  if (args.includes("--help")) {
    console.log(`
gh-stack sync — Sync base with main + restack all

USAGE
  gh-stack sync [--dry-run]

Fetches latest main, rebases the base branch onto main,
then restacks all children. Equivalent to running restack
with the base branch included.
`);
    return;
  }

  // Reject if a git rebase is already in progress. Letting sync run on top
  // of a half-finished rebase produces deeply confusing state — make the
  // user finish or abort it first.
  if (await git.isRebaseInProgress()) {
    p.cancel(
      `Git rebase already in progress.\n\n  Finish or abort it first:\n    ${pc.green("git rebase --continue")}\n    ${pc.red("git rebase --abort")}\n\n  Then re-run ${pc.green("gh-stack sync")}.`,
    );
    process.exit(1);
  }

  await ensureCleanWorkingTree();

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(`Branch ${pc.blue(currentBranch)} not found in any stack`);
    process.exit(1);
  }

  let stack = meta.stacks[stackName]!;
  await ensureValidStack(meta, stackName);
  let ordered = getOrderedBranches(stack);

  if (ordered.length === 0) {
    p.cancel("No branches in this stack");
    process.exit(1);
  }

  p.intro(pc.cyan("Git Stack Sync"));

  // Find the root branch (whose parent is the stack's base)
  const base = stackBase(stack);
  const baseIsTrunk = base === "main" || base === "master";

  // sync only makes sense for trunk-rooted stacks — it fetches main and
  // rebases onto it. A split stack is rooted on a branch in another stack, so
  // syncing it means restacking onto that base (handled by `restack`), or
  // re-rooting onto main once the parent stack has merged.
  if (!baseIsTrunk) {
    p.cancel(
      `${pc.yellow(stackName)} is based on ${pc.yellow(base)}, not main — sync doesn't apply.\n\n` +
        `  • Parent moved? Restack onto it:   ${pc.green("gh-stack restack")}\n` +
        `  • Parent stack merged to main?     ${pc.green("gh-stack restack --onto main")}`,
    );
    process.exit(1);
  }

  // Catch up to reality first: if the bottom PR(s) already landed on the trunk
  // outside gh-stack (e.g. the GitHub web UI), the stack metadata still lists
  // them. A plain rebase onto main would then replay their now-squashed commits
  // and conflict — so advance past them (re-rooting the survivor onto main with
  // `--onto`) before the normal sync runs. (#20)
  const advance = await advanceMergedBottoms(meta, stackName, base, dryRun);
  if (advance.drained) {
    p.outro(pc.green("Bottom PR(s) already merged — stack fully drained & archived."));
    return;
  }
  if (dryRun && advance.detected) {
    // The advance plan was printed above; the normal rebase plan below would be
    // misleading (it'd show replaying the merged commits), so stop here.
    p.outro(pc.green("Sync dry run complete"));
    return;
  }
  if (advance.advanced) {
    // Topology changed — re-derive the root from the freshly-updated metadata.
    stack = meta.stacks[stackName]!;
    ordered = getOrderedBranches(stack);
  }

  const baseBranch = ordered[0]!;
  const baseParent = stack.branches[baseBranch]?.parent;

  if (baseParent !== base) {
    p.cancel(`Root branch ${pc.yellow(baseBranch)} doesn't have ${base} as parent`);
    process.exit(1);
  }

  if (dryRun) {
    p.log.warn("[DRY RUN] No changes will be made");
    p.log.info("Planned operations:");
    console.log(`  ${pc.yellow("1.")} Fetch latest ${pc.cyan("origin/main")}`);
    console.log(
      `  ${pc.yellow("2.")} Rebase ${pc.yellow(baseBranch)} onto ${pc.cyan("origin/main")}`,
    );

    const children = ordered.slice(1);
    if (children.length === 0) {
      console.log(`  ${pc.yellow("3.")} No child branches to restack`);
    } else {
      console.log(`  ${pc.yellow("3.")} Restack child branches in order:`);
      for (const branch of children) {
        const parent = stack.branches[branch]?.parent || "(unknown)";
        console.log(`     ${pc.yellow("→")} ${branch} ${pc.blue(`(parent: ${parent})`)}`);
      }
    }
    p.outro(pc.green("Sync dry run complete"));
    return;
  }

  // Fetch main
  const fetchSpinner = p.spinner();
  fetchSpinner.start("Fetching latest main...");
  await git.fetchMain();
  fetchSpinner.stop("Fetched latest main");

  // Take snapshot BEFORE rebasing. This records every branch's pre-rebase
  // tip — including the orphaned base-branch tip that restack will later
  // need to find when restacking children. (See findPreRewriteSha.)
  await takeSnapshot(meta, stackName, "sync");

  // Step 1: Rebase base branch onto main
  console.log();
  console.log(pc.cyan("━".repeat(40)));
  console.log(`${pc.blue("Step 1:")} Rebase ${pc.yellow(baseBranch)} onto main`);
  console.log(pc.cyan("━".repeat(40)));
  console.log();

  // Check if already up to date
  if (await git.isAncestor("origin/main", baseBranch)) {
    p.log.success(`${baseBranch} is already up to date with main`);
  } else if (dryRun) {
    p.log.warn(`[DRY RUN] Would rebase ${baseBranch} onto origin/main`);
  } else {
    const confirmed = await confirmAction(`Rebase ${pc.yellow(baseBranch)} onto origin/main?`);
    if (!confirmed) {
      p.cancel("Cancelled");
      process.exit(0);
    }

    p.log.info(`Checking out ${pc.yellow(baseBranch)}...`);
    await git.checkout(baseBranch);

    // Save restack state BEFORE rebasing so --resume can find it.
    // The chain is the full ordered list — base branch at index 0,
    // so resume knows where we were and can continue with children.
    await saveRestackState({
      current_index: 0,
      stack_name: stackName,
      chain: ordered,
    });

    p.log.info("Rebasing onto origin/main...");
    const success = await git.rebase("origin/main");

    if (!success) {
      console.log();
      p.log.error("Rebase conflict — resolve and run:");
      console.log(`  ${pc.green("git rebase --continue")}`);
      console.log(`  ${pc.green("gh-stack restack --resume")}`);
      process.exit(2);
    }

    p.log.success("Base branch rebased onto main");

    // Prompt to push base
    await promptForcePush(baseBranch);
  }

  // Step 2: Restack children
  const children = ordered.slice(1);

  if (children.length === 0) {
    p.outro(pc.green("Sync complete! (no children to restack)"));
    return;
  }

  console.log();
  console.log(pc.cyan("━".repeat(40)));
  console.log(`${pc.blue("Step 2:")} Restack ${children.length} child branch(es)`);
  console.log(pc.cyan("━".repeat(40)));
  console.log();

  // Delegate to restack for the remaining branches
  // We import and run restack in --rebase mode effectively
  const { default: restack } = await import("./restack.ts");

  // Switch to first child and run restack
  if (children.length > 0) {
    await git.checkout(children[0]!);
    await restack(dryRun ? ["--dry-run"] : []);
  }
}

/** Result of the merged-bottom catch-up pass. */
interface AdvanceOutcome {
  /** A merged bottom PR was found (and reported). */
  detected: boolean;
  /** The stack metadata + branches were actually advanced (not in dry-run). */
  advanced: boolean;
  /** The whole stack drained (every branch was already merged) and was archived. */
  drained: boolean;
}

/**
 * Detect bottom PR(s) that already merged on the trunk outside gh-stack and
 * advance the stack past them — re-rooting the survivor onto the trunk with
 * `--onto` so only its own commits replay (never the squashed work). Shares the
 * planner and re-root mechanics with `merge --approved` (see ./lib/advance.ts).
 *
 * Returns what happened so the caller can re-derive the root or short-circuit.
 * In dry-run it reports and makes no changes.
 */
async function advanceMergedBottoms(
  meta: StackMetadata,
  stackName: string,
  trunk: string,
  dryRun: boolean,
): Promise<AdvanceOutcome> {
  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);

  // Walk bottom-up gathering PR state; stop at the first branch that isn't a
  // merged PR (only contiguous merged bottoms can be advanced past).
  const reviews: BranchReview[] = [];
  for (const branch of ordered) {
    const pr = stack.branches[branch]?.pr ?? null;
    let prState: string | null = null;
    if (pr != null) {
      const info = await getPrInfo(pr);
      prState = info?.state ?? null;
    }
    reviews.push({ branch, pr, prState, reviewDecision: null });
    if (prState !== "MERGED") break;
  }

  const plan = planMerges(reviews, { approveAndMerge: false });
  if (plan.steps.length === 0) {
    return { detected: false, advanced: false, drained: false };
  }

  p.log.warn(`${plan.steps.length} bottom PR(s) already merged on ${trunk} outside gh-stack:`);
  for (const step of plan.steps) {
    console.log(`  ${pc.dim("✓")} ${pc.yellow(step.branch)}${step.pr ? ` (#${step.pr})` : ""}`);
  }
  console.log(
    `  ${pc.dim(`Advancing past them (re-rooting onto ${trunk}) instead of replaying squashed commits.`)}`,
  );
  console.log();

  if (dryRun) {
    p.log.warn("[DRY RUN] Would advance the stack past the merged bottom PR(s)");
    return { detected: true, advanced: false, drained: false };
  }

  const targetRef = `origin/${trunk}`;
  await $`git fetch origin ${trunk}`.quiet();
  await takeSnapshot(meta, stackName, "sync-advance");
  const originalStack = structuredClone(stack);

  for (let i = 0; i < plan.steps.length; i++) {
    const mergedBranch = plan.steps[i]!.branch;
    const child = ordered[i + 1] ?? null;
    const childPr = child ? (stack.branches[child]?.pr ?? null) : null;

    if (child) {
      const res = await advanceNewBottom({
        meta,
        stackName,
        mergedBranch,
        child,
        childPr,
        targetRef,
        recordedBase: trunk,
      });
      if (!res.ok) {
        console.log();
        if (res.reason === "conflict") {
          p.log.error(`Rebase conflict re-rooting ${pc.yellow(child)} onto ${trunk}.`);
          console.log(`  Resolve it, then finish the restack:`);
          console.log(`    ${pc.green("git rebase --continue")}`);
          console.log(`    ${pc.green("gh-stack restack")}`);
        } else {
          p.log.error(
            `Could not determine a safe rebase base for ${pc.yellow(child)} (${res.reason}).`,
          );
          console.log(
            `  Re-root manually:\n    ${pc.green(`git rebase --onto ${targetRef} <merged-tip> ${child}`)}`,
          );
        }
        process.exit(2);
      }
    } else {
      await removeBranchFromStack(meta, stackName, mergedBranch);
    }
  }

  // Whole stack drained? Archive the original topology and land on the trunk.
  const surviving = meta.stacks[stackName];
  if (!surviving || getOrderedBranches(surviving).length === 0) {
    try {
      await git.checkout(trunk);
      await $`git pull origin ${trunk}`.quiet();
    } catch {
      // best-effort local sync
    }
    if (!meta.archive) meta.archive = {};
    meta.archive[stackName] = originalStack;
    delete meta.stacks[stackName];
    if (meta.current_stack === stackName) meta.current_stack = null;
    await writeMetadata(meta);
    return { detected: true, advanced: true, drained: true };
  }

  return { detected: true, advanced: true, drained: false };
}

async function promptForcePush(branch: string): Promise<void> {
  if (branch === "main" || branch === "master") return;
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
  p.log.info(`${pc.yellow("⚠")} ${branch} is out of sync with remote`);

  const confirmed = await confirmAction("Push with --force-with-lease?");
  if (confirmed) {
    const ok = await git.forcePushWithLease(branch);
    if (ok) {
      p.log.success("Pushed successfully");
    } else {
      p.log.error("Push failed");
    }
  } else {
    p.log.warn("Skipping push");
  }
}
