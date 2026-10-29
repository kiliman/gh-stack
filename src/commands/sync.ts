// gh-stack sync — Fetch main, rebase base branch onto main, then restack all
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { $ } from "bun";
import * as git from "../lib/git.ts";
import {
  findStackForBranch,
  getOrderedBranches,
  removeBranchFromStack,
  stackBase,
  writeMetadata,
} from "../lib/metadata.ts";
import { ensureMetadata, ensureCleanWorkingTree, ensureValidStack } from "../lib/safety.ts";
import { resolveFlag } from "../lib/config.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { guardRemoteContent } from "../lib/remote-guard.ts";
import { getPrInfo } from "../lib/github.ts";
import { planMerges, advanceNewBottom, type BranchReview, type MergePlan } from "../lib/advance.ts";
import type { StackMetadata } from "../types.ts";
import restack, {
  notePendingRun,
  refuseRebaseInProgress,
  resolvePush,
  routePendingRun,
  syncChain,
} from "./restack.ts";

export default async function sync(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const fresh = args.includes("--fresh");

  if (args.includes("--help")) {
    console.log(`
gh-stack sync — Sync base with main + restack all

USAGE
  gh-stack sync [--dry-run] [--no-push | --push] [--fresh]

Fetches latest main, rebases the base branch onto main,
then restacks all children. Equivalent to running restack
with the base branch included.

OPTIONS
  --dry-run   Show what would happen without executing
  --no-push   Rebase locally only — never push or retarget PRs
              (also GH_STACK_NO_PUSH=1, or \`[restack] push = false\` in
              config; see gh-stack config). Wins over --yes for pushes
  --push      Push even when a config default or env var says not to
  --resume    Same as \`gh-stack restack --resume\`
  --fresh     Discard an interrupted restack/sync instead of resuming it
  --overwrite-remote
              Rewrite branches even though origin has commits they lack.
              Those commits are dropped from origin

If an interrupted restack or sync is pending, sync asks whether to resume it
(with --yes it resumes) rather than starting over on top of it.

Before rewriting anything, sync stops if a branch's copy on origin has
commits the local branch never had (e.g. the squash commit \`merge --collapse\`
adds on GitHub). Pull or cherry-pick them first; see \`gh-stack restack --help\`.
`);
    return;
  }

  // Only explicit push flags (and --overwrite-remote) carry over to a resume:
  // it otherwise keeps the push decision of the run it resumes.
  const pushFlags = args.filter(
    (a) => a === "--push" || a === "--no-push" || a === "--overwrite-remote",
  );
  const resumeRun = () => restack(["--resume", ...pushFlags]);
  if (args.includes("--resume")) {
    await resumeRun();
    return;
  }

  // Reject if a git rebase is already in progress. Letting sync run on top
  // of a half-finished rebase produces deeply confusing state — make the
  // user finish or abort it first.
  if (await git.isRebaseInProgress()) {
    await refuseRebaseInProgress("sync");
  }

  // An interrupted restack/sync is pending: resume it rather than starting a
  // new sync on top of it (#29).
  if (dryRun) {
    await notePendingRun();
  } else if (
    (await routePendingRun("sync", {
      fresh,
      preflight: async () => void (await syncPreconditions(args)),
    })) === "resume"
  ) {
    await resumeRun();
    return;
  }

  const push = await resolvePush(args);
  const noPush = !push.value;
  const { meta, stackName } = await syncPreconditions(args);
  let stack = meta.stacks[stackName]!;
  let ordered = getOrderedBranches(stack);

  p.intro(pc.cyan("Git Stack Sync"));

  // Find the root branch (whose parent is the stack's base)
  const base = stackBase(stack);

  // Catch up to reality first: if the bottom PR(s) already landed on the trunk
  // outside gh-stack (e.g. the GitHub web UI), the stack metadata still lists
  // them. A plain rebase onto main would then replay their now-squashed commits
  // and conflict — so advance past them (re-rooting the survivor onto main with
  // `--onto`) before the normal sync runs. (#20)
  const merged = await findMergedBottoms(meta, stackName);

  // Nothing is rewritten yet: stop here if origin holds commits the local
  // branches lack, e.g. a collapse's squash commit on the base branch (#28).
  // Bottoms whose PRs already merged are skipped: the advance drops them
  // rather than rewriting them, and after `merge --approved` they're exactly
  // where the collapse's squash commits live.
  const mergedBranches = new Set(merged.steps.map((step) => step.branch));
  const verified = await guardRemoteContent(
    meta,
    ordered.filter((b) => !mergedBranches.has(b)),
    { command: "sync", overwrite: args.includes("--overwrite-remote"), dryRun },
  );

  const advance = await advanceMergedBottoms(
    meta,
    stackName,
    base,
    dryRun,
    noPush,
    merged,
    verified,
  );
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
  // need to find when restacking children. (See resolveRestackBoundary.)
  await takeSnapshot(meta, stackName, "sync");

  // Rebase the root onto main, push it, then restack every branch above it —
  // one run, saved after every step, so `restack --resume` can finish it.
  await syncChain(meta, stackName, ordered, { trunkRef: "origin/main", push, verified });
}

/**
 * What a new sync needs before it changes anything: a clean tree, a valid push
 * setting, and the current branch in a trunk-rooted stack. Also the preflight
 * for discarding an interrupted run, so a sync that would refuse leaves that
 * run intact.
 */
async function syncPreconditions(
  args: string[],
): Promise<{ meta: StackMetadata; stackName: string }> {
  await resolveFlag("restack.push", args); // a bad setting stops here
  await ensureCleanWorkingTree();

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(
      `Branch ${pc.blue(currentBranch)} is not in any stack.\n\n  Track it first (no push/PR):\n    ${pc.green("gh-stack add")}\n\n  Or open its PR with:\n    ${pc.green("gh-stack submit")}`,
    );
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  await ensureValidStack(meta, stackName);
  if (getOrderedBranches(stack).length === 0) {
    p.cancel("No branches in this stack");
    process.exit(1);
  }

  // sync only makes sense for trunk-rooted stacks — it fetches main and
  // rebases onto it. A split stack is rooted on a branch in another stack, so
  // syncing it means restacking onto that base (handled by `restack`), or
  // re-rooting onto main once the parent stack has merged.
  const base = stackBase(stack);
  if (base !== "main" && base !== "master") {
    p.cancel(
      `${pc.yellow(stackName)} is based on ${pc.yellow(base)}, not main — sync doesn't apply.\n\n` +
        `  • Parent moved? Restack onto it:   ${pc.green("gh-stack restack")}\n` +
        `  • Parent stack merged to main?     ${pc.green("gh-stack restack --onto main")}`,
    );
    process.exit(1);
  }
  return { meta, stackName };
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
/**
 * The contiguous bottom branches whose PRs already merged (outside gh-stack,
 * or the base of a `merge --approved`), walking bottom-up and stopping at the
 * first that isn't.
 */
async function findMergedBottoms(meta: StackMetadata, stackName: string): Promise<MergePlan> {
  const stack = meta.stacks[stackName]!;
  const reviews: BranchReview[] = [];
  for (const branch of getOrderedBranches(stack)) {
    const pr = stack.branches[branch]?.pr ?? null;
    let prState: string | null = null;
    if (pr != null) {
      const info = await getPrInfo(pr);
      prState = info?.state ?? null;
    }
    reviews.push({ branch, pr, prState, reviewDecision: null });
    if (prState !== "MERGED") break;
  }
  return planMerges(reviews, { approveAndMerge: false });
}

async function advanceMergedBottoms(
  meta: StackMetadata,
  stackName: string,
  trunk: string,
  dryRun: boolean,
  noPush: boolean,
  plan: MergePlan,
  verified: Map<string, string>,
): Promise<AdvanceOutcome> {
  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);

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
        push: !noPush,
        expect: verified.get(child),
      });
      if (!res.ok) {
        console.log();
        if (res.reason === "conflict") {
          p.log.error(`Rebase conflict re-rooting ${pc.yellow(child)} onto ${trunk}.`);
          console.log(`  Resolve it, then finish the sync:`);
          console.log(`    ${pc.green("git rebase --continue")}`);
          console.log(
            `    ${pc.green("gh-stack sync")}   ${pc.dim(`(picks up the re-rooted ${child}; not restack, which would put it back on ${mergedBranch})`)}`,
          );
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
