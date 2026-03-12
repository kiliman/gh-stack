// git-stack archive — Manage archived stacks
import * as p from "@clack/prompts";
import pc from "picocolors";
import { writeMetadata, getOrderedBranches } from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";

export default async function archive(args: string[]): Promise<void> {
  const listMode = args.includes("--list") || args.length === 0;
  const restoreIdx = args.indexOf("--restore");
  const restoreName = restoreIdx !== -1 ? args[restoreIdx + 1] : undefined;

  if (args.includes("--help")) {
    console.log(`
git-stack archive — Manage archived stacks

USAGE
  git-stack archive [--list]            List archived stacks
  git-stack archive --restore <name>    Restore an archived stack
`);
    return;
  }

  const meta = await ensureMetadata();

  if (restoreName) {
    // Restore an archived stack
    if (!meta.archive || !meta.archive[restoreName]) {
      p.cancel(`Archived stack "${restoreName}" not found`);
      process.exit(1);
    }

    meta.stacks[restoreName] = meta.archive[restoreName]!;
    delete meta.archive[restoreName];
    meta.current_stack = restoreName;
    await writeMetadata(meta);

    p.log.success(
      `Restored stack ${pc.yellow(restoreName)} from archive`
    );
    return;
  }

  // List archived stacks
  p.intro(pc.cyan("Archived Stacks"));

  if (!meta.archive || Object.keys(meta.archive).length === 0) {
    p.log.info("No archived stacks");
    return;
  }

  for (const [name, stack] of Object.entries(meta.archive)) {
    const branchCount = Object.keys(stack.branches).length;
    console.log(
      `  ${pc.blue("○")} ${pc.yellow(name)} (${branchCount} branch${branchCount !== 1 ? "es" : ""})`
    );
    if (stack.description) {
      console.log(`    ${pc.dim(stack.description)}`);
    }
    console.log();
  }

  console.log(
    pc.dim(
      `  Restore with: git-stack archive --restore <name>`
    )
  );
}
