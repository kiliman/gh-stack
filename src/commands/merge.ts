// gh-stack merge — Squash-merge stack top-down via GitHub
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
import { takeSnapshot } from "../lib/snapshot.ts";
import { getBranchRefSha, getPrInfo, getPrMergeState, resyncPrHead } from "../lib/github.ts";
import { confirmAction } from "../lib/ui.ts";
import {
  planMerges,
  advanceNewBottom,
  type BranchReview,
  type MergeAction,
} from "../lib/advance.ts";

const MAX_RETRIES = 12;
const RETRY_DELAY_MS = 5000;

// After GitHub rejects a merge with the "still recomputing" signature, back off
// (capped) and re-poll before retrying. One entry per retry; length+1 = max
// attempts. Bounds total transient wait per PR to ~30s.
const MERGE_RETRY_BACKOFF_MS = [2000, 4000, 8000, 8000, 8000];

/**
 * GitHub returns these when `mergePullRequest` rejects a merge it considers
 * out of date. In a top-down cascade this is almost always one of two timing
 * artifacts (NOT a genuine conflict): a stale PR head pointer (most common —
 * the child squash moved this branch but GitHub didn't advance the PR's
 * `headRefOid`), or the brief async mergeability-recompute window.
 */
export function isTransientMergeError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("head branch is out of date") ||
    s.includes("base branch was modified") ||
    s.includes("review and try the merge again")
  );
}

/**
 * Squash-merge a PR, healing the two timing artifacts a top-down cascade
 * provokes — neither of which is a real conflict:
 *
 *  1. **Stale PR head (the dominant case).** Squash-merging the child moves
 *     this PR's branch server-side, but GitHub sometimes fails to advance the
 *     PR's recorded `headRefOid`. Every status read (`mergeable`,
 *     `mergeStateStatus`, base…head compare) is computed against that stale
 *     head and reports CLEAN, yet `mergePullRequest` checks the live ref and
 *     rejects "Head branch is out of date" — indefinitely. We detect it by
 *     comparing the PR's head to the live branch ref, and fix it by
 *     close→reopen (`resyncPrHead`), which forces GitHub to re-read the branch.
 *  2. **Mergeability recompute window.** Heads already match but GitHub is
 *     still recomputing (`mergeStateStatus: UNKNOWN`); back off and re-poll.
 *
 * Only a state that settles genuinely non-mergeable (real conflict / failing
 * required check) — or exhausted retries — is a hard failure.
 */
async function squashMergeWithRetry(
  prNumber: number,
  branch: string,
  deleteFlag: boolean,
  s: ReturnType<typeof p.spinner>,
): Promise<{ ok: true } | { ok: false; stderr: string; genuine: boolean }> {
  const maxAttempts = MERGE_RETRY_BACKOFF_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ghArgs = ["pr", "merge", String(prNumber), "--squash"];
    if (deleteFlag) ghArgs.push("--delete-branch");

    const proc = Bun.spawn(["gh", ...ghArgs], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) return { ok: true };

    // Raced with another merge / a prior re-run? If it's already merged, done.
    const state = await getPrMergeState(prNumber);
    if (state?.state === "MERGED") return { ok: true };

    const transient = isTransientMergeError(stderr);
    if (!transient || attempt === maxAttempts) {
      return { ok: false, stderr: stderr.trim(), genuine: !transient };
    }

    // Is the PR's head stuck behind the live branch tip? If so, the merge will
    // fail forever until GitHub re-reads the branch — nudge it via close/reopen
    // rather than burning the backoff budget polling a status that never moves.
    if (await ensureFreshHead(prNumber, branch, s)) {
      await waitForMergeable(prNumber, s);
      continue; // retry the merge with a freshly-synced head
    }

    // Heads match — genuine recompute window. Back off and re-poll; if it
    // settles non-mergeable instead, it was a real conflict after all.
    const delay = MERGE_RETRY_BACKOFF_MS[attempt - 1]!;
    s.message(
      `PR #${prNumber}: GitHub still recomputing mergeability — retrying in ${delay / 1000}s (${attempt}/${maxAttempts - 1})...`,
    );
    await Bun.sleep(delay);
    const ready = await waitForMergeable(prNumber, s);
    if (!ready) return { ok: false, stderr: stderr.trim(), genuine: true };
  }
  // Unreachable — the loop returns on the final attempt.
  return { ok: false, stderr: "merge retries exhausted", genuine: false };
}

/**
 * After a `resyncPrHead` nudge, poll until GitHub advances the PR's recorded
 * head to the live branch SHA (or we give up). Bounded by MAX_RETRIES.
 */
async function waitForHeadSync(
  prNumber: number,
  liveSha: string,
  spinner: ReturnType<typeof p.spinner>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const state = await getPrMergeState(prNumber);
    if (state?.headRefOid === liveSha) return true;
    if (state?.state === "MERGED") return true;
    spinner.message(`Waiting for PR #${prNumber} head to sync... (${attempt}/${MAX_RETRIES})`);
    await Bun.sleep(RETRY_DELAY_MS);
  }
  return false;
}

/**
 * Heal a stuck PR head pointer. If the PR's recorded head has fallen behind the
 * live branch ref (GitHub missed the head-sync after a child squash landed on
 * this branch), force a re-read via close/reopen and wait for the head to catch
 * up. Returns true if a nudge was performed; false (a no-op) when the heads
 * already match, the PR is already merged, or the live ref can't be resolved.
 */
async function ensureFreshHead(
  prNumber: number,
  branch: string,
  s: ReturnType<typeof p.spinner>,
): Promise<boolean> {
  const liveSha = await getBranchRefSha(branch);
  const state = await getPrMergeState(prNumber);
  if (!liveSha || !state?.headRefOid || state.state === "MERGED") return false;
  if (state.headRefOid === liveSha) return false;

  s.message(`PR #${prNumber}: head out of sync with ${pc.yellow(branch)} — nudging GitHub...`);
  await resyncPrHead(prNumber);
  await waitForHeadSync(prNumber, liveSha, s);
  return true;
}

/** A PR's merge readiness, distilled from GitHub's `state` / `mergeable` /
 *  `mergeStateStatus` triple into the decision the merge flow actually needs. */
export type MergeVerdict = "merged" | "closed" | "conflict" | "ready" | "blocked" | "pending";

/**
 * Classify a PR's merge state. The crucial distinction is **conflict vs.
 * blocked**: a `CONFLICTING`/`DIRTY` PR can never merge until someone resolves
 * the conflict (so auto-merge would silently never fire — see the base-PR path),
 * whereas a `BLOCKED` PR (required check still running/failing) is merely not
 * ready *yet* and is a legitimate target for `--auto`.
 *
 *   merged   — already merged
 *   closed   — closed without merging
 *   conflict — mergeable=CONFLICTING or mergeStateStatus=DIRTY (won't self-resolve)
 *   pending  — GitHub still computing mergeability (UNKNOWN)
 *   blocked  — mergeable but gated on required checks/reviews
 *   ready    — mergeable and clean (CLEAN/HAS_HOOKS/UNSTABLE/BEHIND)
 */
export function classifyMergeState(state: {
  state: string;
  mergeable: string;
  mergeStateStatus: string;
}): MergeVerdict {
  if (state.state === "MERGED") return "merged";
  if (state.state === "CLOSED") return "closed";
  if (state.mergeable === "CONFLICTING" || state.mergeStateStatus === "DIRTY") return "conflict";
  // Mergeability not computed yet — caller should keep polling.
  if (state.mergeable === "UNKNOWN" || state.mergeStateStatus === "UNKNOWN") return "pending";
  if (state.mergeStateStatus === "BLOCKED") return "blocked";
  return "ready";
}

/**
 * Wait for a PR to become cleanly mergeable after a previous merge lands.
 * GitHub needs time to process the new commit on the target branch. Returns
 * false fast on a definitive conflict (waiting can't help) and on a closed PR;
 * keeps polling only while GitHub is still computing or the PR is blocked on
 * pending checks.
 */
async function waitForMergeable(
  prNumber: number,
  spinner: ReturnType<typeof p.spinner>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const state = await getPrMergeState(prNumber);
    if (!state) return false;

    const verdict = classifyMergeState(state);
    if (verdict === "merged" || verdict === "ready") return true;
    if (verdict === "conflict" || verdict === "closed") return false; // waiting won't help

    spinner.message(`Waiting for PR #${prNumber} to be ready... (${attempt}/${MAX_RETRIES})`);
    await Bun.sleep(RETRY_DELAY_MS);
  }
  return false;
}

/**
 * Poll until GitHub has *computed* a PR's mergeability, then return the verdict.
 * Unlike `waitForMergeable` this does NOT keep waiting on a `blocked` PR —
 * blocked-on-pending-checks is a fine target for auto-merge, so the base-PR
 * path wants to know that and proceed rather than burn the poll budget. Only a
 * still-`pending` (UNKNOWN) state is polled; returns `pending` if it never
 * settles within the budget.
 */
async function pollMergeVerdict(
  prNumber: number,
  spinner: ReturnType<typeof p.spinner>,
): Promise<MergeVerdict> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const state = await getPrMergeState(prNumber);
    if (!state) return "pending";

    const verdict = classifyMergeState(state);
    if (verdict !== "pending") return verdict;

    spinner.message(`Checking PR #${prNumber} mergeability... (${attempt}/${MAX_RETRIES})`);
    await Bun.sleep(RETRY_DELAY_MS);
  }
  return "pending";
}

export default async function merge(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const deleteFlag = args.includes("--delete-branch") || args.includes("-d");
  const collapse = args.includes("--collapse") || args.includes("--stop-at-base");
  const approved = args.includes("--approved");
  const baseOnly = args.includes("--base");

  if (args.includes("--help")) {
    console.log(`
gh-stack merge — Squash-merge a stack via GitHub

USAGE
  gh-stack merge [--dry-run] [-d|--delete-branch] [--collapse]
  gh-stack merge --approved [--collapse] [--dry-run] [-d|--delete-branch]
  gh-stack merge --base [--dry-run] [-d|--delete-branch]

DEFAULT (top-down collapse)
  Squash-merges the whole stack from top to bottom via GitHub:
    PR3 → squash into PR2, PR2 → squash into PR1, PR1 → auto-merge into main.
  The whole stack lands on main as a single squash commit.

--approved (collapse the approved run)
  Like the default collapse, but only as far up as the stack is approved.
  Walks approval from the BASE up and stops at the first PR that isn't
  approved — contiguous, so an unapproved PR4 caps the run at PR3 even if
  PR5 is approved. Collapses base..highest-approved into a single squash
  commit on main and leaves the unapproved tail in place. After the base PR
  lands, run ${pc.green("gh-stack sync")} to re-root the tail onto main. All approved ⇒
  identical to a full merge.

--base (merge just the bottom PR)
  Squash-merges only the bottom PR into main as its own commit, then re-roots
  the next branch onto main. One PR per run — run it again to land the next.
  Approval is enforced by GitHub branch protection, not gh-stack.

--collapse (stop before main)
  With the default or --approved, stop after collapsing into the base PR
  WITHOUT merging it to main — review the cumulative diff on GitHub, then
  re-run ${pc.green("gh-stack merge")} to finish. Alias: --stop-at-base.

All merges happen on GitHub, so PRs show as "Merged", Linear tickets close
automatically, and Actions/webhooks fire normally. Already-merged PRs are
skipped (safe to re-run after a partial failure), and a spurious "Head branch
is out of date" (a stale PR head pointer after a child squash) self-heals by
re-syncing and retrying — only a genuine conflict or failing required check is
a hard failure.

A snapshot is taken first; ${pc.green("gh-stack undo")} restores the prior state.

OPTIONS
  -d, --delete-branch  Delete remote branches after merging
      --approved       Collapse only the approved run (from the base up)
      --base           Merge just the bottom PR into main, re-root the next
      --collapse       Stop after collapsing into the base PR (don't merge to
                       main); alias: --stop-at-base
      --dry-run        Show what would happen without doing anything
`);
    return;
  }

  if (baseOnly) {
    await mergeBaseOnly(deleteFlag, dryRun);
    return;
  }

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(`Branch ${pc.blue(currentBranch)} not found in any stack`);
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  await ensureValidStack(meta, stackName);
  const ordered = getOrderedBranches(stack);

  // A split stack is rooted on a branch in another stack, so its base PR
  // doesn't target main — merging it now would land it against the wrong base.
  // Re-root onto main first (after the parent stack merges).
  const base = stackBase(stack);
  if (base !== "main" && base !== "master") {
    p.cancel(
      `${pc.yellow(stackName)} is based on ${pc.yellow(base)}, not main — can't merge yet.\n\n` +
        `  Merge (or finish) the parent stack first, then re-root onto main:\n` +
        `    ${pc.green("gh-stack restack --onto main")}`,
    );
    process.exit(1);
  }

  // ── Determine the collapse range ──
  // Default: the whole stack. --approved: only the contiguous-from-base
  // APPROVED run — the first unapproved PR is the ceiling. The unapproved tail
  // is left in place and re-rooted by a later `gh-stack sync` once the base PR
  // lands on main (approach A — no CI blocking). All approved ⇒ whole stack.
  let rangeOrdered = ordered;
  let tail: string[] = [];
  if (approved) {
    const reviewSpinner = p.spinner();
    reviewSpinner.start("Checking PR review status...");
    // Fetch every branch's review state concurrently — sequential `gh` calls
    // add up fast on a deep stack.
    const reviews: BranchReview[] = await Promise.all(
      ordered.map(async (branch) => {
        const pr = stack.branches[branch]?.pr ?? null;
        if (pr == null) return { branch, pr: null, prState: null, reviewDecision: null };
        const info = await getPrInfo(pr);
        return {
          branch,
          pr,
          prState: info?.state ?? null,
          reviewDecision: info?.reviewDecision ?? null,
        };
      }),
    );
    reviewSpinner.stop("Review status checked");

    // planMerges walks bottom-up over the contiguous run of approved (or
    // already-merged) branches, stopping at the first that isn't approved.
    const plan = planMerges(reviews, { approveAndMerge: true });
    if (plan.steps.length === 0) {
      p.cancel(
        `Nothing approved to merge — the base PR isn't approved yet${plan.stop ? ` (${plan.stop.reason})` : ""}.\n\n` +
          `  Approval is taken contiguously from the base, so the bottom PR must be approved first.`,
      );
      return;
    }
    rangeOrdered = ordered.slice(0, plan.steps.length);
    tail = ordered.slice(plan.steps.length);
  }

  if (rangeOrdered.length <= 1) {
    // Only the base PR is in range (single-branch stack, or --approved with just
    // the bottom approved). Nothing to collapse — enable auto-merge on the base.
    const basePr = stack.branches[rangeOrdered[0]!]?.pr;
    if (collapse) {
      p.log.info(
        `Nothing to collapse — the base PR${basePr ? ` (#${basePr})` : ""} already targets main.`,
      );
      return;
    }
    if (basePr) {
      p.log.info(
        tail.length > 0
          ? `Base PR (#${basePr}) is approved — enabling auto-merge on GitHub.`
          : "Single branch stack — enabling auto-merge on GitHub.",
      );
      if (!dryRun) {
        try {
          await $`gh pr merge ${basePr} --squash --auto`.quiet();
          p.log.success(`Auto-merge enabled for PR #${basePr}`);
        } catch {
          p.log.info(`Enable manually: ${pc.dim(`gh pr merge ${basePr} --squash --auto`)}`);
        }
      }
    } else {
      p.log.info("Single branch stack — merge via GitHub as normal.");
    }
    if (tail.length > 0 && !dryRun) {
      console.log();
      p.log.info(
        `${tail.length} unapproved branch(es) left in place. After PR #${basePr} lands, run ${pc.green("gh-stack sync")} to re-root them onto main.`,
      );
    }
    return;
  }

  p.intro(pc.cyan(collapse ? "Stack Collapse (via GitHub)" : "Stack Merge (via GitHub)"));
  p.log.info(`Stack: ${pc.yellow(stackName)}`);
  if (approved) {
    p.log.info(
      pc.dim(
        `--approved: collapsing the ${rangeOrdered.length} approved branch(es) from the base up.`,
      ),
    );
  }
  if (collapse) {
    p.log.info(
      pc.dim("--collapse: will stop after collapsing into base PR; base will NOT merge to main."),
    );
  }
  console.log();

  // Check PR states and build the merge plan — scoped to the collapse RANGE
  // (the whole stack by default, the approved run under --approved).
  const reversed = rangeOrdered.toReversed();
  const baseBranch = rangeOrdered[0]!;
  const basePr = stack.branches[baseBranch]?.pr;

  console.log(`  ${pc.bold("Merge plan:")}`);
  for (let i = 0; i < reversed.length - 1; i++) {
    const child = reversed[i]!;
    const parent = stack.branches[child]?.parent || "???";
    const childPr = stack.branches[child]?.pr;

    // Check if already merged
    const prState = childPr ? await getPrMergeState(childPr) : null;
    const isMerged = prState?.state === "MERGED";
    const mergedLabel = isMerged ? pc.dim(" (already merged)") : "";

    console.log(
      `    ${pc.yellow(child)}${childPr ? ` (#${childPr})` : ""} → squash into ${pc.blue(parent)}${mergedLabel}`,
    );
  }
  if (collapse) {
    console.log(
      `    ${pc.blue(baseBranch)}${basePr ? ` (#${basePr})` : ""} → ${pc.dim("(stop — review on GitHub, then re-run merge to finish)")}`,
    );
  } else {
    console.log(
      `    ${pc.blue(baseBranch)}${basePr ? ` (#${basePr})` : ""} → ${pc.green("main")} (auto-merge)`,
    );
  }
  if (tail.length > 0) {
    console.log(
      `    ${pc.dim(`⏹ ${tail.length} unapproved branch(es) above left in place → re-root with `)}${pc.green("gh-stack sync")}${pc.dim(" after the base lands")}`,
    );
  }
  console.log();

  if (dryRun) {
    p.outro(pc.yellow("[DRY RUN] No changes made"));
    return;
  }

  // Every PR in the collapse RANGE must have a number (tail branches aren't
  // being merged now, so a local-only tip there is fine).
  const missingPrs = rangeOrdered.filter((b) => !stack.branches[b]?.pr);
  if (missingPrs.length > 0) {
    p.cancel(
      `Missing PR numbers for: ${missingPrs.join(", ")}\n\n  Run ${pc.green("gh-stack submit")} first to create PRs.`,
    );
    process.exit(1);
  }

  const confirmed = await confirmAction(
    collapse
      ? "Collapse stack top-down via GitHub (stop at base PR)?"
      : "Squash-merge stack top-down via GitHub?",
  );
  if (!confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Take snapshot
  await takeSnapshot(meta, stackName, collapse ? "collapse" : "merge");

  // Merge top-down via GitHub: for each PR from top, squash-merge into parent
  for (let i = 0; i < reversed.length - 1; i++) {
    const childBranch = reversed[i]!;
    const childPrNum = stack.branches[childBranch]!.pr!;
    const parentBranch = stack.branches[childBranch]!.parent;

    if (parentBranch === "main" || parentBranch === "master") continue;

    // Check if already merged (skip)
    const prState = await getPrMergeState(childPrNum);
    if (prState?.state === "MERGED") {
      p.log.info(`${pc.dim("✓")} PR #${childPrNum} already merged — skipping`);
      continue;
    }

    console.log();
    console.log(pc.cyan("━".repeat(40)));
    console.log(
      `${pc.blue("Merge:")} PR #${childPrNum} ${pc.yellow(childBranch)} → ${pc.blue(parentBranch)}`,
    );
    console.log(pc.cyan("━".repeat(40)));

    // Wait for PR to be mergeable (GitHub may need time after previous merge)
    const s = p.spinner();
    s.start(`Checking PR #${childPrNum} is ready to merge...`);
    const ready = await waitForMergeable(childPrNum, s);

    if (!ready) {
      s.stop(pc.red(`PR #${childPrNum} is not mergeable`));
      p.log.info("Check the PR on GitHub for merge conflicts or required checks.");
      p.log.info("Re-run merge to continue from where you left off.");
      process.exit(2);
    }

    s.message(`Squash-merging PR #${childPrNum} via GitHub...`);

    const result = await squashMergeWithRetry(childPrNum, childBranch, deleteFlag, s);

    if (result.ok) {
      s.stop(`Merged PR #${childPrNum} into ${pc.blue(parentBranch)}`);
    } else {
      s.stop(pc.red(`Failed to merge PR #${childPrNum}`));
      p.log.error(result.stderr);
      if (result.genuine) {
        p.log.info(
          "This looks like a real conflict or a failing required check — resolve it on GitHub.",
        );
      } else {
        p.log.info(
          "GitHub's mergeability recompute didn't settle in time (transient lag, not a conflict).",
        );
      }
      p.log.info("Re-run merge to continue from where you left off.");
      process.exit(2);
    }
  }

  // ─── --collapse: stop here. Base PR holds the cumulative diff; let the
  //     user review on GitHub and re-run `gh-stack merge` to finish.
  if (collapse) {
    console.log();

    // Park the user on the base branch — mirrors how normal merge lands you
    // on `main`. Fetch origin so they can see how far behind their local
    // base branch is (the squashed commits live only on origin/<base> now).
    const checkoutSpinner = p.spinner();
    checkoutSpinner.start(`Checking out base branch ${pc.yellow(baseBranch)}...`);
    let localBehind = false;
    try {
      await $`git fetch origin`.quiet();
      await git.checkout(baseBranch);

      // Compare local vs origin to flag the user if their local base is stale
      try {
        const localSha = await git.revParse(baseBranch);
        const remoteSha = await git.revParse(`origin/${baseBranch}`);
        localBehind = localSha !== remoteSha;
      } catch {}

      checkoutSpinner.stop(`On base branch ${pc.yellow(baseBranch)}`);
    } catch {
      checkoutSpinner.stop(pc.dim(`Could not checkout ${baseBranch} — switch manually if needed`));
    }

    console.log();
    console.log(pc.cyan("━".repeat(40)));
    console.log(pc.green("  Stack collapsed into base PR"));
    console.log(pc.cyan("━".repeat(40)));
    console.log();

    // Fetch the base PR URL for a clickable summary line
    let baseUrl: string | null = null;
    try {
      const proc = Bun.spawn(["gh", "pr", "view", String(basePr), "--json", "url", "-q", ".url"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      if ((await proc.exited) === 0 && out) baseUrl = out;
    } catch {}

    console.log(
      `  ${pc.blue("Base PR:")} #${basePr} ${pc.yellow(baseBranch)} → ${pc.green("main")}`,
    );
    if (baseUrl) console.log(`  ${pc.dim(baseUrl)}`);
    if (localBehind) {
      console.log();
      console.log(
        `  ${pc.yellow("⚠")} Local ${pc.yellow(baseBranch)} is behind ${pc.dim(`origin/${baseBranch}`)}`,
      );
      console.log(
        `    ${pc.dim("(squashed commits from upper PRs live on origin only — review the diff on GitHub)")}`,
      );
    }
    console.log();
    console.log(`  ${pc.dim("Review the cumulative diff on GitHub. When ready to ship:")}`);
    console.log(
      `    ${pc.green("gh-stack merge")}    ${pc.dim("# finishes base PR → main + archives")}`,
    );
    console.log();

    p.outro(pc.green("Collapse complete — stack left intact for review."));
    return;
  }

  // Base PR → enable auto-merge into main
  console.log();
  console.log(pc.cyan("━".repeat(40)));
  console.log(
    `${pc.blue("Auto-merge:")} PR #${basePr} ${pc.yellow(baseBranch)} → ${pc.green("main")}`,
  );
  console.log(pc.cyan("━".repeat(40)));

  const autoSpinner = p.spinner();

  // Confirm the base PR can ACTUALLY merge before handing off to auto-merge.
  // A conflicting PR silently accepts `--auto` but never fires — so enabling
  // auto-merge and archiving on a conflict reports a false success and leaves
  // an un-mergeable PR stranded. Heal a possibly-stale PR head first (the last
  // intermediate merge moved this branch), then poll until GitHub finishes
  // computing mergeability and classify the result.
  autoSpinner.start(`Checking PR #${basePr} is mergeable...`);
  await ensureFreshHead(basePr!, baseBranch, autoSpinner);
  const verdict = await pollMergeVerdict(basePr!, autoSpinner);

  // Conflict / closed / never-settled → STOP. Do not enable auto-merge, do not
  // archive: leave the stack intact so a re-run finishes it after resolution.
  if (verdict === "conflict" || verdict === "closed" || verdict === "pending") {
    autoSpinner.stop(
      pc.red(
        verdict === "conflict"
          ? `PR #${basePr} has merge conflicts with main`
          : verdict === "closed"
            ? `PR #${basePr} is closed — not merging`
            : `Could not confirm PR #${basePr} is mergeable`,
      ),
    );
    console.log();
    if (verdict === "conflict") {
      p.log.error(
        `${pc.yellow(baseBranch)} conflicts with ${pc.green("main")} — auto-merge would never fire.`,
      );
      p.log.info("Resolve the conflict, then finish the merge:");
      console.log(
        `    ${pc.green("gh-stack sync")}     ${pc.dim("# rebase the base onto main & resolve conflicts")}`,
      );
      console.log(
        `    ${pc.green("gh-stack merge")}    ${pc.dim("# finishes base PR → main + archives")}`,
      );
    } else if (verdict === "pending") {
      p.log.warn(
        "GitHub didn't settle the merge state in time (transient lag, not necessarily a conflict).",
      );
      p.log.info(`Verify the PR on GitHub, then re-run ${pc.green("gh-stack merge")} to finish.`);
    }
    console.log();
    p.log.info(pc.dim("Stack NOT archived — your stack metadata is intact. Re-run to finish."));
    process.exit(2);
  }

  const enableAutoMerge = async (): Promise<{ ok: boolean; stderr: string }> => {
    const ghArgs = ["pr", "merge", String(basePr), "--squash", "--auto"];
    if (deleteFlag) ghArgs.push("--delete-branch");
    const proc = Bun.spawn(["gh", ...ghArgs], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, stderr: stderr.trim() };
  };

  // verdict is "merged", "ready", or "blocked" (pending checks). All are safe to
  // archive: the PR is either already merged or will merge once checks pass.
  if (verdict === "merged") {
    autoSpinner.stop(`PR #${basePr} already merged into main`);
  } else {
    autoSpinner.message(`Enabling auto-merge for PR #${basePr}...`);
    let auto = await enableAutoMerge();
    if (!auto.ok && isTransientMergeError(auto.stderr)) {
      // Same stale-head artifact as the cascade — re-sync and try once more.
      await ensureFreshHead(basePr!, baseBranch, autoSpinner);
      await pollMergeVerdict(basePr!, autoSpinner);
      auto = await enableAutoMerge();
    }

    if (auto.ok) {
      autoSpinner.stop(
        `Auto-merge enabled for PR #${basePr} — will merge into main when CI passes`,
      );
    } else {
      autoSpinner.stop(pc.yellow(`Could not enable auto-merge for PR #${basePr}`));
      if (auto.stderr) p.log.error(auto.stderr);
      p.log.info(`Enable manually: ${pc.dim(`gh pr merge ${basePr} --squash --auto`)}`);
    }
  }

  // Update local main and clean up
  console.log();
  const pullSpinner = p.spinner();
  pullSpinner.start("Syncing local branches...");
  try {
    await $`git fetch origin`.quiet();
    await git.checkout("main");
    await $`git pull origin main`.quiet();
    pullSpinner.stop("Local branches synced");
  } catch {
    pullSpinner.stop(pc.dim("Could not sync local branches — run git pull manually"));
  }

  // --approved with an unapproved tail: the base PR is auto-merging the approved
  // run as one commit, but branches remain. DON'T archive — leave the stack so
  // `gh-stack sync` can re-root the tail onto main once the base lands (it
  // detects the merged bottom and advances past it). (approach A)
  if (tail.length > 0) {
    p.outro(
      pc.green(
        `Approved run collapsed into PR #${basePr} → auto-merging to main. ` +
          `After it lands, run \`gh-stack sync\` to re-root the ${tail.length} remaining branch(es).`,
      ),
    );
    return;
  }

  // Archive the stack
  if (!meta.archive) meta.archive = {};
  meta.archive[stackName] = { ...stack };
  delete meta.stacks[stackName];
  if (meta.current_stack === stackName) {
    // Don't auto-pick a random leftover stack as "current" — that switches you
    // to a stack you never checked out. The current stack is derived from the
    // branch you're on; after a merge you're on main, so default to none.
    meta.current_stack = null;
  }
  await writeMetadata(meta);

  p.outro(pc.green("Stack merge complete! Stack archived."));
}

/**
 * `gh-stack merge --base` — squash-merge ONLY the bottom PR into main, then
 * re-root the next branch onto main (replaying just its own commits, via
 * advance.ts's fork-point resolution). One PR per run — run it again to land the
 * next. Approval is NOT checked here; GitHub branch protection enforces it.
 * A base PR already merged outside gh-stack is detected and advanced past.
 */
async function mergeBaseOnly(deleteFlag: boolean, dryRun: boolean): Promise<void> {
  // We rebase the surviving branches, so the same pre-flight guards as restack.
  if (await git.isRebaseInProgress()) {
    p.cancel(
      `Git rebase already in progress.\n\n  Finish or abort it first:\n    ${pc.green("git rebase --continue")}\n    ${pc.red("git rebase --abort")}`,
    );
    process.exit(1);
  }
  if (!dryRun) await ensureCleanWorkingTree();

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);
  if (!stackName) {
    p.cancel(`Branch ${pc.blue(currentBranch)} not found in any stack`);
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  await ensureValidStack(meta, stackName);
  const ordered = getOrderedBranches(stack);
  if (ordered.length === 0) {
    p.cancel("No branches in this stack");
    process.exit(1);
  }

  // Like top-down merge: a split stack rooted off another stack can't drain to
  // main until it's re-rooted. Require a trunk base.
  const base = stackBase(stack);
  if (base !== "main" && base !== "master") {
    p.cancel(
      `${pc.yellow(stackName)} is based on ${pc.yellow(base)}, not main — can't merge yet.\n\n` +
        `  Merge (or finish) the parent stack first, then re-root onto main:\n` +
        `    ${pc.green("gh-stack restack --onto main")}`,
    );
    process.exit(1);
  }
  const trunk = base;
  const targetRef = `origin/${trunk}`;

  p.intro(pc.cyan("Merge Base PR (via GitHub)"));
  p.log.info(`Stack: ${pc.yellow(stackName)}`);

  const baseBranch = ordered[0]!;
  const basePr = stack.branches[baseBranch]?.pr ?? null;
  if (basePr == null) {
    p.cancel(
      `Base branch ${pc.yellow(baseBranch)} has no PR.\n\n  Open it with ${pc.green("gh-stack submit")} first.`,
    );
    process.exit(1);
  }

  // Only the bottom PR is merged. If it already landed (e.g. via the GitHub UI),
  // advance the stack past it instead of re-merging.
  const baseState = await getPrMergeState(basePr);
  const baseAction: MergeAction = baseState?.state === "MERGED" ? "advance-only" : "merge";
  const plan = { steps: [{ branch: baseBranch, pr: basePr, action: baseAction }] };
  const nextChild = ordered[1] ?? null;

  console.log();
  console.log(`  ${pc.bold("Plan:")}`);
  console.log(
    `    ${pc.yellow(baseBranch)} (#${basePr}) → ${
      baseAction === "advance-only"
        ? pc.dim("already merged — advance past")
        : `${pc.green("squash-merge")} → ${pc.green(trunk)}`
    }`,
  );
  if (nextChild) {
    console.log(
      `    ${pc.dim(`then re-root ${nextChild} onto ${trunk} — the rest stays a stack`)}`,
    );
  }
  console.log();

  if (dryRun) {
    p.outro(pc.yellow("[DRY RUN] No changes made"));
    return;
  }

  const confirmed = await confirmAction(
    nextChild
      ? `Merge base PR #${basePr} into ${trunk} and re-root ${nextChild}?`
      : `Merge base PR #${basePr} into ${trunk}?`,
  );
  if (!confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Snapshot first — this records every branch's pre-merge tip, which both the
  // fork-point resolver and `gh-stack undo` rely on.
  await takeSnapshot(meta, stackName, "merge-base");
  // Keep a copy of the original topology to archive if the stack fully drains.
  const originalStack = structuredClone(stack);

  await $`git fetch origin ${trunk}`.quiet();

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    const mergedBranch = step.branch;
    const child = ordered[i + 1] ?? null;
    const childPr = child ? (stack.branches[child]?.pr ?? null) : null;

    console.log();
    console.log(pc.cyan("━".repeat(40)));
    console.log(
      `${pc.blue(step.action === "merge" ? "Merge:" : "Advance:")} ${pc.yellow(mergedBranch)}${step.pr ? ` (#${step.pr})` : ""} → ${pc.green(trunk)}`,
    );
    console.log(pc.cyan("━".repeat(40)));

    if (step.action === "merge") {
      const prNum = step.pr!;
      // Never stand on the branch we're about to merge (especially with
      // --delete-branch, which removes the local branch too).
      if ((await git.currentBranch().catch(() => "")) === mergedBranch) {
        await git.checkout(trunk).catch(() => {});
      }

      const s = p.spinner();
      s.start(`Checking PR #${prNum} is ready to merge...`);
      await ensureFreshHead(prNum, mergedBranch, s);
      const ready = await waitForMergeable(prNum, s);
      if (!ready) {
        s.stop(pc.red(`PR #${prNum} is not mergeable`));
        p.log.info("Check the PR on GitHub for merge conflicts or required checks.");
        p.log.info("Re-run `gh-stack merge --base` to continue.");
        process.exit(2);
      }

      s.message(`Squash-merging PR #${prNum} into ${trunk}...`);
      const result = await squashMergeWithRetry(prNum, mergedBranch, deleteFlag, s);
      if (result.ok) {
        s.stop(`Merged PR #${prNum} into ${pc.green(trunk)}`);
      } else {
        s.stop(pc.red(`Failed to merge PR #${prNum}`));
        p.log.error(result.stderr);
        p.log.info(
          result.genuine
            ? "Real conflict or failing required check — resolve it on GitHub."
            : "GitHub's mergeability recompute didn't settle (transient lag).",
        );
        p.log.info("Re-run `gh-stack merge --base` to continue.");
        process.exit(2);
      }
    } else {
      p.log.info(`PR #${step.pr} already merged — advancing the stack past it.`);
    }

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
          console.log(`  Resolve the conflict, then:`);
          console.log(`    ${pc.green("git rebase --continue")}`);
          console.log(
            `    ${pc.green("gh-stack restack")}   ${pc.dim("(restacks the rest of the tail)")}`,
          );
          console.log();
          console.log(
            pc.dim(`  The merged PR(s) below ${child} are done; only the re-root needs finishing.`),
          );
        } else {
          p.log.error(
            `Could not determine a safe rebase base for ${pc.yellow(child)} (${res.reason}).`,
          );
          console.log(
            `  Re-root it manually:\n    ${pc.green(`git rebase --onto ${targetRef} <merged-tip> ${child}`)}`,
          );
        }
        process.exit(2);
      }
    } else {
      // The merged branch was the top — nothing rides above it. Just drop it.
      await removeBranchFromStack(meta, stackName, mergedBranch);
    }
  }

  // Did the whole stack drain, or is there a tail to restack?
  const survivingStack = meta.stacks[stackName];
  const remaining = survivingStack ? getOrderedBranches(survivingStack) : [];

  if (remaining.length === 0) {
    // Fully drained — archive the original topology and land on the trunk.
    console.log();
    const pullSpinner = p.spinner();
    pullSpinner.start("Syncing local trunk...");
    try {
      await git.checkout(trunk);
      await $`git pull origin ${trunk}`.quiet();
      pullSpinner.stop("Local trunk synced");
    } catch {
      pullSpinner.stop(pc.dim(`Could not sync ${trunk} — run git pull manually`));
    }

    if (!meta.archive) meta.archive = {};
    meta.archive[stackName] = originalStack;
    delete meta.stacks[stackName];
    if (meta.current_stack === stackName) meta.current_stack = null;
    await writeMetadata(meta);

    p.outro(pc.green(`Base PR #${basePr} merged — stack drained & archived.`));
    return;
  }

  // Restack the surviving tail onto the newly re-rooted bottom. The new bottom
  // is itself already rebased onto main; restack skips it (base branch) and
  // propagates onto its children using the snapshot taken above.
  console.log();
  p.log.info(
    `Restacking ${remaining.length} remaining branch(es) onto ${pc.yellow(remaining[0]!)}...`,
  );
  const newBottom = remaining[0]!;
  if (await git.localBranchExists(newBottom)) {
    await git.checkout(newBottom);
    const { default: restack } = await import("./restack.ts");
    await restack([]);
  }

  p.outro(
    pc.green(
      `Merged base PR #${basePr} into ${trunk}; ${remaining.length} branch(es) left as a stack.`,
    ),
  );
}
