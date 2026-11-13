// gh-stack archive — Archive stacks, list them, restore them
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { archiveStack, findStackForBranch, writeMetadata } from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";
import type { StackMetadata } from "../types.ts";

const HELP = `
gh-stack archive — Archive, list, and restore stacks

USAGE
  gh-stack archive <name>...           Archive one or more stacks
  gh-stack archive [--list]            List archived stacks
  gh-stack archive --restore <name>    Restore an archived stack

Archiving moves a stack out of ${"`"}stacks${"`"} into the archive. It's metadata only:
no branch, commit, or PR changes, and ${"`"}--restore${"`"} brings it back. Use it for a
stack that landed without ${"`"}gh-stack merge${"`"} (PRs merged on GitHub, or landed
from another worktree), or one left empty by ${"`"}delete --keep-branch${"`"}.

${"`"}merge${"`"} archives a stack it lands, ${"`"}delete${"`"} archives a stack it leaves empty,
and ${"`"}doctor${"`"} archives any empty stacks it finds.
`;

export default async function archive(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }

  const restoreIdx = args.indexOf("--restore");
  const meta = await ensureMetadata();

  if (restoreIdx !== -1) {
    const name = args[restoreIdx + 1];
    if (!name || name.startsWith("-")) {
      p.cancel("Usage: gh-stack archive --restore <name>");
      process.exit(1);
    }
    await restore(meta, name);
    return;
  }

  const names = args.filter((a) => !a.startsWith("-"));
  if (names.length > 0) {
    await archiveNamed(meta, names);
    return;
  }

  list(meta);
}

async function archiveNamed(meta: StackMetadata, names: string[]): Promise<void> {
  const missing = names.filter((n) => !meta.stacks[n]);
  if (missing.length > 0) {
    const archived = missing.filter((n) => meta.archive?.[n]);
    p.cancel(
      `No active stack named ${missing.map((n) => pc.yellow(n)).join(", ")}` +
        (archived.length > 0 ? ` (${archived.join(", ")} already archived)` : "") +
        `.\n\n  List them with: ${pc.green("gh-stack stacks")}`,
    );
    process.exit(1);
  }

  const done = names.map((n) => ({ from: n, to: archiveStack(meta, n) }));
  await writeMetadata(meta);

  for (const { from, to } of done) {
    p.log.success(
      `Archived ${pc.yellow(from)}` +
        (to !== from ? ` as ${pc.yellow(to)}` : "") +
        pc.dim(`  (restore: gh-stack archive --restore ${to})`),
    );
  }
}

async function restore(meta: StackMetadata, name: string): Promise<void> {
  const stack = meta.archive?.[name];
  if (!stack) {
    p.cancel(`Archived stack "${name}" not found`);
    process.exit(1);
  }
  if (meta.stacks[name]) {
    p.cancel(
      `An active stack is already named ${pc.yellow(name)}. Archive or rename it first, then restore.`,
    );
    process.exit(1);
  }
  // A branch can belong to one stack only.
  const clashes = Object.keys(stack.branches)
    .map((b) => ({ branch: b, owner: findStackForBranch(meta, b) }))
    .filter((c) => c.owner);
  if (clashes.length > 0) {
    p.cancel(
      `Can't restore ${pc.yellow(name)}: these branches are tracked in another stack now:\n` +
        clashes.map((c) => `    ${c.branch} (in ${c.owner})`).join("\n"),
    );
    process.exit(1);
  }

  meta.stacks[name] = stack;
  delete meta.archive![name];
  meta.current_stack = name;
  await writeMetadata(meta);

  p.log.success(`Restored stack ${pc.yellow(name)} from archive`);
}

function list(meta: StackMetadata): void {
  p.intro(pc.cyan("Archived Stacks"));

  if (!meta.archive || Object.keys(meta.archive).length === 0) {
    p.log.info("No archived stacks");
    return;
  }

  for (const [name, stack] of Object.entries(meta.archive)) {
    const branchCount = Object.keys(stack.branches).length;
    console.log(
      `  ${pc.blue("○")} ${pc.yellow(name)} (${branchCount} branch${branchCount !== 1 ? "es" : ""})`,
    );
    if (stack.description) {
      console.log(`    ${pc.dim(stack.description)}`);
    }
    console.log();
  }

  console.log(pc.dim(`  Restore with: gh-stack archive --restore <name>`));
}
