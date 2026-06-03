// gh-stack rename — Rename a tracked branch and keep metadata in sync.
//
// The common flow: build on a throwaway branch (`kiliman/feature-wip`), then
// rename it to a ticketed convention (`kiliman/feature-BEE-1234`) before
// submitting. `git branch -m` moves the branch's rename-proof config section,
// and gh-stack reconciles the name-keyed topology files on the next read — this
// command is just the discoverable front door that does both and persists
// immediately. (Renaming with raw `git branch -m` still self-heals; see
// `reconcileRenames` in lib/metadata.ts.)
import pc from "picocolors";
import * as p from "../lib/output.ts";
import * as git from "../lib/git.ts";
import { findStackForBranch, readMetadata, writeMetadata } from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";
import { confirmAction } from "../lib/ui.ts";

const HELP = `
gh-stack rename — Rename a tracked branch and update metadata

USAGE
  gh-stack rename <new-name>           Rename the current branch
  gh-stack rename <old-name> <new-name>

Renames the local git branch (\`git branch -m\`) and re-keys the stack
topology so the branch stays tracked — re-parenting any children that
pointed at the old name. Use this for the throwaway-branch → ticketed-PR
flow without hand-editing metadata.

Renaming a branch that already has a PR only renames it locally; the
GitHub PR still tracks the old remote branch.
`;

export default async function rename(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }

  const positionals = args.filter((a) => !a.startsWith("-"));
  if (positionals.length === 0 || positionals.length > 2) {
    p.cancel("Usage: gh-stack rename [<old-name>] <new-name>");
    process.exit(1);
  }

  const meta = await ensureMetadata();
  const current = await git.currentBranch();

  const oldName = positionals.length === 2 ? positionals[0]! : current;
  const newName = positionals.length === 2 ? positionals[1]! : positionals[0]!;

  // ── Validate ──
  if (oldName === newName) {
    p.cancel("Old and new names are identical — nothing to do.");
    process.exit(1);
  }
  if (newName === "main" || newName === "master") {
    p.cancel(`Refusing to rename a branch to ${pc.red(newName)}.`);
    process.exit(1);
  }
  if (!(await git.localBranchExists(oldName))) {
    p.cancel(`Branch ${pc.yellow(oldName)} does not exist locally.`);
    process.exit(1);
  }
  if (await git.localBranchExists(newName)) {
    p.cancel(`A branch named ${pc.yellow(newName)} already exists.`);
    process.exit(1);
  }

  const stackName = findStackForBranch(meta, oldName);
  if (!stackName) {
    p.cancel(
      `Branch ${pc.yellow(oldName)} isn't tracked in a stack.\n\n  Rename it with plain git instead:\n    ${pc.green(`git branch -m ${oldName} ${newName}`)}`,
    );
    process.exit(1);
  }

  const hadPr = meta.stacks[stackName]?.branches[oldName]?.pr;

  // ── Confirm ──
  const ok = await confirmAction(
    `Rename ${pc.yellow(oldName)} → ${pc.green(newName)} (stack: ${stackName})?`,
  );
  if (!ok) {
    p.cancel("Rename cancelled.");
    return;
  }

  // ── Rename + persist ──
  if (!(await git.renameBranch(oldName, newName))) {
    p.cancel(`git failed to rename ${pc.yellow(oldName)} → ${pc.yellow(newName)}.`);
    process.exit(1);
  }

  // Re-read so reconcileRenames re-keys the topology from the (moved) config,
  // then write it back to persist the new name + repoint child config.
  const updated = await readMetadata();
  if (!updated) {
    p.cancel("Renamed the branch, but failed to re-read metadata.");
    process.exit(1);
  }
  await writeMetadata(updated);

  p.log.success(`Renamed ${pc.yellow(oldName)} → ${pc.green(newName)}`);

  if (hadPr) {
    p.log.warn(
      `PR ${pc.cyan(`#${hadPr}`)} still tracks the old remote branch ${pc.dim(oldName)}.\n` +
        `  This rename was local only — update the PR's branch on GitHub if needed.`,
    );
  }
}
