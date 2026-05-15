// gh-stack merge — Squash-merge stack top-down via GitHub
import * as p from "@clack/prompts";
import pc from "picocolors";
import { $ } from "bun";
import * as git from "../lib/git.ts";
import { findStackForBranch, getOrderedBranches, writeMetadata } from "../lib/metadata.ts";
import { ensureMetadata, ensureValidStack } from "../lib/safety.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { getPrMergeState } from "../lib/github.ts";
import { confirmAction } from "../lib/ui.ts";

const MAX_RETRIES = 12;
const RETRY_DELAY_MS = 5000;

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
Waits for GitHub to process between merges if needed.

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

    const ghArgs = ["pr", "merge", String(childPrNum), "--squash"];
    if (deleteFlag) ghArgs.push("--delete-branch");

    const proc = Bun.spawn(["gh", ...ghArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      s.stop(`Merged PR #${childPrNum} into ${pc.blue(parentBranch)}`);
    } else {
      s.stop(pc.red(`Failed to merge PR #${childPrNum}`));
      p.log.error(stderr.trim());
      p.log.info("Re-run merge to continue from where you left off.");
      process.exit(2);
    }
  }

  // ─── --collapse: stop here. Base PR holds the cumulative diff; let the
  //     user review on GitHub and re-run `gh-stack merge` to finish.
  if (collapse) {
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

  // Wait for base PR to be ready (may need time after last intermediate merge)
  autoSpinner.start(`Waiting for PR #${basePr} to be ready...`);
  await waitForMergeable(basePr!, autoSpinner);

  autoSpinner.message(`Enabling auto-merge for PR #${basePr}...`);

  try {
    const ghArgs = ["pr", "merge", String(basePr), "--squash", "--auto"];
    if (deleteFlag) ghArgs.push("--delete-branch");

    const proc = Bun.spawn(["gh", ...ghArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    autoSpinner.stop(`Auto-merge enabled for PR #${basePr} — will merge into main when CI passes`);
  } catch {
    autoSpinner.stop(pc.yellow(`Could not enable auto-merge for PR #${basePr}`));
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
