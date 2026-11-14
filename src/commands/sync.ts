// gh-stack sync — Fetch main, rebase base branch onto main, then restack all
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { $ } from "bun";
import * as git from "../lib/git.ts";
import {
  findStackForBranch,
  getOrderedBranches,
  stackBase,
  writeMetadata,
} from "../lib/metadata.ts";
import {
  ensureCleanWorkingTree,
  ensureMetadata,
  ensureValidStack,
  ensureWorktreesReady,
} from "../lib/safety.ts";
import { resolveFlag } from "../lib/config.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { guardRemoteContent } from "../lib/remote-guard.ts";
import { fetchPrMergeState } from "../lib/github.ts";
import { loadRunState } from "../lib/run-log.ts";
import {
  planMerges,
  advancePastMerged,
  strandedMerges,
  survivorsOf,
  type BranchReview,
  type MergePlan,
  type MergedRunEntry,
  type StrandedMerge,
} from "../lib/advance.ts";
import type { RestackState, Stack, StackMetadata } from "../types.ts";
import restack, {
  notePendingRun,
  pushAfterResume,
  type PushDecision,
  refuseRebaseInProgress,
  resolvePush,
  returnToStartBranch,
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

Bottom PRs that already merged are dropped, and the branches on them re-rooted
onto main. So are branches \`merge\` already squashed into the base (their PRs
merged into their stack parents) when it stopped on a conflict with main: sync
catches the base up to origin's copy and rebases only the base.

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

  // An interrupted restack/sync is pending: finish it rather than starting a
  // new sync on top of it (#29), then sync from the branch this was run on
  // (#82). Even after a resumed sync of this stack: main may have moved since
  // that run fetched it.
  const startBranch = await git.currentBranch().catch(() => null);
  let finished: RestackState | null = null;
  if (dryRun) {
    await notePendingRun();
  } else if (
    (await routePendingRun("sync", {
      fresh,
      preflight: async () => void (await syncPreconditions(args)),
    })) === "resume"
  ) {
    await restack(["--resume", ...pushFlags], { chained: true });
    finished = await loadRunState();
    if (!(await returnToStartBranch(startBranch, "sync"))) return;
    p.log.info(`Now the sync you ran, from ${pc.yellow(startBranch!)}:`);
  }

  // After finishing a pending run, sync pushes (or doesn't) as that run did,
  // unless told otherwise.
  const push: PushDecision = finished ? pushAfterResume(finished, args) : await resolvePush(args);
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

  // `merge` squashes the upper PRs into the base on GitHub before it hands
  // the base to main, and stops there if the base conflicts with main. The
  // branches it collapsed are done: their changes are on origin's base as
  // squash commits. Drop them instead of restacking their own commits onto
  // that base, where they'd conflict with their squashed copies (#81). Only
  // when no bottom PR merged: a run that advances past merged bottoms doesn't
  // also look for a collapse above them.
  const collapsed = merged.plan.steps.length === 0 ? await findCollapsed(stack, ordered) : [];

  // Nothing is rewritten yet: stop here if origin holds commits the local
  // branches lack, e.g. a collapse's squash commit on the base branch (#28).
  // Bottoms whose PRs already merged are skipped: the advance drops them
  // rather than rewriting them, and after `merge --approved` they're exactly
  // where the collapse's squash commits live. Collapsed branches are dropped
  // the same way.
  const dropped = new Set([...merged.plan.steps.map((step) => step.branch), ...collapsed]);
  // Everything else gets rebased, possibly in other worktrees (#78).
  if (!dryRun) {
    await ensureWorktreesReady(
      ordered.filter((b) => !dropped.has(b)),
      "gh-stack sync",
    );
  }
  const toGuard = ordered.filter((b) => !dropped.has(b));
  if (collapsed.length > 0) {
    reportCollapsed(stack, ordered[0]!, collapsed);
    // The base on origin has the squash commits; catch the local one up, so
    // it's what gets rebased onto main. A dry run leaves it out of the guard
    // rather than report what a real run fixes.
    if (await catchUpWithOrigin(ordered[0]!, dryRun)) toGuard.shift();
  }
  const verified = await guardRemoteContent(meta, toGuard, {
    command: "sync",
    overwrite: args.includes("--overwrite-remote"),
    dryRun,
  });

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
  if (collapsed.length > 0) {
    if (dryRun) {
      p.outro(pc.green("Sync dry run complete"));
      return;
    }
    await dropCollapsed(meta, stackName, ordered[0]!, collapsed, noPush, verified);
  }
  if (advance.advanced || collapsed.length > 0) {
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

  if (advance.split.length > 0) {
    p.log.info(
      `Split off ${advance.split.map((s) => pc.yellow(s)).join(", ")} — each is synced after ${pc.yellow(stackName)}. ` +
        pc.dim(`If a run stops, finish it, then run gh-stack sync on the stacks it didn't reach.`),
    );
  }

  // Rebase the root onto main, push it, then restack every branch above it —
  // one run, saved after every step, so `restack --resume` can finish it.
  await syncChain(meta, stackName, ordered, { trunkRef: "origin/main", push, verified });

  // Stacks split off by the advance are already re-rooted onto the trunk, but
  // the branches above their roots still sit on the old roots (#60).
  for (const name of advance.split) {
    const splitStack = meta.stacks[name];
    if (!splitStack) continue;
    await takeSnapshot(meta, name, "sync");
    await syncChain(meta, name, getOrderedBranches(splitStack), {
      trunkRef: "origin/main",
      push,
      verified,
    });
  }
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
  /** Stacks split off because several branches sat on the merged run (#60). */
  split: string[];
}

/** The contiguous merged bottom branches, and how each one's PR merged. */
interface MergedBottoms {
  plan: MergePlan;
  run: MergedRunEntry[];
}

/**
 * The contiguous bottom branches whose PRs already merged (outside gh-stack,
 * or the base of a `merge --approved` and the PRs collapsed into it), walking
 * bottom-up and stopping at the first that isn't.
 */
async function findMergedBottoms(meta: StackMetadata, stackName: string): Promise<MergedBottoms> {
  const stack = meta.stacks[stackName]!;
  const reviews: BranchReview[] = [];
  const run: MergedRunEntry[] = [];
  for (const branch of getOrderedBranches(stack)) {
    const pr = stack.branches[branch]?.pr ?? null;
    // Strict: a failed read must not pass for "not merged", or sync would
    // restack a merged branch and replay its squashed commits.
    const state = pr != null ? await fetchPrMergeState(pr) : null;
    const prState = state?.state ?? null;
    reviews.push({ branch, pr, prState, reviewDecision: null });
    if (prState !== "MERGED") break;
    run.push({
      branch,
      parent: stack.branches[branch]!.parent,
      pr,
      baseRefName: state?.baseRefName ?? null,
      mergedAt: state?.mergedAt ?? null,
    });
  }
  return { plan: planMerges(reviews, { approveAndMerge: false }), run };
}

/**
 * The branches `merge` collapsed into the root: walking up from it, each one
 * whose PR merged into its stack parent, itself the root or collapsed. Strict:
 * a PR that can't be read stops the sync (PrFetchError), since passing it as
 * unmerged would restack a collapsed branch into conflicts.
 */
async function findCollapsed(stack: Stack, ordered: string[]): Promise<string[]> {
  const collapsed: string[] = [];
  const into = new Set([ordered[0]!]);
  for (const branch of ordered.slice(1)) {
    const entry = stack.branches[branch]!;
    if (entry.pr == null || !into.has(entry.parent)) continue;
    const state = await fetchPrMergeState(entry.pr);
    if (state?.state === "MERGED" && state.baseRefName === entry.parent) {
      collapsed.push(branch);
      into.add(branch);
    }
  }
  return collapsed;
}

/** "PR #2", "PR #2 and PR #3", "PR #2, PR #3 and PR #4". */
function listPrs(prs: string[]): string {
  return prs.length < 2 ? prs.join("") : `${prs.slice(0, -1).join(", ")} and ${prs.at(-1)}`;
}

function reportCollapsed(stack: Stack, root: string, collapsed: string[]): void {
  const prs = collapsed.map((b) => `PR #${stack.branches[b]!.pr}`);
  const survivors = survivorsOf(stack, collapsed);
  p.log.warn(
    `${listPrs(prs)} ${prs.length === 1 ? "is" : "are"} already squashed into ${pc.yellow(root)} (gh-stack merge collapsed ${prs.length === 1 ? "it" : "them"}).`,
  );
  console.log(
    `  ${pc.dim(
      `Dropping ${collapsed.join(", ")} from the stack${
        survivors.length > 0 ? ` and re-rooting ${survivors.join(", ")} onto ${root}` : ""
      }: restacking ${collapsed.length === 1 ? "it" : "them"} would replay ${
        collapsed.length === 1 ? "its" : "their"
      } commits onto their own squashed copies.`,
    )}`,
  );
  console.log();
}

/**
 * Fast-forward `branch` to its copy on origin when it's strictly behind:
 * after a collapse, origin's base has the squash commits `merge` made on
 * GitHub, and the local one never saw them. In a dry run it only says so, and
 * returns true.
 */
async function catchUpWithOrigin(branch: string, dryRun: boolean): Promise<boolean> {
  await git.runGit(["fetch", "-q", "origin", branch]);
  const remote = `origin/${branch}`;
  if (!(await git.refExists(remote))) return false;
  const local = await git.revParse(branch);
  const tip = await git.revParse(remote);
  if (local === tip || !(await git.isAncestor(local, tip))) return false;
  if (dryRun) {
    p.log.info(`[DRY RUN] Would fast-forward ${pc.yellow(branch)} to ${remote} first`);
    return true;
  }
  const res = await git.fastForwardBranch(branch, remote);
  if (!res.ok) {
    p.cancel(
      `Could not fast-forward ${branch} to ${remote}${res.worktree ? ` in the worktree at ${res.worktree}` : ""}.\n\n` +
        `  Bring it up to date, then re-run gh-stack sync:\n    ${pc.green(`git${res.worktree ? ` -C ${git.shellQuote(res.worktree)}` : ""} pull --ff-only origin ${branch}`)}`,
    );
    process.exit(1);
  }
  p.log.info(`Fast-forwarded ${pc.yellow(branch)} to ${remote}, which has the squash commits`);
  return false;
}

/**
 * Drop the collapsed branches, re-rooting any unmerged branch above them onto
 * the root from the collapsed branch's tip (advancePastMerged, with the root
 * as the target). The usual sync then rebases the root onto main and restacks
 * what's left above it.
 */
async function dropCollapsed(
  meta: StackMetadata,
  stackName: string,
  root: string,
  collapsed: string[],
  noPush: boolean,
  verified: Map<string, string>,
): Promise<void> {
  const stack = meta.stacks[stackName]!;
  const survivors = survivorsOf(stack, collapsed);
  await takeSnapshot(meta, stackName, "sync-collapsed");
  // Don't leave the checkout on a branch that's leaving the stack.
  if (collapsed.includes(await git.currentBranch()) && !(await git.worktreeHolding(root))) {
    await git.checkout(root);
  }
  const res = await advancePastMerged({
    meta,
    stackName,
    merged: collapsed,
    survivors: survivors.map((branch) => ({
      branch,
      pr: stack.branches[branch]?.pr ?? null,
      expect: verified.get(branch),
    })),
    targetRef: root,
    recordedBase: root,
    push: !noPush,
  });
  if (!res.ok) {
    console.log();
    if (res.reason === "conflict") {
      p.log.error(`Rebase conflict re-rooting ${pc.yellow(res.child)} onto ${root}.`);
      if (res.worktree) {
        console.log(
          `  It stopped in the worktree at ${res.worktree}, which has ${res.child} checked out.`,
        );
      }
      console.log(`  Resolve it, then finish the sync:`);
      console.log(`    ${pc.green(`${git.rebaseCommand(res.worktree ?? null)} --continue`)}`);
      console.log(
        `    ${pc.green("gh-stack sync")}   ${pc.dim(`(picks up the re-rooted ${res.child}; not restack, which would put it back on ${res.mergedBranch})`)}`,
      );
    } else {
      p.log.error(
        `Could not determine a safe rebase base for ${pc.yellow(res.child)} (${res.reason}).`,
      );
      console.log(
        `  Re-root manually:\n    ${pc.green(`git rebase --onto ${root} <${res.mergedBranch}'s tip> ${res.child}`)}`,
      );
    }
    process.exit(2);
  }
  // A survivor just pushed has a new tip on origin: its next push (after the
  // root moves onto main) leases on what it pushed, not what the guard saw.
  if (!noPush) for (const s of survivors) verified.delete(s);
}

/**
 * Advance the stack past bottom PR(s) that already merged: drop them all and
 * re-root the first unmerged branch onto the trunk with `--onto`, from its
 * merged parent's pre-merge tip, so only its own commits replay. The merged
 * branches themselves are never re-rooted: their commits are already on the
 * trunk, squashed, and replaying them conflicts (#54). Shares the re-root
 * mechanics with `merge` (see ./lib/advance.ts).
 *
 * Returns what happened so the caller can re-derive the root or short-circuit.
 * In dry-run it reports and makes no changes.
 */
async function advanceMergedBottoms(
  meta: StackMetadata,
  stackName: string,
  trunk: string,
  dryRun: boolean,
  noPush: boolean,
  merged: MergedBottoms,
  verified: Map<string, string>,
): Promise<AdvanceOutcome> {
  const stack = meta.stacks[stackName]!;
  const { plan, run } = merged;

  if (plan.steps.length === 0) {
    return { detected: false, advanced: false, drained: false, split: [] };
  }

  const mergedBranches = plan.steps.map((step) => step.branch);
  // Every unmerged branch sitting on the run: one per child of a merged branch.
  const survivors = survivorsOf(stack, mergedBranches);

  p.log.warn(`${plan.steps.length} bottom PR(s) already merged:`);
  for (const step of plan.steps) {
    console.log(`  ${pc.dim("✓")} ${pc.yellow(step.branch)}${step.pr ? ` (#${step.pr})` : ""}`);
  }
  console.log(
    `  ${pc.dim(
      survivors.length === 0
        ? `Dropping them: nothing is left above them.`
        : `Dropping them and re-rooting ${survivors.join(", ")} onto ${trunk}, so only their own commits replay.`,
    )}`,
  );
  if (survivors.length > 1) {
    console.log(
      `  ${pc.dim(`Each of ${survivors.join(", ")} becomes its own stack: siblings on ${trunk} don't depend on each other.`)}`,
    );
  }
  console.log();
  warnStranded(strandedMerges(run, trunk), trunk);

  if (dryRun) {
    p.log.warn("[DRY RUN] Would advance the stack past the merged bottom PR(s)");
    return { detected: true, advanced: false, drained: false, split: [] };
  }

  const targetRef = `origin/${trunk}`;
  await $`git fetch origin ${trunk}`.quiet();
  await takeSnapshot(meta, stackName, "sync-advance");
  const originalStack = structuredClone(stack);

  const res = await advancePastMerged({
    meta,
    stackName,
    merged: mergedBranches,
    survivors: survivors.map((branch) => ({
      branch,
      pr: stack.branches[branch]?.pr ?? null,
      expect: verified.get(branch),
    })),
    targetRef,
    recordedBase: trunk,
    push: !noPush,
  });
  if (!res.ok) {
    console.log();
    if (res.reason === "conflict") {
      p.log.error(`Rebase conflict re-rooting ${pc.yellow(res.child)} onto ${trunk}.`);
      if (res.worktree) {
        console.log(
          `  It stopped in the worktree at ${res.worktree}, which has ${res.child} checked out.`,
        );
      }
      console.log(`  Resolve it, then finish the sync:`);
      console.log(`    ${pc.green(`${git.rebaseCommand(res.worktree ?? null)} --continue`)}`);
      console.log(
        `    ${pc.green("gh-stack sync")}   ${pc.dim(`(picks up the re-rooted ${res.child}; not restack, which would put it back on ${res.mergedBranch})`)}`,
      );
    } else {
      p.log.error(
        `Could not determine a safe rebase base for ${pc.yellow(res.child)} (${res.reason}).`,
      );
      console.log(
        `  Re-root manually:\n    ${pc.green(`git rebase --onto ${targetRef} <${res.mergedBranch}'s pre-merge tip> ${res.child}`)}`,
      );
    }
    process.exit(2);
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
    return { detected: true, advanced: true, drained: true, split: [] };
  }

  return { detected: true, advanced: true, drained: false, split: res.split };
}

/**
 * Say which merged PRs' changes never reached the trunk. The advance drops
 * their branches either way (re-rooting one would replay its commits onto a
 * trunk they were never squashed into, under the wrong PR), so the user has
 * to land those changes again themselves.
 */
function warnStranded(stranded: StrandedMerge[], trunk: string): void {
  if (stranded.length === 0) return;
  for (const s of stranded) {
    const pr = s.pr != null ? `PR #${s.pr}` : pc.yellow(s.branch);
    p.log.warn(
      s.landedPr != null
        ? `${pr} merged into ${s.into} after PR #${s.landedPr} had landed, so its changes never reached ${trunk}.`
        : `${pr} merged into ${s.into}, which isn't ${trunk} or a branch below it, so its changes may not be on ${trunk}.`,
    );
  }
  console.log(
    `  ${pc.dim(`Sync drops them from the stack anyway. To ship those changes, open a new PR for them against ${trunk}.`)}`,
  );
  console.log();
}
