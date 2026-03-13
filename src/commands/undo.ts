// gh-stack undo — Restore from last snapshot
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { ensureMetadata, ensureCleanWorkingTree } from "../lib/safety.ts";
import { getLastSnapshot, popSnapshot } from "../lib/snapshot.ts";
import { confirmAction } from "../lib/ui.ts";
import { $ } from "bun";

export default async function undo(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack undo — Restore from last snapshot

USAGE
  gh-stack undo

Restores branch HEADs from the last snapshot taken before
a destructive operation (restack, merge, sync, remove).
`);
    return;
  }

  await ensureCleanWorkingTree();

  const meta = await ensureMetadata();

  const snapshot = getLastSnapshot(meta);
  if (!snapshot) {
    p.cancel("No snapshots available to undo");
    process.exit(1);
  }

  p.intro(pc.cyan("Undo Last Operation"));

  p.log.info(`Operation: ${pc.yellow(snapshot.operation)}`);
  p.log.info(`Timestamp: ${pc.dim(snapshot.timestamp)}`);
  console.log();
  p.log.info("Will restore:");
  for (const [branch, sha] of Object.entries(snapshot.branches)) {
    console.log(`  ${branch} → ${pc.dim(sha.slice(0, 8))}`);
  }
  console.log();

  const confirmed = await confirmAction("Restore these branch positions?");
  if (!confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Restore each branch HEAD
  for (const [branch, sha] of Object.entries(snapshot.branches)) {
    try {
      await $`git branch -f ${branch} ${sha}`.quiet();
      p.log.success(`Restored ${pc.yellow(branch)} → ${sha.slice(0, 8)}`);
    } catch {
      p.log.error(`Failed to restore ${branch}`);
    }
  }

  // Pop the snapshot
  await popSnapshot(meta);

  p.outro(pc.green("Undo complete!"));
}
