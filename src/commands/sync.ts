// git-stack sync — Fetch main, rebase base branch onto main, then restack all
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  findStackForBranch,
  getOrderedBranches,
  buildRebaseChain,
  saveRestackState,
} from "../lib/metadata.ts";
import {
  ensureMetadata,
  ensureCleanWorkingTree,
} from "../lib/safety.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { confirmAction } from "../lib/ui.ts";

export default async function sync(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");

  if (args.includes("--help")) {
    console.log(`
git-stack sync — Sync base with main + restack all

USAGE
  git-stack sync [--dry-run]

Fetches latest main, rebases the base branch onto main,
then restacks all children. Equivalent to running restack
with the base branch included.
`);
    return;
  }

  await ensureCleanWorkingTree();

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(
      `Branch ${pc.blue(currentBranch)} not found in any stack`
    );
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);

  if (ordered.length === 0) {
    p.cancel("No branches in this stack");
    process.exit(1);
  }

  p.intro(pc.cyan("Git Stack Sync"));

  // Find the base branch (first branch, parent = main)
  const baseBranch = ordered[0]!;
  const baseParent = stack.branches[baseBranch]?.parent;

  if (baseParent !== "main") {
    p.cancel(
      `Base branch ${pc.yellow(baseBranch)} doesn't have main as parent`
    );
    process.exit(1);
  }

  // Fetch main
  const fetchSpinner = p.spinner();
  fetchSpinner.start("Fetching latest main...");
  await git.fetchMain();
  fetchSpinner.stop("Fetched latest main");

  // Take snapshot
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
    p.log.warn(
      `[DRY RUN] Would rebase ${baseBranch} onto origin/main`
    );
  } else {
    const confirmed = await confirmAction(
      `Rebase ${pc.yellow(baseBranch)} onto origin/main?`
    );
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
      console.log(`  ${pc.green("git-stack restack --resume")}`);
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
  p.log.info(
    `${pc.yellow("⚠")} ${branch} is out of sync with remote`
  );

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
