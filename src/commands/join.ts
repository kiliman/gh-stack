// gh-stack join — splice an existing branch (usually one with a PR) into a stack.
//
// The three things this has to get right (#32):
//
// 1. Sync the incoming branch onto the stack's base BEFORE anything is rebased
//    onto it. The incoming branch is often behind main; rebasing children onto
//    it as-is drags already-merged main commits into every child's diff, and
//    nothing errors. So the incoming branch replays only its OWN commits — the
//    range above its fork point with the trunk — onto the current tip of its
//    new parent (`git rebase --onto <parent-tip> <fork-point> <incoming>`).
//    Only then are children restacked onto it.
// 2. Retarget PR bases on GitHub. Metadata alone doesn't move them. A base
//    change never closes a PR, so it's safe to do automatically — but only once
//    the synced incoming branch is on origin, or the child PR's diff would show
//    the stale incoming history.
// 3. Metadata. A new bottom changes the stack's identity: a stack named after
//    its old bottom branch is re-keyed under the new bottom (the old file is
//    tombstoned by writeMetadata, never left behind as a second live copy).
//
// Children are restacked by restack's own chain loop, so a conflict stops the
// same way and resumes with `gh-stack restack --resume`.
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { $ } from "bun";
import * as git from "../lib/git.ts";
import {
  findStackForBranch,
  stackBase,
  getChildren,
  getOrderedBranches,
  buildRebaseChain,
  readMetadata,
  writeMetadata,
} from "../lib/metadata.ts";
import { ensureMetadata, ensureCleanWorkingTree, ensureValidStack } from "../lib/safety.ts";
import { takeSnapshot, resolveRestackBoundary } from "../lib/snapshot.ts";
import { findOpenPrForBranch, setPrBase } from "../lib/github.ts";
import { confirmAction, renderStackTree } from "../lib/ui.ts";
import { findStaleRefs, publishBranch, restackChain, wantsNoPush } from "./restack.ts";
import type { Branch, Stack, StackMetadata } from "../types.ts";

const HELP = `
gh-stack join — Splice an existing branch (and its PR) into a stack

USAGE
  gh-stack join <branch>                   Insert as the new bottom of the current stack
  gh-stack join <branch> --above <branch>  Insert directly above a branch in the stack

The incoming branch is first synced onto its new parent, replaying only its own
commits (those above its fork point with main), so the branches restacked onto
it don't inherit unrelated main commits. Then the branches above it are
restacked onto it, pushed, and their PR bases retargeted on GitHub.

Joining at the bottom of a stack named after its old bottom branch renames the
stack after the new bottom.

OPTIONS
  --above <branch>  Insert between <branch> and its children (default: below the
                    whole stack). --above main is the same as the default.
  --dry-run         Show the resulting stack and, for each affected PR, its
                    projected commits / files vs its new parent. Changes nothing.
  --no-push         Rebase and update metadata locally only — never push or
                    retarget PRs (also GH_STACK_NO_PUSH=1). Wins over --yes
  --yes, -y         Skip confirmations
  --verbose, -v     Show rebase-boundary diagnostics

The branch must exist locally. A branch alone in a one-branch stack (what
${"`"}submit${"`"} makes of a standalone PR) is absorbed; a branch in a larger stack is
refused.

CONFLICTS
  Syncing the incoming branch: the stack is untouched until it succeeds.
  Resolve, ${"`"}git rebase --continue${"`"}, and re-run the same join (or
  ${"`"}git rebase --abort${"`"} to drop it).
  Restacking the branches above it: same as restack. Resolve,
  ${"`"}git rebase --continue${"`"}, then ${"`"}gh-stack restack --resume${"`"}.

EXAMPLES
  gh-stack join fix-auth --dry-run        Preview splicing fix-auth in at the bottom
  gh-stack join fix-auth                  Splice it in at the bottom
  gh-stack join fix-auth --above feat-1   Splice it in between feat-1 and its child
`;

interface Projection {
  commits: number;
  files: number;
  insertions: number;
  deletions: number;
}

interface ChildPlan {
  branch: string;
  pr: number | null;
  oldParent: string;
  /** First commit below the child's own commits: `boundary..child` is what restack replays. */
  boundary: string;
  projection: Projection;
}

interface JoinPlan {
  stackName: string;
  /** Stack name after the join (differs when a new bottom renames the stack). */
  finalName: string;
  incoming: string;
  incomingPr: number | null;
  /** One-branch stack that held the incoming branch, absorbed by the join. */
  absorbedStack: string | null;
  position: "bottom" | "above";
  newParent: string;
  newParentRef: string;
  newParentTip: string;
  trunkRef: string;
  incomingTip: string;
  /** Fork point: `incomingBoundary..incoming` are the incoming branch's own commits. */
  incomingBoundary: string;
  needsRebase: boolean;
  own: Projection;
  /** Trunk commits the incoming branch lacks (what an unsynced join would leak). */
  behindTrunk: number;
  children: ChildPlan[];
  /** Branches above the children: restacked, their diffs vs their parents unchanged. */
  upstack: string[];
  /** The resulting stack, for display. */
  resulting: Stack;
}

export default async function join(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }

  const dryRun = args.includes("--dry-run");
  const noPush = wantsNoPush(args);
  const verbose = args.includes("--verbose") || args.includes("-v");
  let above: string | undefined;
  let incoming: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--above") {
      above = args[++i];
      if (!above) fail("--above needs a branch name");
    } else if (!args[i]!.startsWith("-")) incoming ??= args[i];
  }
  if (!incoming) fail(`Usage: ${pc.green("gh-stack join <branch> [--above <branch>]")}`);

  if (await git.isRebaseInProgress()) {
    fail(
      `Git rebase already in progress.\n\n  Finish or abort it first:\n    ${pc.green("git rebase --continue")}\n    ${pc.red("git rebase --abort")}`,
    );
  }
  await ensureCleanWorkingTree();

  const meta = await ensureMetadata();
  const startBranch = await git.currentBranch().catch(() => null);

  p.intro(pc.cyan(dryRun ? "Join Branch into Stack (dry run)" : "Join Branch into Stack"));

  // Real runs measure against the latest trunk; a dry run stays read-only and
  // uses the last fetch.
  const trunk = await git.trunkBranch();
  if (!dryRun) await $`git fetch origin ${trunk}`.nothrow().quiet();

  const plan = await buildPlan(meta, incoming, above, startBranch, trunk);
  printPlan(plan, startBranch);

  if (dryRun) {
    p.outro(pc.green("Dry run complete — nothing changed"));
    return;
  }

  const confirmed = await confirmAction(
    `Join ${pc.yellow(plan.incoming)} into stack ${pc.yellow(plan.stackName)}?`,
  );
  if (!confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Snapshot the joined stack before any ref moves. It records the incoming
  // branch's pre-sync tip too, so `gh-stack undo` restores it with the rest.
  const joined = await joinedMetadata(plan);
  await takeSnapshot(joined, plan.finalName, "join");
  const stackName = plan.finalName;

  // ── 1. Sync the incoming branch onto its new parent (own commits only) ──
  // Done BEFORE the metadata is written: a conflict here leaves the stack as it
  // was, so aborting needs nothing else and finishing just means re-running.
  if (plan.needsRebase) {
    p.log.info(
      `Syncing ${pc.yellow(plan.incoming)} onto ${pc.yellow(plan.newParentRef)} — replaying its ${plan.own.commits} own commit(s) ${pc.dim(`(above ${short(plan.incomingBoundary)})`)}`,
    );
    await git.checkout(plan.incoming);
    const ok = await git.rebaseOnto(plan.newParentTip, plan.incomingBoundary, plan.incoming);
    if (!ok) {
      const rerun = `gh-stack join ${plan.incoming}${plan.position === "above" ? ` --above ${plan.newParent}` : ""}`;
      console.log();
      p.log.error(`Rebase conflict syncing ${pc.yellow(plan.incoming)} onto ${plan.newParentRef}.`);
      console.log("  The stack is unchanged. Resolve the conflicts, then re-run the join:");
      console.log(`    ${pc.green("git rebase --continue")}`);
      if (startBranch) console.log(`    ${pc.green(`git checkout ${startBranch}`)}`);
      console.log(`    ${pc.green(rerun)}`);
      console.log();
      console.log(
        `  Or drop it: ${pc.red("git rebase --abort")} ${pc.dim("(nothing else to undo)")}`,
      );
      process.exit(2);
    }
    p.log.success(`${plan.incoming} synced`);
  } else {
    p.log.success(`${plan.incoming} already sits on ${plan.newParentRef} — no sync needed`);
  }

  await writeMetadata(joined);
  const chain = buildRebaseChain(joined.stacks[stackName]!, plan.incoming);

  // ── 2. Check each child will replay exactly its own commits ──
  // Restack resolves each child's boundary itself; make sure it lands where
  // the plan (and the dry run) said. Stop BEFORE rewriting a child otherwise.
  const metaAfterSync = await freshMeta();
  for (const child of plan.children) {
    const resolved = await resolveRestackBoundary(metaAfterSync, plan.incoming, child.branch);
    if (resolved?.sha !== child.boundary) {
      p.log.error(
        `Restack would rebase ${pc.yellow(child.branch)} from ${resolved ? short(resolved.sha) : "(none)"}, not its fork point ${short(child.boundary)} — its diff would be wrong.`,
      );
      console.log(`  ${plan.incoming} is synced and the metadata is updated. Restack it by hand:`);
      console.log(
        `    ${pc.green(`git rebase --onto ${plan.incoming} ${short(child.boundary)} ${child.branch}`)}`,
      );
      console.log(`    ${pc.green("gh-stack restack")}  ${pc.dim(`(from ${child.branch})`)}`);
      console.log(`  Or put everything back: ${pc.green("gh-stack undo")}`);
      process.exit(1);
    }
    if (verbose) {
      p.log.info(`${child.branch}: boundary ${short(child.boundary)} (${resolved.source})`);
    }
  }

  // ── 3. Publish the incoming branch, then retarget PR bases onto it ──
  await publishBranch(metaAfterSync, plan.incoming, { noPush });
  const retargeted = noPush ? [] : await retargetPrs(plan);

  // ── 4. Restack everything above it (restack's own loop: conflicts → --resume) ──
  let touched: string[] = [plan.incoming];
  if (chain.length > 1) {
    console.log();
    p.log.info(
      `Restacking ${chain.length - 1} branch(es) onto ${pc.yellow(plan.incoming)}. On a conflict: resolve, ${pc.green("git rebase --continue")}, ${pc.green("gh-stack restack --resume")}${retargeted.length < expectedRetargets(plan) && !noPush ? `, then ${pc.green("gh-stack submit")}` : ""}.`,
    );
    const res = await restackChain(await freshMeta(), stackName, chain, 1, { noPush, verbose });
    touched = [...touched, ...res.touched];
  }

  // ── 5. Verify: no child carries more than its own commits ──
  await verifyResult(plan);

  if (startBranch && startBranch !== (await git.currentBranch().catch(() => null))) {
    await $`git checkout ${startBranch}`.nothrow().quiet();
  }

  const endMeta = await freshMeta();
  const stale = await findStaleRefs(touched, endMeta);
  if (stale.length > 0) {
    console.log();
    if (noPush) {
      p.log.info("Not pushed (--no-push) — these refs are ahead of origin:");
    } else {
      p.log.error("Some branch refs are NOT in sync with origin:");
    }
    for (const { branch, local, remote } of stale) {
      console.log(`  ${pc.yellow("↑")} ${branch}  local ${short(local)}  origin ${remote}`);
    }
    console.log();
    console.log(`  Publish and retarget PRs with: ${pc.green("gh-stack submit")}`);
    if (!noPush) {
      p.outro(pc.red("Join finished with un-pushed refs"));
      process.exit(1);
    }
  }

  console.log();
  p.log.info(
    `Refresh the stack diagram in PR descriptions with ${pc.green("gh-stack update-prs")}.`,
  );
  p.outro(
    pc.green(
      `Joined ${plan.incoming} into ${stackName}${noPush ? " (local only)" : ""}${plan.finalName !== plan.stackName ? ` (renamed from ${plan.stackName})` : ""}`,
    ),
  );
}

// ── Planning (read-only) ──

async function buildPlan(
  meta: StackMetadata,
  incoming: string,
  above: string | undefined,
  startBranch: string | null,
  trunk: string,
): Promise<JoinPlan> {
  if (incoming === trunk || incoming === "main" || incoming === "master") {
    fail(`${pc.yellow(incoming)} is the trunk — it can't join a stack.`);
  }
  if (!(await git.localBranchExists(incoming))) {
    fail(
      `Branch ${pc.yellow(incoming)} doesn't exist locally.\n\n  Fetch it first:\n    ${pc.green(`git fetch origin ${incoming}:${incoming}`)}`,
    );
  }

  // Which stack: the one --above names, else the current branch's.
  const aboveIsBase = above !== undefined && isTrunkName(above);
  const anchor = above !== undefined && !aboveIsBase ? above : startBranch;
  let stackName = anchor ? findStackForBranch(meta, anchor) : null;
  if (!stackName && above !== undefined && !aboveIsBase) {
    // --above may name the base of a split stack (a branch in another stack).
    stackName = Object.entries(meta.stacks).find(([, s]) => stackBase(s) === above)?.[0] ?? null;
  }
  if (!stackName) {
    fail(
      above !== undefined && !aboveIsBase
        ? `Branch ${pc.yellow(above)} is not in any stack.`
        : `The current branch is not in a stack.\n\n  Check out a branch of the stack to join, or pass ${pc.green("--above <branch>")}.`,
    );
  }
  await ensureValidStack(meta, stackName);
  const stack = meta.stacks[stackName]!;
  const base = stackBase(stack);

  // Where the incoming branch comes from.
  const owner = findStackForBranch(meta, incoming);
  if (owner === stackName) fail(`${pc.yellow(incoming)} is already in stack ${pc.yellow(owner)}.`);
  let absorbedStack: string | null = null;
  let absorbedEntry: Branch | null = null;
  if (owner) {
    const ownerStack = meta.stacks[owner]!;
    if (Object.keys(ownerStack.branches).length > 1) {
      fail(
        `${pc.yellow(incoming)} belongs to stack ${pc.yellow(owner)}, which has other branches — joining would strand them.\n\n` +
          `  Move the branches separately, or untrack it there first:\n    ${pc.green(`gh-stack delete ${incoming} --keep-branch`)}`,
      );
    }
    absorbedStack = owner;
    absorbedEntry = ownerStack.branches[incoming]!;
  }
  const dependent = Object.entries(meta.stacks).find(([, s]) => stackBase(s) === incoming);
  if (dependent) {
    fail(
      `Stack ${pc.yellow(dependent[0])} is built on ${pc.yellow(incoming)}; joining would rewrite its base.\n\n  Re-root that stack first (${pc.green("gh-stack restack --onto main")} from it).`,
    );
  }

  // Where it goes.
  let newParent: string;
  if (above === undefined || aboveIsBase || above === base) {
    newParent = base;
  } else if (above === incoming) {
    fail("A branch can't join above itself.");
  } else if (!stack.branches[above]) {
    fail(`${pc.yellow(above)} is not in stack ${pc.yellow(stackName)}.`);
  } else {
    newParent = above;
  }
  const position = newParent === base ? "bottom" : "above";
  const children = getChildren(stack, newParent);

  // Children are restacked from their fork point with their current parent,
  // which is only well-defined if they sit on that parent's tip. Trunk-parented
  // roots may lag main — that's sync's business and the fork point is still exact.
  for (const child of children) {
    if (!isTrunkName(newParent) && !(await git.isAncestor(newParent, child))) {
      fail(
        `${pc.yellow(child)} isn't on ${pc.yellow(newParent)}'s current tip — restack the stack before joining:\n    ${pc.green("gh-stack restack")}`,
      );
    }
  }

  const trunkRef = (await refExists(`origin/${trunk}`)) ? `origin/${trunk}` : trunk;
  const newParentRef = isTrunkName(newParent)
    ? (await refExists(`origin/${newParent}`))
      ? `origin/${newParent}`
      : newParent
    : newParent;
  const newParentTip = await git.revParse(newParentRef);
  const incomingTip = await git.revParse(incoming);

  // The incoming branch's own commits start above its fork point with the
  // trunk — or above its fork point with the new parent, when that's higher
  // (it was branched off that parent). Never replay what's below.
  const needsRebase = !(await git.isAncestor(newParentTip, incomingTip));
  let incomingBoundary = newParentTip;
  if (needsRebase) {
    const higher = await higherOf(
      await git.mergeBase(incomingTip, trunkRef),
      await git.mergeBase(incomingTip, newParentTip),
    );
    if (!higher) {
      fail(`${pc.yellow(incoming)} shares no history with ${pc.yellow(trunkRef)} — can't sync it.`);
    }
    incomingBoundary = higher;
  }
  const own = await project(incomingBoundary, incomingTip);
  const behindTrunk = await git.commitCount(incomingTip, trunkRef);

  const childPlans: ChildPlan[] = [];
  const upstack: string[] = [];
  for (const child of children) {
    // A child already built on the incoming branch keeps those commits below its own.
    const boundary = (await git.isAncestor(incomingTip, child))
      ? incomingTip
      : await git.mergeBase(child, newParentTip);
    if (!boundary) fail(`${pc.yellow(child)} shares no history with ${pc.yellow(newParent)}.`);
    childPlans.push({
      branch: child,
      pr: stack.branches[child]!.pr ?? null,
      oldParent: newParent,
      boundary,
      projection: await project(boundary, child),
    });
    upstack.push(...buildRebaseChain(stack, child).slice(1));
  }

  // Renaming: a stack named after its old bottom branch follows the bottom.
  const oldRoot = getOrderedBranches(stack)[0];
  const nameFree = !meta.stacks[incoming] || incoming === absorbedStack;
  const finalName =
    position === "bottom" && stackName === oldRoot && nameFree ? incoming : stackName;

  const incomingPr = absorbedEntry?.pr ?? (await findOpenPrForBranch(incoming));

  const resulting = structuredClone(stack);
  for (const child of children) resulting.branches[child]!.parent = incoming;
  resulting.branches[incoming] = {
    ...absorbedEntry,
    parent: newParent,
    pr: incomingPr ?? undefined,
  };
  if (children.length === 0) resulting.last_branch = incoming;

  return {
    stackName,
    finalName,
    incoming,
    incomingPr,
    absorbedStack,
    position,
    newParent,
    newParentRef,
    newParentTip,
    trunkRef,
    incomingTip,
    incomingBoundary,
    needsRebase,
    own,
    behindTrunk,
    children: childPlans,
    upstack,
    resulting,
  };
}

function printPlan(plan: JoinPlan, startBranch: string | null): void {
  const where =
    plan.position === "bottom"
      ? `as the new bottom of ${pc.yellow(plan.stackName)}`
      : `above ${pc.yellow(plan.newParent)} in ${pc.yellow(plan.stackName)}`;
  p.log.info(`Joining ${pc.yellow(plan.incoming)} ${where}`);
  if (plan.absorbedStack) {
    console.log(
      `  ${pc.dim(`It's alone in stack ${plan.absorbedStack}; that stack is absorbed into this one.`)}`,
    );
  }
  if (plan.finalName !== plan.stackName) {
    console.log(
      `  ${pc.dim(`New bottom: the stack is renamed ${plan.stackName} → ${plan.finalName}.`)}`,
    );
  }

  console.log();
  p.log.info("Resulting stack:");
  console.log(renderStackTree(plan.resulting, startBranch ?? "", { showNumbers: false }));
  console.log();

  p.log.info("Projected changes (vs new parent):");
  const inPr = plan.incomingPr ? `#${plan.incomingPr}` : "(no PR)";
  console.log(`  ${pc.yellow(plan.incoming)} ${inPr} — parent ${plan.newParent}`);
  console.log(`      ${formatProjection(plan.own)}`);
  if (plan.needsRebase) {
    const lag =
      plan.behindTrunk > 0 ? `it's ${plan.behindTrunk} commit(s) behind ${plan.trunkRef}; ` : "";
    console.log(
      `      ${pc.dim(`${lag}synced onto ${plan.newParentRef} first, replaying only its own commits`)}`,
    );
  }
  for (const child of plan.children) {
    const pr = child.pr ? `#${child.pr}` : "(no PR)";
    console.log(
      `  ${pc.yellow(child.branch)} ${pr} — parent ${child.oldParent} → ${pc.green(plan.incoming)}`,
    );
    console.log(`      ${formatProjection(child.projection)}`);
  }
  if (plan.upstack.length > 0) {
    console.log(`  ${pc.dim(`${plan.upstack.join(", ")}: restacked, diff vs parent unchanged`)}`);
  }

  const retargets = plannedRetargets(plan);
  if (retargets.length > 0) {
    console.log();
    p.log.info("PR bases to retarget on GitHub:");
    for (const r of retargets) console.log(`  #${r.pr} (${r.branch}) → ${pc.green(r.base)}`);
  }
  console.log();
}

// ── Mutation ──

/**
 * Fresh metadata with the join applied in memory: the incoming branch inserted,
 * its one-branch stack absorbed, the stack renamed for a new bottom. Not
 * written — the caller writes it once the incoming branch is synced.
 */
async function joinedMetadata(plan: JoinPlan): Promise<StackMetadata> {
  const meta = await freshMeta();
  const stack = meta.stacks[plan.stackName];
  if (!stack) fail(`Stack ${pc.yellow(plan.stackName)} disappeared — re-run the join.`);

  const entry: Branch = {
    ...(plan.absorbedStack ? meta.stacks[plan.absorbedStack]?.branches[plan.incoming] : {}),
    parent: plan.newParent,
  };
  if (plan.incomingPr != null) entry.pr = plan.incomingPr;
  // The PR's recorded base is stale now; submit/join re-record it once it's set.
  if (entry.prBase !== plan.newParent) delete entry.prBase;

  // Dropped, not archived: restoring an archived copy would track the branch in
  // two stacks. writeMetadata tombstones the file under deleted/ (recoverable).
  if (plan.absorbedStack) delete meta.stacks[plan.absorbedStack];

  for (const child of plan.children) stack.branches[child.branch]!.parent = plan.incoming;
  stack.branches[plan.incoming] = entry;
  if (plan.children.length === 0) stack.last_branch = plan.incoming;

  if (plan.finalName !== plan.stackName) {
    delete meta.stacks[plan.stackName];
    meta.stacks[plan.finalName] = stack;
  }
  meta.current_stack = plan.finalName;
  return meta;
}

interface Retarget {
  branch: string;
  pr: number;
  base: string;
}

function plannedRetargets(plan: JoinPlan): Retarget[] {
  const out: Retarget[] = [];
  if (plan.incomingPr != null) {
    out.push({ branch: plan.incoming, pr: plan.incomingPr, base: plan.newParent });
  }
  for (const child of plan.children) {
    if (child.pr != null) out.push({ branch: child.branch, pr: child.pr, base: plan.incoming });
  }
  return out;
}

function expectedRetargets(plan: JoinPlan): number {
  return plannedRetargets(plan).length;
}

/**
 * Point the incoming PR at its new parent and each child PR at the incoming
 * branch. Only once the synced incoming branch is on origin: against the stale
 * remote copy a child PR's diff would show the very commits the sync dropped.
 */
async function retargetPrs(plan: JoinPlan): Promise<Retarget[]> {
  const targets = plannedRetargets(plan);
  if (targets.length === 0) return [];

  const remote = (await git.remoteHeads()).get(plan.incoming);
  if (remote !== (await git.revParse(plan.incoming))) {
    p.log.warn(
      `${pc.yellow(plan.incoming)} isn't on origin at its synced tip, so PR bases were left alone. Publish and retarget with ${pc.green("gh-stack submit")}.`,
    );
    return [];
  }

  const done: Retarget[] = [];
  for (const t of targets) {
    if (await setPrBase(t.pr, t.base)) {
      p.log.success(`PR #${t.pr} (${t.branch}) base → ${pc.green(t.base)}`);
      done.push(t);
    } else {
      p.log.warn(`Could not retarget PR #${t.pr} — run ${pc.green("gh-stack submit")} to retry`);
    }
  }

  // Record the bases we set, so submit skips the redundant edit.
  if (done.length > 0) {
    const meta = await freshMeta();
    const stack = meta.stacks[plan.finalName];
    if (stack) {
      for (const t of done) {
        const entry = stack.branches[t.branch];
        if (entry) entry.prBase = t.base;
      }
      await writeMetadata(meta);
    }
  }
  return done;
}

/**
 * After the run, no branch may carry more commits than planned: extra commits
 * vs the new parent are exactly the #32 failure (merged main commits leaking
 * into a child's diff). Fewer is fine — a rebase drops already-applied patches.
 */
async function verifyResult(plan: JoinPlan): Promise<void> {
  const checks = [
    { branch: plan.incoming, parent: plan.newParentTip, expected: plan.own.commits },
    ...plan.children.map((c) => ({
      branch: c.branch,
      parent: plan.incoming,
      expected: c.projection.commits,
    })),
  ];
  for (const { branch, parent, expected } of checks) {
    if (!(await git.localBranchExists(branch))) continue;
    const actual = await git.commitCount(parent, branch);
    if (actual > expected) {
      p.log.warn(
        `${pc.yellow(branch)} has ${actual} commit(s) vs its parent; ${expected} expected. Check its diff before review (${pc.green("gh-stack undo")} restores the previous state).`,
      );
    }
  }
}

// ── Helpers ──

function fail(message: string): never {
  p.cancel(message);
  process.exit(1);
}

function isTrunkName(name: string): boolean {
  return name === "main" || name === "master";
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

async function freshMeta(): Promise<StackMetadata> {
  const meta = await readMetadata();
  if (!meta) fail("Stack metadata disappeared.");
  return meta;
}

async function refExists(ref: string): Promise<boolean> {
  const { exitCode } = await $`git rev-parse --verify --quiet ${ref}`.nothrow().quiet();
  return exitCode === 0;
}

/** Of two commits, the one that descends from the other (the safer rebase boundary). */
async function higherOf(a: string | null, b: string | null): Promise<string | null> {
  if (!a || !b || a === b) return a ?? b;
  if (await git.isAncestor(a, b)) return b;
  if (await git.isAncestor(b, a)) return a;
  return a; // unrelated forks: the trunk fork point (`a`) is the defined one
}

/** Commits and diff size of `from..to` — what a branch's PR shows vs its parent. */
async function project(from: string, to: string): Promise<Projection> {
  const commits = await git.commitCount(from, to);
  const { stdout } = await $`git diff --shortstat ${from} ${to}`.nothrow().quiet();
  const text = stdout.toString();
  const num = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0);
  return {
    commits,
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}

function formatProjection(pr: Projection): string {
  return `${pr.commits} commit(s), ${pr.files} file(s) changed, ${pc.green(`+${pr.insertions}`)} ${pc.red(`-${pr.deletions}`)}`;
}
