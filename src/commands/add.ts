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
import { resolveOrCreateStack } from "../lib/chain.ts";
import type { StackMetadata } from "../types.ts";

export default async function add(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack add — track an existing local branch in a stack (no push, no PR)

USAGE
  gh-stack add [branch]

Registers the branch (default: the current branch) into a stack so sync,
restack, and navigation work before you've submitted it. Walks local ancestry:
if the branch sits on top of an existing stack it's adopted into that stack;
otherwise a new stack is created from the chain, rooted at the trunk.

Network-free — nothing is pushed and no PR is opened. Run ${"`"}gh-stack submit${"`"} when
you're ready to publish.

EXAMPLES
  gh-stack add                    Track the current branch
  gh-stack add my-wip-branch      Track a specific local branch
`);
    return;
  }

  await gateLegacyMetadata();

  const positional = args.find((a) => !a.startsWith("-"));
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

  const already = findStackForBranch(meta, branch);
  if (already) {
    p.log.info(`${pc.yellow(branch)} is already tracked in stack ${pc.yellow(already)}.`);
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

  p.outro(
    `Tracked — ${pc.green("gh-stack sync")}/${pc.green("restack")} now work. ${pc.dim("Run")} ${pc.green("gh-stack submit")} ${pc.dim("to open PRs.")}`,
  );
}
