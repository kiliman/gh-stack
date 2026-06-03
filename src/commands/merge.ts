// gh-stack merge — Squash-merge stack top-down via GitHub
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
import { ensureMetadata, ensureValidStack } from "../lib/safety.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { getBranchRefSha, getPrMergeState, resyncPrHead } from "../lib/github.ts";
import { confirmAction } from "../lib/ui.ts";

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

/**
 * Wait for a PR to become mergeable after a previous merge lands.
 * GitHub needs time to process the new commit on the target branch.
 */
async function waitForMergeable(
  prNumber: number,
  spinner: ReturnType<typeof p.spinner>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const state = await getPrMergeState(prNumber);
    if (!state) return false;

    if (state.state === "MERGED") return true; // Already merged
    if (state.state === "CLOSED") return false;

    // "CLEAN", "HAS_HOOKS", "UNSTABLE" are all mergeable states
    if (state.mergeable === "MERGEABLE" && state.mergeStateStatus !== "BLOCKED") {
      return true;
    }

    spinner.message(`Waiting for PR #${prNumber} to be ready... (${attempt}/${MAX_RETRIES})`);
    await Bun.sleep(RETRY_DELAY_MS);
  }
  return false;
}

export default async function merge(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const deleteFlag = args.includes("--delete-branch") || args.includes("-d");
  const collapse = args.includes("--collapse") || args.includes("--stop-at-base");

  if (args.includes("--help")) {
    console.log(`
gh-stack merge — Squash-merge stack via GitHub

USAGE
  gh-stack merge [--dry-run] [-d|--delete-branch] [--collapse]

Squash-merges the stack from top to bottom via GitHub:
  PR3 → squash into PR2, PR2 → squash into PR1, PR1 → auto-merge into main.

All merges happen on GitHub, so PRs show as "Merged", Linear tickets
close automatically, and all GitHub Actions/webhooks fire normally.

Skips PRs that are already merged (safe to re-run after partial failure).
Waits for GitHub to process between merges, and self-heals GitHub's
spurious "Head branch is out of date" (a stale PR head pointer after a
child squash) by re-syncing the branch and retrying — only a genuine
conflict or failing required check is reported as a hard failure.

OPTIONS
  -d, --delete-branch  Delete remote branches after merging
      --dry-run        Show what would happen without doing anything
      --collapse       Stop after collapsing the stack into the base PR;
                       do NOT merge base PR into main. Lets you review the
                       cumulative diff on GitHub first. Re-run ${pc.green("gh-stack merge")}
                       (without --collapse) to finish the job.
      --stop-at-base   Alias for --collapse
`);
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

  if (ordered.length <= 1) {
    // Single branch — just enable auto-merge
    const basePr = stack.branches[ordered[0]!]?.pr;
    if (collapse) {
      p.log.info(
        `Single-branch stack — nothing to collapse. The base PR${basePr ? ` (#${basePr})` : ""} already targets main.`,
      );
      return;
    }
    if (basePr) {
      p.log.info("Single branch stack — enabling auto-merge on GitHub.");
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
    return;
  }

  p.intro(pc.cyan(collapse ? "Stack Collapse (via GitHub)" : "Stack Merge (via GitHub)"));
  p.log.info(`Stack: ${pc.yellow(stackName)}`);
  if (collapse) {
    p.log.info(
      pc.dim("--collapse: will stop after collapsing into base PR; base will NOT merge to main."),
    );
  }
  console.log();

  // Check PR states and build the merge plan
  const reversed = ordered.toReversed();
  const baseBranch = ordered[0]!;
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
  console.log();

  if (dryRun) {
    p.outro(pc.yellow("[DRY RUN] No changes made"));
    return;
  }

  // Check all PRs in stack have PR numbers
  const missingPrs = ordered.filter((b) => !stack.branches[b]?.pr);
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

  // Wait for base PR to be ready (may need time after last intermediate merge).
  // The last intermediate merge moved this branch, so — like the cascade — the
  // base PR's head can be stuck behind the live ref; heal it before enabling
  // auto-merge, then once more if GitHub still rejects the first attempt.
  autoSpinner.start(`Waiting for PR #${basePr} to be ready...`);
  await ensureFreshHead(basePr!, baseBranch, autoSpinner);
  await waitForMergeable(basePr!, autoSpinner);

  autoSpinner.message(`Enabling auto-merge for PR #${basePr}...`);

  const enableAutoMerge = async (): Promise<{ ok: boolean; stderr: string }> => {
    const ghArgs = ["pr", "merge", String(basePr), "--squash", "--auto"];
    if (deleteFlag) ghArgs.push("--delete-branch");
    const proc = Bun.spawn(["gh", ...ghArgs], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, stderr: stderr.trim() };
  };

  let auto = await enableAutoMerge();
  if (!auto.ok && isTransientMergeError(auto.stderr)) {
    // Same stale-head artifact as the cascade — re-sync and try once more.
    await ensureFreshHead(basePr!, baseBranch, autoSpinner);
    await waitForMergeable(basePr!, autoSpinner);
    auto = await enableAutoMerge();
  }

  if (auto.ok) {
    autoSpinner.stop(`Auto-merge enabled for PR #${basePr} — will merge into main when CI passes`);
  } else {
    autoSpinner.stop(pc.yellow(`Could not enable auto-merge for PR #${basePr}`));
    if (auto.stderr) p.log.error(auto.stderr);
    p.log.info(`Enable manually: ${pc.dim(`gh pr merge ${basePr} --squash --auto`)}`);
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
}
