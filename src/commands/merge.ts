// gh-stack merge — Squash-merge stack top-down via GitHub
import * as p from "@clack/prompts";
import pc from "picocolors";
import { $ } from "bun";
import * as git from "../lib/git.ts";
import { findStackForBranch, getOrderedBranches, writeMetadata } from "../lib/metadata.ts";
import { ensureMetadata, ensureValidStack } from "../lib/safety.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { confirmAction } from "../lib/ui.ts";

export default async function merge(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const deleteFlag = args.includes("--delete-branch") || args.includes("-d");

  if (args.includes("--help")) {
    console.log(`
gh-stack merge — Squash-merge stack via GitHub

USAGE
  gh-stack merge [--dry-run] [-d|--delete-branch]

Squash-merges the stack from top to bottom via GitHub:
  PR3 → squash into PR2, PR2 → squash into PR1, PR1 → auto-merge into main.

All merges happen on GitHub, so PRs show as "Merged", Linear tickets
close automatically, and all GitHub Actions/webhooks fire normally.

OPTIONS
  -d, --delete-branch  Delete remote branches after merging
      --dry-run        Show what would happen without doing anything
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

  p.intro(pc.cyan("Stack Merge (via GitHub)"));

  p.log.info(`Stack: ${pc.yellow(stackName)}`);
  console.log();

  // Show the merge plan: from top to bottom
  const reversed = ordered.toReversed();
  console.log(`  ${pc.bold("Merge plan:")}`);
  for (let i = 0; i < reversed.length - 1; i++) {
    const child = reversed[i]!;
    const parent = stack.branches[child]?.parent || "???";
    const childPr = stack.branches[child]?.pr;
    console.log(
      `    ${pc.yellow(child)}${childPr ? ` (#${childPr})` : ""} → squash into ${pc.blue(parent)}`,
    );
  }
  const baseBranch = ordered[0]!;
  const basePr = stack.branches[baseBranch]?.pr;
  console.log(
    `    ${pc.blue(baseBranch)}${basePr ? ` (#${basePr})` : ""} → ${pc.green("main")} (auto-merge)`,
  );
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

  const confirmed = await confirmAction("Squash-merge stack top-down via GitHub?");
  if (!confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Take snapshot
  await takeSnapshot(meta, stackName, "merge");

  // Merge top-down via GitHub: for each PR from top, squash-merge into parent
  for (let i = 0; i < reversed.length - 1; i++) {
    const childBranch = reversed[i]!;
    const childPrNum = stack.branches[childBranch]!.pr!;
    const parentBranch = stack.branches[childBranch]!.parent;

    if (parentBranch === "main" || parentBranch === "master") continue;

    console.log();
    console.log(pc.cyan("━".repeat(40)));
    console.log(
      `${pc.blue("Merge:")} PR #${childPrNum} ${pc.yellow(childBranch)} → ${pc.blue(parentBranch)}`,
    );
    console.log(pc.cyan("━".repeat(40)));

    const s = p.spinner();
    s.start(`Squash-merging PR #${childPrNum} via GitHub...`);

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
      p.log.info("Resolve the issue on GitHub, then re-run merge to continue.");
      process.exit(2);
    }
  }

  // Base PR → enable auto-merge into main
  console.log();
  console.log(pc.cyan("━".repeat(40)));
  console.log(
    `${pc.blue("Auto-merge:")} PR #${basePr} ${pc.yellow(baseBranch)} → ${pc.green("main")}`,
  );
  console.log(pc.cyan("━".repeat(40)));

  const autoSpinner = p.spinner();
  autoSpinner.start(`Enabling auto-merge for PR #${basePr}...`);

  try {
    const ghArgs = ["pr", "merge", String(basePr), "--squash", "--auto"];
    if (deleteFlag) ghArgs.push("--delete-branch");
    await $`gh pr merge ${basePr} --squash --auto ${deleteFlag ? "--delete-branch" : ""}`.quiet();
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
    // Checkout main and pull so local is up to date
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
