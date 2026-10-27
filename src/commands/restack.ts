// gh-stack restack — Rebase children onto updated parents
// Port of reference/gh-stack-sync.sh — the most critical command
//
// Every run (restack, sync, join's restack, restack --onto) keeps its state in
// `.git/.gh-stack/restack-state.json` from its first step until its last push,
// with an action log of what it did (#15). `restack --resume` continues from
// that state, and a bare `restack`/`sync` offers to resume a pending run
// instead of starting a different one on top of it (#29).
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
import { restackStateFile } from "../lib/paths.ts";
import { ensureMetadata, ensureCleanWorkingTree, ensureValidStack } from "../lib/safety.ts";
import { takeSnapshot, resolveRestackBoundary, findRecordedBaseTip } from "../lib/snapshot.ts";
import { confirmAction, isAutoYes } from "../lib/ui.ts";
import { describeSource, flagSetting, resolveFlag, type Resolved } from "../lib/config.ts";
import {
  describeRun,
  findPendingRun,
  formatRunLog,
  outstandingPushes,
  remainingSteps,
  stoppedAt,
} from "../lib/run-log.ts";
import type { RestackState, RunLogEntry, StackMetadata } from "../types.ts";

/**
 * `--no-push` / `GH_STACK_NO_PUSH=1` / `[restack] push = false`: rebase
 * locally, never publish (#36, #39). Module-level because every rebase path
 * funnels through `pushBranchRef`. Wins over `--yes`, which still auto-accepts
 * the rebases themselves.
 */
let noPush = false;
/** Why pushing is off, for the local-only summary (e.g. "--no-push"). */
let noPushReason = "--no-push";

/**
 * The run in progress. Its state is saved after every step, so an interrupted
 * run can be resumed and can report what it did. Null in a dry run.
 */
let run: RestackState | null = null;

/** What one invocation accumulates while it walks a chain. */
interface ChainContext {
  /** Branches rebased by this invocation. */
  rebased: string[];
  /** Every branch this invocation is responsible for publishing; verified at the end. */
  touched: string[];
  /** Branches whose push failed, was declined or held: their children are held too. */
  unpublished: Set<string>;
  /** Branch tips on origin (one `ls-remote` per run, kept current as we push). */
  remote: Map<string, string> | null;
  dryRun: boolean;
  verbose: boolean;
}

function newContext(dryRun: boolean, verbose: boolean): ChainContext {
  return { rebased: [], touched: [], unpublished: new Set(), remote: null, dryRun, verbose };
}

/**
 * Origin's branch tips, read from the remote itself (not remote-tracking refs,
 * which can be stale — #23) on first use.
 */
async function remoteTips(ctx: ChainContext): Promise<Map<string, string>> {
  ctx.remote ??= await git.remoteHeads();
  return ctx.remote;
}

/**
 * Whether restack/sync push, from `--push`/`--no-push`, `GH_STACK_NO_PUSH`, or
 * the `[restack] push` config default. Says so when a default turned pushing
 * off, since nothing on the command line explains it.
 */
export async function resolvePush(args: string[]): Promise<Resolved> {
  const push = await resolveFlag("restack.push", args);
  if (!push.value && push.source !== "flag") {
    p.log.info(pc.dim(`Not pushing: ${describeSource(push)}. Pass --push to override.`));
  }
  return push;
}

/** What to call the source of a "don't push" decision in the summary. */
function pushReason(push: Resolved): string {
  return push.source === "flag" ? "--no-push" : describeSource(push);
}

export default async function restack(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const resume = args.includes("--resume");
  const fresh = args.includes("--fresh");
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
  --no-push   Rebase locally only — never push (also GH_STACK_NO_PUSH=1,
              or \`[restack] push = false\` in config; see gh-stack config).
              Wins over --yes for pushes; rebases are still auto-accepted
  --push      Push even when a config default or env var says not to
  --resume    Continue an interrupted restack/sync (after a conflict, a
              failed push, or a kill). Keeps the interrupted run's push
              decision unless --push/--no-push is passed. If the run had
              finished, prints what it did
  --fresh     Discard an interrupted run instead of resuming it, then
              restack from the current branch
  --dry-run   Show what would happen without executing
  --verbose   Show diagnostic info (snapshot vs merge-base)

INTERRUPTED RUNS
  A restack or sync saves its progress after every rebase and push. If one
  was interrupted, a bare \`gh-stack restack\` (or \`sync\`) asks whether to
  resume it; with --yes it resumes. It never starts a different run on top
  of an unfinished one unless you pass --fresh.

  A branch whose parent's push failed (or was declined) is not pushed:
  its PR would be diffed against the parent's old history. Run
  \`gh-stack restack --resume\` to retry the pushes, parents first.

EXAMPLES
  gh-stack restack              Interactive (prompts before each rebase)
  gh-stack restack --yes        Non-interactive (for agents/CI)
  gh-stack restack --yes --no-push
                                Non-interactive, local-only (review first)
  gh-stack restack --resume     Continue after resolving conflicts
  gh-stack restack --onto main  Re-root a split stack onto main after its
                                parent stack has merged

ALIASES
  gh-stack rebase
`);
    return;
  }

  run = null;

  if (resume && (fresh || ontoFlag)) {
    p.cancel(`--resume can't be combined with ${fresh ? "--fresh" : "--onto"}.`);
    process.exit(1);
  }

  // Reject if a git rebase is already in progress (unless we're resuming,
  // which reports it itself). Letting commands run on top of a half-finished
  // rebase produces deeply confusing state.
  if (!resume && (await git.isRebaseInProgress())) {
    await refuseRebaseInProgress("restack");
  }

  // An interrupted run is pending: resume it (or, on request, discard it)
  // rather than silently starting a different run on top of it (#29).
  let resuming = resume;
  if (!resume) {
    if (dryRun) await notePendingRun();
    else resuming = (await routePendingRun("restack", { fresh, onto: ontoFlag })) === "resume";
  }

  // A resume keeps the push decision of the run it resumes (unless this
  // command passes --push/--no-push), so it's settled in handleResume.
  if (!resuming) {
    const push = await resolvePush(args);
    noPush = !push.value;
    noPushReason = pushReason(push);
    await ensureCleanWorkingTree();
  }

  const meta = await ensureMetadata();
  const ctx = newContext(dryRun, verbose);

  p.intro(pc.cyan("Git Stack Restack"));

  // Silently drop any leftover temp tags from older versions of gh-stack
  // (pre-snapshot). Keeps users upgrading from <0.4 from seeing stale tags.
  await git.deleteTagsMatching(git.STACK_SYNC_TAG_GLOB);

  if (ontoFlag) {
    await handleReroot(meta, ontoFlag, ctx);
  } else if (resuming) {
    const outcome = await handleResume(meta, ctx, flagSetting("restack.push", args));
    if (outcome === "already-finished") return;
  } else {
    await handleFreshRestack(meta, ctx);
  }

  await finishRun(meta, ctx, "Stack Restack Complete!");
}

/**
 * End of a run: print its action log, verify every ref it touched landed on
 * origin, and mark the saved state finished — or leave it pending (exit 1)
 * when pushes are outstanding, so `restack --resume` retries them.
 */
async function finishRun(
  meta: StackMetadata,
  ctx: ChainContext,
  doneMessage: string,
): Promise<void> {
  console.log();
  if (run && run.log.length > 0) {
    p.log.info(`Run log (${describeRun(run)}):`);
    for (const line of formatRunLog(run)) console.log(line);
  } else if (ctx.rebased.length === 0) {
    p.log.warn("No branches were rebased");
  }

  if (ctx.dryRun) {
    p.outro(pc.green(doneMessage));
    return;
  }

  // Verification pass: assert every touched branch's ref actually landed on
  // origin. Fail loudly (listing the stale ones) rather than reporting success
  // when a push didn't take. (#12)
  const stale = await findStaleRefs(ctx.touched, meta);
  if (stale.length > 0 && noPush) {
    // Expected under --no-push: report what's ahead of origin so a later
    // submit/restack knows what to publish, but don't fail the run.
    console.log();
    p.log.info(`Not pushed (${noPushReason}) — these refs are ahead of origin:`);
    for (const { branch, local, remote } of stale) {
      console.log(`  ${pc.yellow("↑")} ${branch}  local ${local.slice(0, 8)}  origin ${remote}`);
    }
    console.log();
    console.log(
      `  Publish when ready: ${pc.green("gh-stack restack --push")} or ${pc.green("gh-stack submit")}`,
    );
    await markRunFinished();
    p.outro(pc.green(`${doneMessage.replace(/!$/, "")} (local only)`));
    return;
  }
  if (stale.length > 0) {
    console.log();
    p.log.error("Some branch refs are NOT in sync with origin:");
    for (const { branch, local, remote } of stale) {
      console.log(`  ${pc.red("✗")} ${branch}  local ${local.slice(0, 8)}  origin ${remote}`);
    }
    console.log();
    console.log(`  Retry the pushes (parents first): ${pc.green("gh-stack restack --resume")}`);
    if (run) await saveRun(); // stays pending: the pushes are what's left
    p.outro(pc.red("Restack finished with un-pushed refs"));
    process.exit(1);
  }

  await markRunFinished();
  p.outro(pc.green(doneMessage));
}

/**
 * For each branch, compare its local tip against origin. Returns the ones that
 * differ (or whose remote ref is missing), so restack can report exactly which
 * refs didn't land instead of falsely claiming success. (#12)
 *
 * The remote sha comes from a single authoritative `git ls-remote` (see
 * git.remoteHeads), NOT from `rev-parse origin/<branch>`. A force-push can leave
 * the local remote-tracking ref stale even though the push landed, which made
 * this pass report a false "un-pushed ref" and exit non-zero after a fully
 * successful run (#23). Reading the real remote state makes the signal
 * trustworthy in both directions: a genuinely un-pushed ref is still caught.
 *
 * A branch absent from origin is only flagged when it has a PR (it was
 * published and should be there). A local-only branch with no PR is
 * intentionally absent — restack/sync don't publish it — so it's not a stale
 * ref and must not fail the run. (#24)
 */
export async function findStaleRefs(
  branches: string[],
  meta: StackMetadata,
): Promise<{ branch: string; local: string; remote: string }[]> {
  const stale: { branch: string; local: string; remote: string }[] = [];
  const seen = new Set<string>();
  const remoteHeads = await git.remoteHeads();
  for (const branch of branches) {
    if (seen.has(branch) || branch === "main" || branch === "master") continue;
    seen.add(branch);
    if (!(await git.localBranchExists(branch))) continue;
    const local = await git.revParse(branch);
    const remote = remoteHeads.get(branch);
    if (!remote) {
      // Missing from origin is only a problem for a published branch.
      if (branchHasPr(meta, branch)) {
        stale.push({ branch, local, remote: "(missing)" });
      }
      continue;
    }
    if (remote !== local) {
      stale.push({ branch, local, remote: remote.slice(0, 8) });
    }
  }
  return stale;
}

// ── Interrupted runs (#29) ──

/**
 * A rebase is in progress, so no new run may start. When it's the conflict a
 * gh-stack run stopped on, say so and give that run's way forward.
 */
export async function refuseRebaseInProgress(command: string): Promise<never> {
  const state = await loadRestackState();
  if (state && !state.finished_at && state.rebase) {
    p.cancel(
      `An interrupted ${state.command} stopped on a conflict rebasing ${pc.yellow(state.rebase.branch)} onto ${pc.yellow(state.rebase.onto)}, and that rebase is still in progress.\n\n` +
        `  Resolve the conflicts, then finish the ${state.command}:\n` +
        `    ${pc.green("git add <files>")}\n` +
        `    ${pc.green("git rebase --continue")}\n` +
        `    ${pc.green("gh-stack restack --resume")}\n\n` +
        `  Or give up on it: ${pc.red("git rebase --abort")}`,
    );
  } else {
    p.cancel(
      `Git rebase already in progress.\n\n  Finish or abort it first:\n    ${pc.green("git rebase --continue")}\n    ${pc.red("git rebase --abort")}\n\n  Then re-run ${pc.green(`gh-stack ${command}`)}.`,
    );
  }
  process.exit(1);
}

/** Print what an interrupted run did and what it has left. */
function describePendingRun(state: RestackState): void {
  if (state.log.length > 0) {
    console.log(`  ${pc.dim("Done so far:")}`);
    for (const line of formatRunLog(state)) console.log(`  ${line}`);
  }
  const left = remainingSteps(state);
  if (left.length > 0) {
    console.log(`  ${pc.dim("Left to do:")}`);
    for (const step of left) console.log(`    ${pc.dim("→")} ${step}`);
  }
}

/**
 * Before a fresh restack/sync: if an interrupted run is pending, decide what
 * to do about it. Interactive: ask (resume / start fresh / cancel). Under
 * --yes: resume, never start fresh. `--fresh` discards it. A run whose rebase
 * the user aborted is over, so its stale state is dropped (with a note).
 */
export async function routePendingRun(
  command: "restack" | "sync",
  opts: { fresh: boolean; onto?: string },
): Promise<"resume" | "fresh"> {
  const pending = await findPendingRun();
  if (!pending) return "fresh";
  const { state } = pending;

  if (pending.status === "aborted") {
    p.log.warn(
      `Dropping the saved state of an interrupted ${state.command}: its rebase of ${pc.yellow(state.rebase!.branch)} was aborted.`,
    );
    describePendingRun(state);
    await clearRestackState();
    return "fresh";
  }

  if (opts.fresh) {
    p.log.warn(
      `--fresh: discarding the interrupted ${describeRun(state)} (stopped at ${stoppedAt(state)}).`,
    );
    describePendingRun(state);
    await clearRestackState();
    return "fresh";
  }

  if (opts.onto) {
    p.cancel(
      `An interrupted ${state.command} is pending (stopped at ${stoppedAt(state)}).\n\n` +
        `  Finish it first:   ${pc.green("gh-stack restack --resume")}\n` +
        `  Or discard it:     ${pc.green(`gh-stack restack --onto ${opts.onto} --fresh`)}`,
    );
    process.exit(1);
  }

  const message = `An interrupted ${state.command} was detected (stopped at ${stoppedAt(state)}). Resume it?`;
  if (isAutoYes()) {
    p.log.warn(`${message} ${pc.dim("(auto-yes: resuming)")}`);
    describePendingRun(state);
    return "resume";
  }

  p.log.warn(`An interrupted ${describeRun(state)} was detected.`);
  describePendingRun(state);
  const choice = await p.select({
    message,
    options: [
      { value: "resume", label: "Resume it", hint: "recommended" },
      {
        value: "fresh",
        label: `Discard it and start a new ${command}`,
        hint: "same as --fresh",
      },
      { value: "cancel", label: "Cancel" },
    ],
  });
  if (p.isCancel(choice) || choice === "cancel") {
    p.cancel("Cancelled — the interrupted run is still saved.");
    process.exit(0);
  }
  if (choice === "fresh") {
    await clearRestackState();
    return "fresh";
  }
  return "resume";
}

/** Dry run: mention a pending run (a real run would offer to resume it), change nothing. */
export async function notePendingRun(): Promise<void> {
  const pending = await findPendingRun();
  if (pending?.status !== "pending") return;
  p.log.warn(
    `An interrupted ${pending.state.command} is pending (stopped at ${stoppedAt(pending.state)}). A real run would offer to resume it (or pass --fresh to discard it).`,
  );
}

/**
 * For commands that rewrite or merge the stack outside a restack run (merge,
 * join): refuse while a run is pending. Its un-pushed branches would otherwise
 * be merged, or rebased again, in their stale state.
 */
export async function ensureNoPendingRun(command: string): Promise<void> {
  const pending = await findPendingRun();
  if (!pending) return;
  if (pending.status === "aborted") {
    await clearRestackState();
    return;
  }
  const { state } = pending;
  p.cancel(
    `An interrupted ${state.command} is pending (stopped at ${stoppedAt(state)}). Finish it before running ${command}:\n` +
      `    ${pc.green("gh-stack restack --resume")}\n\n` +
      `  Or discard it and restack from the current branch:\n` +
      `    ${pc.green("gh-stack restack --fresh")}`,
  );
  process.exit(1);
}

// ── Run state ──

async function saveRun(): Promise<void> {
  if (run) await saveRestackState(run);
}

async function beginRun(init: {
  command: string;
  stackName: string;
  chain: string[];
  pushOnly: string[];
  startIndex?: number;
}): Promise<void> {
  run = {
    command: init.command,
    stack_name: init.stackName,
    chain: init.chain,
    push_only: init.pushOnly,
    current_index: init.startIndex ?? 0,
    rebase: null,
    push: !noPush,
    started_at: new Date().toISOString(),
    finished_at: null,
    log: [],
  };
  await saveRun();
}

async function record(entry: Omit<RunLogEntry, "at">): Promise<void> {
  if (!run) return;
  run.log.push({ at: new Date().toISOString(), ...entry });
  await saveRun();
}

async function markRunFinished(): Promise<void> {
  if (!run) return;
  run.rebase = null;
  run.finished_at = new Date().toISOString();
  await saveRun();
}

/** Record a rebase about to start, so a resume can tell finished from aborted. */
async function startRebase(branch: string, onto: string, preTip: string): Promise<void> {
  if (!run) return;
  run.rebase = { branch, onto, onto_sha: await git.revParse(onto), pre_tip: preTip };
  await saveRun();
}

/** The rebase succeeded: what's left for this branch is its push. */
async function finishRebase(branch: string, onto: string, ctx: ChainContext): Promise<void> {
  ctx.rebased.push(branch);
  if (!run) return;
  run.rebase = null;
  if (!run.push_only.includes(branch)) run.push_only.push(branch);
  await record({ branch, action: "rebased", onto });
}

async function handleResume(
  meta: StackMetadata,
  ctx: ChainContext,
  explicitPush: Resolved | null,
): Promise<"resumed" | "already-finished"> {
  const state = await loadRestackState();
  if (!state) {
    p.cancel(
      `Nothing to resume: there's no saved run state (${await restackStateFile()}).\n\n` +
        `  If a rebase is in progress, finish it first: ${pc.green("git rebase --continue")}\n` +
        `  Then reconcile the stack from the branch to restack from:\n` +
        `    ${pc.green("gh-stack restack")}\n` +
        `  It's safe to re-run: branches already on their parent aren't rebased again,\n` +
        `  and refs that differ from origin are pushed.`,
    );
    process.exit(1);
  }

  if (state.finished_at) {
    p.log.success(
      `Nothing left to resume — the last run (${describeRun(state)}) finished every step.`,
    );
    for (const line of formatRunLog(state)) console.log(line);
    p.outro(pc.green("Nothing to resume"));
    return "already-finished";
  }

  // Keep the interrupted run's push decision, so a local-only run stays local
  // even if the config changed meanwhile. An explicit flag on --resume wins.
  if (explicitPush) {
    noPush = !explicitPush.value;
    noPushReason = "--no-push";
  } else {
    noPush = !state.push;
    noPushReason = "resumed a local-only run; its push decision is kept";
  }

  if (await git.isRebaseInProgress()) {
    p.cancel(
      `Rebase still in progress.\n\n  Complete it first:\n    ${pc.green("git rebase --continue")}\n\n  Or abort:\n    ${pc.red("git rebase --abort")}`,
    );
    process.exit(1);
  }
  await ensureCleanWorkingTree();

  // The world may have changed since: refuse rather than resume a chain that
  // no longer matches the stack.
  const stack = meta.stacks[state.stack_name];
  let problem: string | null = stack ? null : `stack ${state.stack_name} no longer exists`;
  for (const branch of state.chain) {
    if (problem) break;
    if (!stack!.branches[branch]) problem = `${branch} is no longer in stack ${state.stack_name}`;
    else if (!(await git.localBranchExists(branch))) problem = `branch ${branch} no longer exists`;
  }
  if (problem) {
    p.cancel(
      `Can't resume the interrupted ${state.command}: ${problem}.\n\n` +
        `  Discard it and restack from the current branch:\n    ${pc.green("gh-stack restack --fresh")}`,
    );
    process.exit(1);
  }

  p.log.warn(`Resuming the interrupted ${describeRun(state)} (stopped at ${stoppedAt(state)})`);
  if (state.log.length > 0) {
    p.log.info("Done before the interruption:");
    for (const line of formatRunLog(state)) console.log(line);
  }

  run = state;
  // Branches the run already got past only need their pushes reconciled
  // (failed or held ones are retried, parents first); the rest restack as usual.
  const pushOnly = new Set([...state.push_only, ...state.chain.slice(0, state.current_index)]);

  if (state.rebase) {
    const r = state.rebase;
    const tip = await git.revParse(r.branch);
    if (await git.isAncestor(r.onto_sha, tip)) {
      p.log.success(`Rebase of ${pc.yellow(r.branch)} onto ${pc.yellow(r.onto)} completed`);
      await finishRebase(r.branch, r.onto, ctx);
      pushOnly.add(r.branch);
    } else if (tip === r.pre_tip) {
      await clearRestackState();
      run = null;
      p.cancel(
        `The rebase of ${pc.yellow(r.branch)} onto ${pc.yellow(r.onto)} was aborted, so the interrupted ${state.command} ended there. Its saved state is discarded.\n\n` +
          `  To restack from here:\n    ${pc.green(`gh-stack ${state.command === "sync" ? "sync" : "restack"}`)}`,
      );
      process.exit(1);
    } else {
      p.cancel(
        `${pc.yellow(r.branch)} moved since the ${state.command} stopped: it isn't rebased onto ${r.onto} (${r.onto_sha.slice(0, 8)}), and it isn't back at its pre-rebase tip ${r.pre_tip.slice(0, 8)} either. Not guessing what happened.\n\n` +
          `  Put ${r.branch} on ${r.onto} yourself, then: ${pc.green("gh-stack restack --resume")}\n` +
          `  Or discard the run:                    ${pc.green("gh-stack restack --fresh")}`,
      );
      process.exit(1);
    }
  }

  await processChain(meta, state.stack_name, state.chain, 0, pushOnly, ctx);
  return "resumed";
}

async function handleFreshRestack(meta: StackMetadata, ctx: ChainContext): Promise<void> {
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
  const chain = buildRebaseChain(stack, currentBranch);

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
  // so changes propagate, so we don't skip it. A skipped root is still pushed:
  // if you committed on it, its ref is stale on origin (#12).
  const base = stackBase(stack);
  const baseIsTrunk = base === "main" || base === "master";
  const baseBranches = baseIsTrunk ? chain.filter((b) => stack.branches[b]?.parent === base) : [];
  const toRebase = chain.filter((b) => !baseBranches.includes(b));
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

    if (toRebase.length === 0) {
      p.log.info("No child branches to rebase — reconciling the base branch ref.");
    } else {
      p.log.success(`Processing ${toRebase.length} branch(es):`);
      for (const branch of toRebase) {
        const parent = stack.branches[branch]?.parent || "(unknown)";
        console.log(`  ${pc.yellow("→")} ${branch} ${pc.blue(`(parent: ${parent})`)}`);
      }
      console.log();
    }
  }

  if (!ctx.dryRun) {
    // Take snapshot before destructive operation. This preserves the current
    // tip of every branch so subsequent restacks (after a parent is rewritten)
    // can find the correct rebase base.
    if (toRebase.length > 0) await takeSnapshot(meta, stackName, "restack");
    await beginRun({ command: "restack", stackName, chain, pushOnly: baseBranches });
  }

  await processChain(meta, stackName, chain, 0, new Set(baseBranches), ctx);
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
// Resolve the boundary commit for re-rooting a stack's root off its old base:
// the tip of the old base branch that the root was built on. Returns null when
// it can't be determined safely, so the caller refuses rather than replaying
// already-merged commits (issue #13).
async function resolveRerootBoundary(
  meta: StackMetadata,
  oldBase: string,
  root: string,
): Promise<{ sha: string | null; source: string }> {
  // 1. The live base branch tip — but only if the root still sits on it. If the
  //    base was rewritten after the root forked, its current tip isn't the
  //    boundary; fall through to the recorded tip.
  if (await git.localBranchExists(oldBase)) {
    const tip = await git.revParse(oldBase);
    if (tip && (await git.isAncestor(tip, root))) {
      return { sha: tip, source: "old-base branch tip" };
    }
  }

  // 2. The tip recorded in a snapshot — survives the base branch being deleted
  //    or rewritten by a squash-merge of the parent stack.
  const recorded = await findRecordedBaseTip(meta, oldBase, root);
  if (recorded) {
    return { sha: recorded, source: "snapshot (old base branch gone/rewritten)" };
  }

  // 3. Unknown — refuse rather than replay merged commits.
  return { sha: null, source: "" };
}

async function handleReroot(
  meta: StackMetadata,
  newBase: string,
  ctx: ChainContext,
): Promise<void> {
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(
      `Branch ${pc.blue(currentBranch)} is not in any stack.\n\n  Track it first (no push/PR):\n    ${pc.green("gh-stack add")}`,
    );
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
  // Getting this right matters: rebasing from the wrong boundary replays the
  // old base's commits onto the new base, and when the old base was a
  // squash-merged parent stack those commits collide with their own squashed
  // result on main — a self-inflicted conflict storm (issue #13). So we never
  // guess with merge-base; we refuse instead.
  const { sha: oldBaseTip, source: oldBaseSource } = await resolveRerootBoundary(
    meta,
    oldBase,
    root,
  );

  if (!oldBaseTip) {
    p.cancel(
      `Can't safely re-root ${pc.yellow(stackName)}: its old base ${pc.yellow(
        oldBase,
      )} is gone (or was rewritten) and no snapshot recorded where ${pc.yellow(
        root,
      )} forked off it.\n\n  Rebasing from the merge-base would replay already-merged commits and conflict.\n  Re-root manually once you know the old base tip:\n    ${pc.green(
        `git rebase --onto ${newBase} <old-base-tip> ${root}`,
      )}`,
    );
    process.exit(1);
  }

  p.log.info(`Re-rooting ${pc.yellow(stackName)}: ${pc.dim(oldBase)} → ${pc.green(newBase)}`);
  p.log.info(`Root branch: ${pc.yellow(root)}`);
  if (ctx.verbose) {
    p.log.info(`Rebase base: ${oldBaseTip.slice(0, 8)} (${oldBaseSource})`);
  }
  console.log();

  if (ctx.dryRun) {
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

  // The root first, then everything above it (parents before children).
  const chain = buildRebaseChain(stack, root);
  await beginRun({ command: "restack --onto", stackName, chain, pushOnly: [] });

  // Rebase the root onto the new base, dropping the old base's commits.
  p.log.info(`Checking out ${pc.yellow(root)}...`);
  await git.checkout(root);
  p.log.info(`Rebasing ${pc.yellow(root)} onto ${pc.yellow(newBase)}...`);
  await startRebase(root, newBase, await git.revParse(root));
  const ok = await git.rebaseOnto(newBase, oldBaseTip, root);

  if (!ok) {
    console.log();
    p.log.error("Rebase conflict — resolve and run:");
    console.log(`  ${pc.green("git rebase --continue")}`);
    console.log(`  ${pc.green("gh-stack restack --resume")}`);
    process.exit(2);
  }

  await finishRebase(root, newBase, ctx);

  // Push the moved root, then restack the children onto it.
  await processChain(meta, stackName, chain, 0, new Set([root]), ctx);
}

/**
 * Push one branch under restack's conventions: confirm, `--force-with-lease`,
 * never publish a local-only branch, and do nothing under `--no-push`. Exported
 * for `join` (#32), which syncs the incoming branch itself and publishes it
 * before retargeting PRs onto it.
 */
export async function publishBranch(
  meta: StackMetadata,
  branch: string,
  opts: { noPush: boolean },
): Promise<void> {
  await withNoPush(opts.noPush, () => pushBranchRef(meta, branch));
}

/**
 * Restack `chain` from `startIndex`: the same loop `restack` and `--resume` run,
 * including the conflict stop (exit 2, resumable with `restack --resume`).
 * The branches before `startIndex` are taken as done. Exported for `join`
 * (#32). Returns the branches it rebased and touched.
 */
export async function restackChain(
  meta: StackMetadata,
  stackName: string,
  chain: string[],
  startIndex: number,
  opts: { noPush: boolean; verbose: boolean },
): Promise<{ rebased: string[]; touched: string[] }> {
  const ctx = newContext(false, opts.verbose);
  await withNoPush(opts.noPush, async () => {
    const done = chain.slice(0, startIndex);
    await beginRun({ command: "join", stackName, chain, pushOnly: done, startIndex });
    await processChain(meta, stackName, chain, startIndex, new Set(done), ctx);
    if (outstandingPushes(run!).length === 0) await markRunFinished();
  });
  return { rebased: ctx.rebased, touched: ctx.touched };
}

/**
 * sync's rebase phase, under the same saved state and action log as restack:
 * rebase the stack's root onto `trunkRef`, push it, then restack every branch
 * above it. A conflict stops with exit 2, resumable with `restack --resume`.
 * The caller has fetched the trunk and taken the snapshot.
 */
export async function syncChain(
  meta: StackMetadata,
  stackName: string,
  ordered: string[],
  opts: { trunkRef: string; push: Resolved },
): Promise<void> {
  noPush = !opts.push.value;
  noPushReason = pushReason(opts.push);
  run = null;
  const ctx = newContext(false, false);
  const root = ordered[0]!;
  const { trunkRef } = opts;

  await beginRun({ command: "sync", stackName, chain: ordered, pushOnly: [root] });

  // Step 1: Rebase the root onto the trunk
  console.log();
  console.log(pc.cyan("━".repeat(40)));
  console.log(`${pc.blue("Step 1:")} Rebase ${pc.yellow(root)} onto ${trunkRef}`);
  console.log(pc.cyan("━".repeat(40)));
  console.log();

  if (await git.isAncestor(trunkRef, root)) {
    p.log.success(`${root} is already up to date with ${trunkRef}`);
    await record({ branch: root, action: "up-to-date", onto: trunkRef });
  } else {
    const confirmed = await confirmAction(`Rebase ${pc.yellow(root)} onto ${trunkRef}?`);
    if (!confirmed) {
      await clearRestackState(); // nothing happened: no run to resume
      run = null;
      p.cancel("Cancelled");
      process.exit(0);
    }

    p.log.info(`Checking out ${pc.yellow(root)}...`);
    await git.checkout(root);
    await startRebase(root, trunkRef, await git.revParse(root));

    p.log.info(`Rebasing onto ${trunkRef}...`);
    if (!(await git.rebase(trunkRef))) {
      console.log();
      p.log.error("Rebase conflict — resolve and run:");
      console.log(`  ${pc.green("git rebase --continue")}`);
      console.log(`  ${pc.green("gh-stack restack --resume")}`);
      process.exit(2);
    }
    p.log.success("Base branch rebased onto main");
    await finishRebase(root, trunkRef, ctx);
  }

  // Push the root, whether it was rebased or already current: a commit made on
  // it since the last push is stale on origin too. Its children are held back
  // if this push doesn't land.
  ctx.touched.push(root);
  await pushStep(meta, stackName, root, ctx);
  run!.current_index = 1;
  await saveRun();

  // Step 2: Restack the rest of the stack
  const children = ordered.slice(1);
  if (children.length > 0) {
    console.log();
    console.log(pc.cyan("━".repeat(40)));
    console.log(`${pc.blue("Step 2:")} Restack ${children.length} child branch(es)`);
    console.log(pc.cyan("━".repeat(40)));
    await processChain(meta, stackName, ordered, 1, new Set([root]), ctx);
  }

  await finishRun(meta, ctx, "Sync complete!");
}

/**
 * Run `fn` with the module-level `noPush` set, restoring it afterwards. The
 * exported entry points take `noPush` as a parameter; this scopes it instead of
 * threading it through processChain/pushBranchRef, which restack() also drives.
 */
async function withNoPush<T>(value: boolean, fn: () => Promise<T>): Promise<T> {
  const saved = noPush;
  noPush = value;
  try {
    return await fn();
  } finally {
    noPush = saved;
  }
}

/**
 * Walk `chain` from `startIndex`: rebase each branch onto its parent (unless
 * it's in `pushOnly`), then push it. The run state is saved before each rebase
 * and after each step, so an interruption anywhere leaves a resumable run.
 */
async function processChain(
  meta: StackMetadata,
  stackName: string,
  chain: string[],
  startIndex: number,
  pushOnly: Set<string>,
  ctx: ChainContext,
): Promise<void> {
  const stack = meta.stacks[stackName]!;
  const { dryRun, verbose } = ctx;

  for (let i = startIndex; i < chain.length; i++) {
    const branch = chain[i]!;
    const parent = stack.branches[branch]?.parent;
    if (run) {
      run.current_index = i;
      run.rebase = null;
      await saveRun();
    }

    // Done already (rebased earlier, or a root restack doesn't rebase): only
    // its ref needs to reach origin.
    if (pushOnly.has(branch)) {
      if (!dryRun && (await git.localBranchExists(branch))) {
        ctx.touched.push(branch);
        await pushStep(meta, stackName, branch, ctx);
      }
      continue;
    }

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

    // Check if already up to date. The branch doesn't need rebasing, but its
    // remote ref may still be stale — e.g. this is the branch you just
    // committed on, which triggered the restack. Push it so origin (and its
    // PR) reflects the new commit. (#12)
    if (await git.isAncestor(parent, branch)) {
      p.log.success("Already up to date with parent");
      if (!dryRun) {
        await record({ branch, action: "up-to-date", onto: parent });
        ctx.touched.push(branch);
        await pushStep(meta, stackName, branch, ctx);
      }
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
      await record({ branch, action: "rebase-declined", onto: parent });
      continue;
    }

    // Resolve the rebase boundary — snapshot pre-rewrite tip, a fork point
    // derived from a rejected snapshot (#30), or merge-base, in that order.
    // See resolveRestackBoundary for the full strategy.
    //
    //   Re-read metadata fresh because previous iterations of this loop may
    //   have updated snapshots.
    const freshMeta = (await readMetadata()) ?? meta;
    const boundary = await resolveRestackBoundary(freshMeta, parent, branch);

    if (verbose) {
      console.log();
      console.log(pc.yellow("  Diagnostic: base resolution"));
      console.log(
        `  ${pc.cyan("Boundary:")} ${boundary ? `${boundary.sha.slice(0, 8)} (${boundary.source})` : "(none)"}`,
      );
      if (boundary && boundary.source !== "merge-base") {
        console.log(
          `  ${pc.yellow("⚠ Parent was rewritten")} — merge-base alone would have replayed parent commits`,
        );
      }
      console.log();
    }

    if (!boundary) {
      // No snapshot evidence and no common history — any base would be a
      // guess, and a wrong guess replays the parent's history onto itself.
      // Refuse with the manual command, consistent with the --onto reroot
      // path. (#30: never silently guess when we can't derive the boundary.)
      p.log.error(
        `Cannot determine a safe rebase base for ${pc.yellow(branch)} onto ${pc.yellow(parent)}.`,
      );
      console.log();
      console.log("  Rebase it manually with an explicit boundary:");
      console.log(`    ${pc.green(`git rebase --onto ${parent} <old-parent-tip> ${branch}`)}`);
      console.log();
      console.log(`  Then re-run ${pc.green("gh-stack restack --resume")} to continue the chain.`);
      process.exit(1);
    }

    // Checkout the branch
    p.log.info(`Checking out ${pc.yellow(branch)}...`);
    await git.checkout(branch);

    let success: boolean;
    const branchTip = await git.revParse(branch);
    // Saved before the rebase starts, so a conflict (or a kill) leaves a
    // resumable run that can tell a finished rebase from an aborted one.
    await startRebase(branch, parent, branchTip);
    if (boundary.sha === branchTip) {
      // The child has no commits of its own (a placeholder branch created off
      // the parent before any work landed). Nothing to replay — move the ref
      // instead of invoking rebase. (#30)
      p.log.info(
        `${pc.yellow(branch)} has no unique commits — moving it to ${pc.yellow(parent)}'s tip`,
      );
      success = await git.resetHard(parent);
    } else {
      const sourceLabel =
        boundary.source === "snapshot-derived" ? "snapshot (derived fork-point)" : boundary.source;
      p.log.info(
        `Rebasing onto ${pc.yellow(parent)} (base: ${boundary.sha.slice(0, 8)} from ${sourceLabel})`,
      );

      if (verbose) {
        const count = await git.commitCount(boundary.sha, branch);
        console.log(`  Moving ${count} commit(s)`);
      }

      success = await git.rebaseOnto(parent, boundary.sha, branch);
    }

    if (success) {
      p.log.success("Rebase successful");
      await finishRebase(branch, parent, ctx);
      ctx.touched.push(branch);

      // Push immediately (don't batch) so an interrupt can't leave later
      // branches un-pushed.
      await pushStep(meta, stackName, branch, ctx);
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

  if (run && !dryRun) {
    run.current_index = chain.length;
    run.rebase = null;
    await saveRun();
  }
}

/**
 * Whether a branch has been published — it has a PR recorded in metadata.
 * restack/sync keep published branches' remotes in sync after a rebase, but must
 * NOT create a remote for an unpublished, local-only branch — publishing is
 * `submit`'s job, not a side effect of restacking. (#24)
 */
function branchHasPr(meta: StackMetadata, branch: string): boolean {
  const stackName = findStackForBranch(meta, branch);
  if (!stackName) return false;
  return meta.stacks[stackName]?.branches[branch]?.pr != null;
}

/**
 * The parent `branch` must not be pushed onto, if any: one whose push failed,
 * was declined or held this run, or whose origin copy doesn't contain the
 * local tip `branch` was rebased onto (#29). A child pushed onto such a parent
 * gets its PR diffed against the parent's old history — the "1000+ files
 * changed" PR. A parent merely behind origin is fine: the PR's merge-base is
 * still the commit the child sits on. The trunk and a parent with no remote
 * copy are never held against.
 */
async function unpublishedParent(
  branch: string,
  parent: string | undefined,
  ctx: ChainContext,
): Promise<string | null> {
  if (!parent || parent === "main" || parent === "master" || parent === branch) return null;
  if (ctx.unpublished.has(parent)) return parent;
  const remote = (await remoteTips(ctx)).get(parent);
  if (!remote || !(await git.localBranchExists(parent))) return null;
  const local = await git.revParse(parent);
  if (local === remote || (await git.isAncestor(local, remote))) return null;
  return parent;
}

/** Whether pushing `branch` would change origin (it differs, or a published branch is missing). */
async function needsPush(meta: StackMetadata, branch: string, ctx: ChainContext): Promise<boolean> {
  const remote = (await remoteTips(ctx)).get(branch);
  if (!remote) return branchHasPr(meta, branch);
  return remote !== (await git.revParse(branch));
}

/**
 * Push one branch as a step of the run: held back when its parent isn't
 * published (#29), otherwise pushed, with the outcome recorded in the log.
 */
async function pushStep(
  meta: StackMetadata,
  stackName: string,
  branch: string,
  ctx: ChainContext,
): Promise<void> {
  if (noPush || branch === "main" || branch === "master") return;
  const parent = meta.stacks[stackName]?.branches[branch]?.parent;

  const heldBy = await unpublishedParent(branch, parent, ctx);
  if (heldBy) {
    if (await needsPush(meta, branch, ctx)) {
      p.log.warn(
        `Not pushing ${pc.yellow(branch)}: its parent ${pc.yellow(heldBy)} isn't on origin at the commit ${branch} sits on, so its PR would be diffed against ${heldBy}'s old history. Push ${heldBy} first — ${pc.green("gh-stack restack --resume")} retries both, parent first.`,
      );
      ctx.unpublished.add(branch);
      await record({ branch, action: "push-held", detail: `${heldBy} not on origin` });
    }
    return;
  }

  const outcome = await pushBranchRef(meta, branch);
  switch (outcome) {
    case "pushed":
      (await remoteTips(ctx)).set(branch, await git.revParse(branch));
      await record({ branch, action: "pushed" });
      break;
    case "failed":
      ctx.unpublished.add(branch);
      await record({ branch, action: "push-failed" });
      break;
    case "declined":
      ctx.unpublished.add(branch);
      await record({ branch, action: "push-declined" });
      break;
    case "local-only":
      await record({ branch, action: "local-only" });
      break;
    default:
      break; // already in sync, or pushing is off
  }
}

type PushOutcome = "no-push" | "in-sync" | "local-only" | "pushed" | "failed" | "declined";

/**
 * Reconcile a single branch's ref with origin. Pushes when the local tip
 * differs from origin OR the remote branch doesn't exist yet (so a branch
 * that was never pushed still lands). No-op when already in sync. (#12)
 */
async function pushBranchRef(meta: StackMetadata, branch: string): Promise<PushOutcome> {
  if (branch === "main" || branch === "master") return "in-sync";
  // --no-push: leave origin alone; the end-of-run summary lists what's ahead.
  if (noPush) return "no-push";

  const localSha = await git.revParse(branch);
  const hasRemote = await git.remoteBranchExists(branch);

  // Don't publish an unsubmitted branch. A local-only branch (no remote AND no
  // PR) is intentionally not on origin — restack/sync rebase it locally but
  // leave pushing to `submit`. Skip with a note rather than creating its remote
  // (the #24 surprise: `--yes` silently published a WIP tip). A branch that
  // already has a remote or a PR still gets pushed below to stay in sync.
  if (!hasRemote && !branchHasPr(meta, branch)) {
    p.log.info(
      `Skipping push of ${pc.yellow(branch)} — local-only (not submitted). Run ${pc.green("gh-stack submit")} to open its PR.`,
    );
    return "local-only";
  }

  const remoteSha = hasRemote ? await git.revParse(`origin/${branch}`).catch(() => null) : null;

  if (hasRemote && remoteSha === localSha) return "in-sync";

  console.log();
  console.log(pc.cyan("━".repeat(40)));
  console.log(pc.blue(hasRemote ? "  Push Rebased Branch?" : "  Push New Branch?"));
  console.log(pc.cyan("━".repeat(40)));
  console.log();
  console.log(`${pc.blue("Branch:")} ${branch}`);
  if (hasRemote) {
    console.log(pc.yellow("⚠ Branch is out of sync with remote"));
    console.log(`  Local:  ${localSha.slice(0, 8)}`);
    console.log(`  Remote: ${remoteSha ? remoteSha.slice(0, 8) : "(unknown)"}`);
  } else {
    console.log(pc.yellow("⚠ Branch has no remote ref yet"));
    console.log(`  Local:  ${localSha.slice(0, 8)}`);
  }
  console.log();

  const confirmed = await confirmAction(
    hasRemote ? "Push with --force-with-lease?" : `Push ${branch} to origin?`,
  );
  if (!confirmed) {
    p.log.warn("Skipping push (you'll need to push manually)");
    return "declined";
  }
  p.log.info(`Pushing ${branch}...`);
  if (await git.pushStackedBranch(branch)) {
    p.log.success("Pushed successfully");
    return "pushed";
  }
  p.log.error(`Push of ${branch} failed — branches above it won't be pushed onto it`);
  return "failed";
}
