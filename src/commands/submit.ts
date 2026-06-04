// gh-stack submit — Push branches and create/update PRs
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { $ } from "bun";
import * as git from "../lib/git.ts";
import {
  findStackForBranch,
  getOrderedBranches,
  readMetadata,
  writeMetadata,
} from "../lib/metadata.ts";
import { isAutoYes } from "../lib/ui.ts";
import type { StackMetadata } from "../types.ts";
import { getPrNumber } from "../lib/github.ts";
import { resolveOrCreateStack } from "../lib/chain.ts";
import { reconcilePrTitles, refreshStackViz, branchToTitle } from "./update-prs.ts";

const HELP = `
gh-stack submit — Push branches and create/update PRs

USAGE
  gh-stack submit [options]

Pushes all branches from trunk to the current branch, creating PRs
for branches that don't have them and updating stack visualization
in all PR descriptions. Idempotent — safe to run repeatedly.

Self-healing: if the current branch isn't tracked in a stack yet,
submit auto-detects the branch chain from trunk → current, registers
(or reconciles into) a stack, then pushes + creates PRs for the whole
chain. You never need to run \`gh-stack init\` first.

OPTIONS
  -d, --draft          Create new PRs as drafts
  -n, --no-edit        Don't prompt for PR titles (auto-generate from branch name)
  -t, --title <title>  PR title for new PRs (skips prompt)
  -b, --body <body>    PR body/description for new PRs
      --body-file <f>  Read PR body from a file
      --dry-run        Show what would happen without doing anything

EXAMPLES
  gh-stack submit                              # Push + create PRs interactively
  gh-stack submit -n                           # Push + create PRs with auto-titles
  gh-stack submit -t "My PR" -b "Description"  # Explicit title and body
  gh-stack submit --draft                      # Create new PRs as drafts
  gh-stack submit --dry-run                    # Preview what would happen
`;

/**
 * Generate a PR title from a branch name.
 * Strips common prefixes like "kiliman/", replaces hyphens with spaces,
 * and capitalizes the first letter.
 */
/**
 * Check if a local branch is up-to-date with its remote counterpart.
 */
async function isBranchUpToDate(branch: string): Promise<boolean> {
  try {
    const localSha = (await $`git rev-parse ${branch}`.text()).trim();
    const remoteSha = (await $`git rev-parse origin/${branch}`.text()).trim();
    return localSha === remoteSha;
  } catch {
    // Remote branch doesn't exist yet
    return false;
  }
}

/**
 * Push a branch to origin with upstream tracking and force-with-lease.
 */
async function pushBranch(branch: string): Promise<boolean> {
  try {
    await $`git push -u --force-with-lease origin ${branch}`.quiet();
    return true;
  } catch {
    return false;
  }
}

export default async function submit(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }

  const draftFlag = args.includes("--draft") || args.includes("-d");
  const dryRun = args.includes("--dry-run");

  // Parse value flags
  let titleFlag: string | undefined;
  let bodyFlag: string | undefined;
  let bodyFileFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--title" || args[i] === "-t") && args[i + 1]) {
      titleFlag = args[++i];
    } else if ((args[i] === "--body" || args[i] === "-b") && args[i + 1]) {
      bodyFlag = args[++i];
    } else if (args[i] === "--body-file" && args[i + 1]) {
      bodyFileFlag = args[++i];
    }
  }

  // Resolve body from file if provided
  if (bodyFileFlag && !bodyFlag) {
    try {
      bodyFlag = await Bun.file(bodyFileFlag).text();
    } catch {
      p.cancel(`Could not read body file: ${bodyFileFlag}`);
      process.exit(1);
    }
  }

  const noEdit = args.includes("--no-edit") || args.includes("-n") || isAutoYes() || !!titleFlag;

  // Read metadata, or start with an empty in-memory store. submit self-heals,
  // so a missing metadata file is fine — we'll build the stack from local
  // branch ancestry and persist it (unless --dry-run).
  const meta: StackMetadata = (await readMetadata()) ?? {
    version: 2,
    current_stack: null,
    stacks: {},
  };
  const branch = await git.currentBranch();
  let stackName = findStackForBranch(meta, branch);

  // ── Self-heal: branch isn't in any stack ──
  // Reconstruct the stack from local branch ancestry so the end state is
  // always stack registered + branches pushed + PRs created — no need to
  // remember to run `gh-stack init` first.
  let heal: { base: string; chain: string[]; created: boolean; added: string[] } | null = null;
  if (!stackName) {
    const trunk = await git.trunkBranch();

    if (branch === trunk || branch === "main" || branch === "master") {
      p.cancel(
        `You're on ${pc.blue(branch)} — nothing to submit.\n\n  Checkout a feature branch first.`,
      );
      process.exit(1);
    }

    let resolution;
    try {
      resolution = await resolveOrCreateStack(meta, branch, trunk);
    } catch (err) {
      p.cancel((err as Error).message);
      process.exit(1);
    }

    stackName = resolution.stackName;
    heal = {
      base: resolution.base,
      chain: resolution.chain,
      created: resolution.created,
      added: resolution.addedBranches,
    };

    // Persist the reconstructed/updated stack before pushing (skip on dry-run)
    if (!dryRun) await writeMetadata(meta);
  }

  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);

  // Determine downstack scope: branches from trunk up to and including current
  const currentIndex = ordered.indexOf(branch);
  const scope = currentIndex >= 0 ? ordered.slice(0, currentIndex + 1) : ordered;

  p.intro(pc.cyan("Submit Stack"));

  // Report self-heal results (stack creation / reconciliation + detected chain)
  if (heal) {
    if (heal.created) {
      p.log.success(
        `No stack found — created ${pc.yellow(stackName)} from ${heal.chain.length} local branch(es)`,
      );
    } else if (heal.added.length > 0) {
      const baseNote =
        heal.base === "main" || heal.base === "master" ? "" : ` (base: ${heal.base})`;
      p.log.success(
        `Adopted ${heal.added.length} untracked branch(es) into ${pc.yellow(stackName)}${pc.dim(baseNote)}`,
      );
    }

    console.log();
    console.log(`  ${pc.dim(heal.base)}`);
    for (let i = 0; i < heal.chain.length; i++) {
      const b = heal.chain[i]!;
      const isLast = i === heal.chain.length - 1;
      const tree = isLast ? "  ┗━" : "  ┣━";
      const isNew = heal.added.includes(b);
      const label = b === branch ? pc.yellow(b) + pc.dim(" (current)") : b;
      const tag = isNew ? pc.green(" +") : "";
      console.log(`${tree} ${label}${tag}`);
      if (!isLast) console.log("  ┃");
    }
    console.log();
  }

  p.log.info(`Stack: ${pc.yellow(stackName)}`);
  p.log.info(
    `Scope: ${scope.length} of ${ordered.length} branch(es) (downstack from ${pc.blue(branch)})`,
  );
  console.log();

  if (dryRun) {
    p.log.info(pc.dim("Dry run — no changes will be made"));
    console.log();
  }

  // ── Phase 1: Push branches and create/update PRs ──
  let pushed = 0;
  let created = 0;
  let existing = 0;
  let metadataChanged = false;

  for (const branchName of scope) {
    const branchMeta = stack.branches[branchName]!;
    const parentBranch = branchMeta.parent;

    // ── Push (skip if already up-to-date) ──
    if (dryRun) {
      p.log.step(`${pc.dim("push")} ${branchName} → origin/${branchName}`);
    } else if (await isBranchUpToDate(branchName)) {
      p.log.info(`${pc.dim("✓")} ${pc.blue(branchName)} already up to date`);
    } else {
      const s = p.spinner();
      s.start(`Pushing ${pc.blue(branchName)}...`);
      const ok = await pushBranch(branchName);
      if (ok) {
        s.stop(`Pushed ${pc.blue(branchName)}`);
        pushed++;
      } else {
        s.stop(pc.red(`Failed to push ${branchName}`));
        p.cancel(`Push failed for ${pc.blue(branchName)}. Aborting.`);
        process.exit(1);
      }
    }

    // ── Check for existing PR ──
    let prNumber = branchMeta.pr ?? null;

    if (!prNumber && !dryRun) {
      prNumber = await getPrNumber(branchName);
      if (prNumber) {
        // Found an existing PR not tracked in metadata — save it
        branchMeta.pr = prNumber;
        metadataChanged = true;
      }
    }

    if (prNumber) {
      // ── Existing PR: update base only if the parent actually changed ──
      existing++;
      if (dryRun) {
        p.log.step(`${pc.dim("exists")} PR #${prNumber} for ${branchName}`);
      } else {
        // Skip the network round-trip when the base we last set still matches
        // the current parent — the common case on a re-submit (issue #16).
        if (branchMeta.prBase !== parentBranch) {
          try {
            await $`gh pr edit ${prNumber} --base ${parentBranch}`.quiet();
            branchMeta.prBase = parentBranch;
            metadataChanged = true;
          } catch {
            // Best effort — base might already be correct
          }
        }
        p.log.info(`${pc.dim("✓")} PR #${prNumber} for ${pc.blue(branchName)}`);
      }
    } else {
      // ── Create new PR ──
      const defaultTitle = titleFlag || branchToTitle(branchName);
      let title = defaultTitle;

      if (!noEdit && !dryRun) {
        const input = await p.text({
          message: `PR title for ${pc.blue(branchName)}`,
          initialValue: defaultTitle,
          placeholder: defaultTitle,
        });
        if (p.isCancel(input)) {
          p.cancel("Cancelled");
          process.exit(0);
        }
        title = (input as string).trim() || defaultTitle;
      }

      const body = bodyFlag ?? "";

      if (dryRun) {
        p.log.step(
          `${pc.dim("create")} PR for ${branchName} → ${parentBranch} "${title}"${draftFlag ? " (draft)" : ""}`,
        );
        created++;
      } else {
        const s = p.spinner();
        s.start(`Creating PR for ${pc.blue(branchName)}...`);

        const ghArgs = [
          "pr",
          "create",
          "--base",
          parentBranch,
          "--head",
          branchName,
          "--title",
          title,
          "--body",
          body,
        ];
        if (draftFlag) ghArgs.push("--draft");

        const proc = Bun.spawn(["gh", ...ghArgs], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;

        if (exitCode === 0) {
          // Extract PR number from URL output
          const prUrl = output.trim();
          const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
          const newPrNumber = prNumMatch ? parseInt(prNumMatch[1]!, 10) : null;

          if (newPrNumber) {
            branchMeta.pr = newPrNumber;
            branchMeta.prTitle = title;
            branchMeta.prBase = parentBranch;
            metadataChanged = true;
            s.stop(`Created PR #${newPrNumber} for ${pc.blue(branchName)}`);
          } else {
            s.stop(`Created PR for ${pc.blue(branchName)} (could not parse PR number)`);
          }
          created++;
        } else {
          const stderr = await new Response(proc.stderr).text();
          s.stop(pc.red(`Failed to create PR for ${branchName}`));
          p.log.error(stderr.trim());
        }
      }
    }
  }

  console.log();

  if (dryRun) {
    p.outro(
      pc.dim(
        `Dry run complete: would push ${scope.length}, create ${created}, update ${existing} PR(s)`,
      ),
    );
    return;
  }

  // ── Phase 2: Reconcile PR titles (stack position) then refresh the stack
  // visualization. Titles first so the viz renders the numbered titles. Both
  // render locally and only hit the network for PRs that actually changed
  // (see issue #16), so a no-op re-submit is free. ──
  p.log.info(pc.cyan("Updating PR titles & stack visualization..."));
  const titles = await reconcilePrTitles(stack, ordered);
  const viz = await refreshStackViz(meta, stack, ordered);

  // One persist for everything we cached this run (discovered PRs, base edits,
  // backfilled/renumbered titles, viz hashes).
  if (metadataChanged || titles.dirty || viz.dirty) {
    await writeMetadata(meta);
  }

  // ── Summary ──
  console.log();
  p.outro(
    pc.green(
      `Done! Pushed ${pushed} branch(es), created ${created} PR(s), updated ${viz.updated} description(s), ${titles.updated} title(s)` +
        (viz.unchanged > 0 ? `, ${viz.unchanged} unchanged` : ""),
    ),
  );
}
