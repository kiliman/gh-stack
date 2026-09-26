// gh-stack add — register an existing local branch into a stack (no push, no PR).
//
// Fills the gap between `git checkout -b <wip>` and `submit`: it tracks the
// branch (and any untracked ancestors) in the right stack by walking local
// ancestry, so `sync` / `restack` / navigation work BEFORE you're ready to open
// a PR. Network-free — nothing is pushed and no PR is created. That's the whole
// point: `submit` is the command that publishes; `add` only updates metadata.
//
// Resolves the "catch-22" where a local WIP tip couldn't be synced because it
// wasn't in a stack, and the only way into a stack was `submit` (which pushes).
import * as p from "../lib/output.ts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { gateLegacyMetadata } from "../lib/safety.ts";
import { readMetadata, writeMetadata, findStackForBranch, stackBase } from "../lib/metadata.ts";
import { colocatedBranches, resolveOrCreateStack } from "../lib/chain.ts";
import type { StackMetadata } from "../types.ts";

export default async function add(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack add — track an existing local branch in a stack (no push, no PR)

USAGE
  gh-stack add [branch] [--parent <branch>]

Registers the branch (default: the current branch) into a stack so sync,
restack, and navigation work before you've submitted it. Walks local ancestry:
if the branch sits on top of an existing stack it's adopted into that stack;
otherwise a new stack is created from the chain, rooted at the trunk.

OPTIONS
  --parent <branch>  Stack the branch directly on <branch> instead of detecting
                     it (which must already be based on it). Needed when the
                     branch has no commits of its own yet, since it then sits AT
                     its parent's tip and ancestry can't tell them apart.
                     Also re-homes an already-tracked branch, when it's alone in
                     its stack and has no PR (e.g. a mistaken ${"`"}init${"`"} at trunk).

Network-free — nothing is pushed and no PR is opened. Run ${"`"}gh-stack submit${"`"} when
you're ready to publish.

EXAMPLES
  gh-stack add                    Track the current branch
  gh-stack add my-wip-branch      Track a specific local branch
  gh-stack add --parent feat-1    Track the current branch on top of feat-1
`);
    return;
  }

  await gateLegacyMetadata();

  let parentFlag: string | undefined;
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--parent" && args[i + 1]) parentFlag = args[++i];
    else if (!args[i]!.startsWith("-")) positional ??= args[i];
  }
  const branch = positional ?? (await git.currentBranch());

  if (!(await git.localBranchExists(branch))) {
    p.cancel(`Branch ${pc.yellow(branch)} doesn't exist locally.`);
    process.exit(1);
  }

  const trunk = await git.trunkBranch();
  if (branch === trunk || branch === "main" || branch === "master") {
    p.cancel(
      `${pc.yellow(branch)} is the trunk — nothing to add.\n\n  Checkout a feature branch first.`,
    );
    process.exit(1);
  }

  // submit self-heals from an empty store, so a missing metadata file is fine —
  // resolveOrCreateStack will create the first stack from local ancestry.
  const meta: StackMetadata = (await readMetadata()) ?? {
    version: 2,
    current_stack: null,
    stacks: {},
  };

  if (parentFlag) {
    await addUnderParent(meta, branch, parentFlag, trunk);
    return;
  }

  const already = findStackForBranch(meta, branch);
  if (already) {
    p.log.info(`${pc.yellow(branch)} is already tracked in stack ${pc.yellow(already)}.`);
    await warnIfColocated(branch, trunk);
    return;
  }

  let resolution;
  try {
    resolution = await resolveOrCreateStack(meta, branch, trunk);
  } catch (err) {
    p.cancel((err as Error).message);
    process.exit(1);
  }

  meta.current_stack = resolution.stackName;
  await writeMetadata(meta);

  p.intro(pc.cyan("Add to Stack"));

  const stack = meta.stacks[resolution.stackName]!;
  const base = stackBase(stack);
  const baseNote = base === "main" || base === "master" ? "" : ` ${pc.dim(`(base: ${base})`)}`;

  if (resolution.created) {
    p.log.success(
      `Created stack ${pc.yellow(resolution.stackName)} from ${resolution.addedBranches.length} local branch(es)${baseNote}`,
    );
  } else {
    p.log.success(
      `Added ${resolution.addedBranches.length} branch(es) to ${pc.yellow(resolution.stackName)}${baseNote}`,
    );
  }
  for (const b of resolution.addedBranches) {
    console.log(`  ${pc.green("+")} ${b}`);
  }
  if (resolution.created && resolution.chain.length === 1) await warnIfColocated(branch, trunk);

  p.outro(
    `Tracked — ${pc.green("gh-stack sync")}/${pc.green("restack")} now work. ${pc.dim("Run")} ${pc.green("gh-stack submit")} ${pc.dim("to open PRs.")}`,
  );
}

/**
 * A branch with no commits of its own sits AT its parent's tip, so ancestry
 * can't find the parent and it gets rooted at trunk. Say so, and how to fix it,
 * rather than leaving a stack that `sync` would later rebase onto trunk —
 * replaying the parent's commits. (#37)
 */
export async function warnIfColocated(branch: string, trunk: string): Promise<void> {
  const same = await colocatedBranches(branch, trunk);
  if (same.length === 0) return;
  p.log.warn(
    `${pc.yellow(branch)} has no commits of its own — it shares its tip with ${same.map((b) => pc.yellow(b)).join(", ")}, so it was rooted at ${trunk}.\n` +
      `  If it belongs on one of those, re-home it:\n` +
      same.map((b) => `    ${pc.green(`gh-stack add ${branch} --parent ${b}`)}`).join("\n"),
  );
}

/**
 * `add --parent`: stack `branch` directly on `parent`, tracking `parent` first
 * (from its own ancestry) if needed. An already-tracked branch is re-homed only
 * when that can't lose anything: it's alone in its stack and has no PR — the
 * shape a mistaken `init` at trunk leaves behind. Metadata-only; the branch
 * must already be based on `parent`. (#37)
 */
async function addUnderParent(
  meta: StackMetadata,
  branch: string,
  parent: string,
  trunk: string,
): Promise<void> {
  if (parent === branch) {
    p.cancel(`A branch can't be its own parent.`);
    process.exit(1);
  }
  if (parent === trunk || parent === "main" || parent === "master") {
    p.cancel(
      `--parent is for stacking on a feature branch. To root ${pc.yellow(branch)} at ${trunk}, run ${pc.green("gh-stack add")} without --parent.`,
    );
    process.exit(1);
  }
  if (!(await git.localBranchExists(parent))) {
    p.cancel(`Branch ${pc.yellow(parent)} doesn't exist locally.`);
    process.exit(1);
  }
  if (!(await git.isAncestor(parent, branch))) {
    p.cancel(
      `${pc.yellow(branch)} isn't based on ${pc.yellow(parent)} — rebase it first:\n\n    ${pc.green(`git rebase ${parent} ${branch}`)}`,
    );
    process.exit(1);
  }

  const oldStackName = findStackForBranch(meta, branch);
  const oldBranch = oldStackName ? meta.stacks[oldStackName]!.branches[branch]! : null;

  if (oldStackName && oldBranch) {
    if (oldBranch.parent === parent) {
      p.log.info(`${pc.yellow(branch)} is already stacked on ${pc.yellow(parent)}.`);
      return;
    }
    const oldStack = meta.stacks[oldStackName]!;
    const alone = Object.keys(oldStack.branches).length === 1;
    if (!alone || oldBranch.pr != null) {
      p.cancel(
        `${pc.yellow(branch)} is already tracked in stack ${pc.yellow(oldStackName)}` +
          (oldBranch.pr != null ? ` with PR #${oldBranch.pr}` : " alongside other branches") +
          ` — re-homing it could strand them, so add --parent won't move it.`,
      );
      process.exit(1);
    }
  }

  // Track the parent first, from its own ancestry, if it isn't yet. Resolved
  // before dropping the branch's old stack so a failure leaves nothing changed.
  let targetStackName = findStackForBranch(meta, parent);
  const adoptedParents: string[] = [];
  if (!targetStackName) {
    try {
      const res = await resolveOrCreateStack(meta, parent, trunk);
      targetStackName = res.stackName;
      adoptedParents.push(...res.addedBranches);
    } catch (err) {
      p.cancel((err as Error).message);
      process.exit(1);
    }
  }

  // Drop the throwaway one-branch stack. Deleted, not archived: restoring it
  // would track the branch in two stacks at once.
  if (oldStackName && oldStackName !== targetStackName) delete meta.stacks[oldStackName];

  const target = meta.stacks[targetStackName]!;
  target.branches[branch] = { ...oldBranch, parent };
  target.last_branch = branch;
  meta.current_stack = targetStackName;
  await writeMetadata(meta);

  p.intro(pc.cyan("Add to Stack"));
  for (const b of adoptedParents) console.log(`  ${pc.green("+")} ${b}`);
  p.log.success(
    oldStackName
      ? `Re-homed ${pc.yellow(branch)} onto ${pc.yellow(parent)} in stack ${pc.yellow(targetStackName)} ${pc.dim(`(removed one-branch stack ${oldStackName})`)}`
      : `Added ${pc.yellow(branch)} onto ${pc.yellow(parent)} in stack ${pc.yellow(targetStackName)}`,
  );
  p.outro(
    `Tracked — ${pc.green("gh-stack sync")}/${pc.green("restack")} now work. ${pc.dim("Run")} ${pc.green("gh-stack submit")} ${pc.dim("to open PRs.")}`,
  );
}
