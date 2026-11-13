// gh-stack doctor — migrate v2 → v3, reconcile branch config ↔ topology,
// and flag stacks whose base stack appears to have merged.
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { rename, unlink } from "node:fs/promises";
import * as git from "../lib/git.ts";
import type { StackMetadata, Snapshot, Stack } from "../types.ts";
import {
  readMetadata,
  writeMetadata,
  v3Exists,
  legacyMetadataExists,
  stackBase,
  stackRoots,
  splitMultiRootStack,
  archiveStack,
  emptyStacks,
} from "../lib/metadata.ts";
import { validateStack } from "../lib/safety.ts";
import { legacyMetadataPath, legacyRestackStatePath, restackStateFile } from "../lib/paths.ts";
import { writeSnapshotFile } from "../lib/snapshot.ts";

const HELP = `
gh-stack doctor — Migrate & repair stack metadata

USAGE
  gh-stack doctor

Migrates old (v2) metadata to the v3 layout (per-stack files under
.git/.gh-stack/ + git branch config), splits any stack left with several
root branches into one stack per root, archives stacks with no branches
left, reconciles branch config against
the topology files (leaving branches another worktree is stacking
alone), flags stacks whose base stack looks already-merged into main,
and reports stacks that still fail the checks other commands run
before they load a stack.

Safe to run repeatedly — it's idempotent.
`;

export default async function doctor(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }

  p.intro(pc.cyan("gh-stack doctor"));

  // ── 1. Migrate v2 → v3 if needed ──
  const migrated = await migrateIfNeeded();

  if (!(await v3Exists())) {
    p.cancel(
      `No stack metadata found.\n\n  Create your first stack with:\n    ${pc.green("gh-stack init")}`,
    );
    process.exit(1);
  }

  const meta = await readMetadata();
  if (!meta) {
    p.cancel("Failed to read stack metadata after migration");
    process.exit(1);
  }

  // ── 2. Split stacks left with several roots (#60) ──
  splitMultiRootStacks(meta);

  // ── 2b. Archive stacks with no branches left (#68) ──
  archiveEmptyStacks(meta);

  // ── 3. Reconcile branch config ↔ topology (also writes the split and archive) ──
  await reconcile(meta);

  // ── 4. Flag base-stack-merged situations (issue #13) ──
  await flagMergedBaseStacks(meta);

  // ── 5. Run the checks every command runs before it loads a stack ──
  const invalid = await reportInvalidStacks(meta);

  if (invalid > 0) {
    p.outro(pc.yellow(`${invalid} stack(s) still need repair (see above).`));
  } else if (migrated) {
    p.outro(pc.green("Migration complete — metadata is now v3."));
  } else {
    p.outro(pc.green("Metadata looks healthy."));
  }
}

// ── Multi-root repair (#60) ──

/**
 * A stack whose root left with several children has several roots, which every
 * command refuses. Siblings on the same base are independent stacks, so give
 * each its own: lossless, and only metadata changes. The caller writes.
 */
function splitMultiRootStacks(meta: StackMetadata): void {
  for (const name of Object.keys(meta.stacks)) {
    const roots = stackRoots(meta.stacks[name]!);
    const split = splitMultiRootStack(meta, name);
    if (split.length === 0) continue;
    p.log.success(
      `Split ${pc.yellow(name)}, which had ${roots.length} root branches: ${pc.yellow(roots[0]!)} stays, ${split.map((s) => pc.yellow(s)).join(", ")} split off`,
    );
  }
}

/**
 * A stack whose branches were all removed (`delete --keep-branch` on each, the
 * way a sweep landed from another worktree is cleaned up) stays in `stacks` as
 * an empty shell. Archive it: reversible, and only metadata changes. The caller
 * writes.
 */
function archiveEmptyStacks(meta: StackMetadata): void {
  for (const name of emptyStacks(meta)) {
    const archivedAs = archiveStack(meta, name);
    p.log.success(
      `Archived empty stack ${pc.yellow(name)}` +
        pc.dim(`  (restore: gh-stack archive --restore ${archivedAs})`),
    );
  }
}

/** Report the stacks that still fail validation; returns how many. */
async function reportInvalidStacks(meta: StackMetadata): Promise<number> {
  let invalid = 0;
  for (const name of Object.keys(meta.stacks)) {
    const errors = await validateStack(meta, name);
    if (errors.length === 0) continue;
    invalid++;
    console.log();
    p.log.warn(`Stack ${pc.yellow(name)} is invalid:`);
    for (const error of errors) console.log(`  ${pc.red("•")} ${error}`);
  }
  return invalid;
}

// ── Migration ──

async function migrateIfNeeded(): Promise<boolean> {
  if (!(await legacyMetadataExists())) return false;

  const legacyPath = await legacyMetadataPath();

  // If a v3 store already exists alongside the legacy file, don't clobber it —
  // just retire the stale legacy file.
  if (await v3Exists()) {
    p.log.warn(
      `Both v3 metadata and a legacy file exist. Keeping v3 and backing up the legacy file.`,
    );
    await rename(legacyPath, `${legacyPath}.bak`).catch(() => {});
    return false;
  }

  const s = p.spinner();
  s.start("Migrating v2 metadata → v3...");

  const raw = (await Bun.file(legacyPath).json()) as Partial<StackMetadata>;
  const stacks: Record<string, Stack> = raw.stacks ?? {};
  const archive: Record<string, Stack> = raw.archive ?? {};
  const snapshots: Snapshot[] = raw.snapshots ?? [];

  // Backfill base for stacks written before the split feature.
  for (const stack of [...Object.values(stacks), ...Object.values(archive)]) {
    if (stack.base == null) stack.base = "main";
  }

  const meta: StackMetadata = {
    version: 3,
    current_stack: raw.current_stack ?? null,
    stacks,
  };
  if (Object.keys(archive).length > 0) meta.archive = archive;

  // Fan out topology + backfill branch config.
  await writeMetadata(meta);

  // Explode the snapshots[] array into per-file records, inferring each
  // snapshot's owning stack from its recorded branch set (v2 didn't store it).
  for (const snap of snapshots) {
    const owner = inferStack(snap, stacks, archive) ?? meta.current_stack ?? undefined;
    await writeSnapshotFile({ ...snap, stack: owner });
  }

  // Migrate the legacy restack-state file, if present.
  const legacyState = await legacyRestackStatePath();
  if (await Bun.file(legacyState).exists()) {
    const content = await Bun.file(legacyState).text();
    await Bun.write(await restackStateFile(), content);
    await unlink(legacyState).catch(() => {});
  }

  // Retire the legacy monolith (keep a .bak for safety).
  await rename(legacyPath, `${legacyPath}.bak`).catch(() => {});

  s.stop("Migrated to v3");

  const stackCount = Object.keys(stacks).length;
  const archiveCount = Object.keys(archive).length;
  p.log.info(
    `  ${pc.dim("→")} ${stackCount} active, ${archiveCount} archived, ${snapshots.length} snapshot(s)`,
  );
  p.log.info(`  ${pc.dim("→")} Backed up legacy file to ${pc.dim(`${legacyPath}.bak`)}`);
  return true;
}

/** Pick the stack whose branch set best overlaps a snapshot's branches. */
function inferStack(
  snap: Snapshot,
  stacks: Record<string, Stack>,
  archive: Record<string, Stack>,
): string | null {
  const recorded = new Set(Object.keys(snap.branches));
  let best: string | null = null;
  let bestOverlap = 0;
  for (const [name, stack] of Object.entries({ ...archive, ...stacks })) {
    let overlap = 0;
    for (const b of Object.keys(stack.branches)) if (recorded.has(b)) overlap++;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = name;
    }
  }
  return best;
}

// ── Reconciliation ──

async function reconcile(meta: StackMetadata): Promise<void> {
  // Report topology branches that no longer exist locally (can't auto-fix
  // safely — re-parenting children is a judgement call).
  const deadBranches: { stack: string; branch: string }[] = [];
  for (const [name, stack] of Object.entries(meta.stacks)) {
    for (const branch of Object.keys(stack.branches)) {
      if (!(await git.localBranchExists(branch))) {
        deadBranches.push({ stack: name, branch });
      }
    }
  }

  // Re-syncing config is what writeMetadata already does: set desired
  // membership, clear stale, leave other worktrees' branches alone.
  const { updated, cleared, foreign } = await writeMetadata(meta);

  if (updated.length > 0 || cleared.length > 0) {
    p.log.success(
      `Reconciled branch config: ${updated.length} updated, ${cleared.length} stale membership(s) cleared.`,
    );
  } else {
    p.log.info("Branch config already in sync with topology.");
  }
  if (foreign.length > 0) {
    p.log.info(
      `Left ${foreign.length} branch(es) alone that another worktree is stacking: ${foreign.join(", ")}`,
    );
  }

  if (deadBranches.length > 0) {
    console.log();
    p.log.warn(`${deadBranches.length} branch(es) in topology no longer exist locally:`);
    for (const { stack, branch } of deadBranches) {
      console.log(`  ${pc.red("•")} ${pc.yellow(branch)} ${pc.dim(`(stack: ${stack})`)}`);
    }
    console.log(
      `  ${pc.dim(`Prune with ${pc.green("gh-stack delete <branch>")} or restore the branch.`)}`,
    );
  }
}

// ── Base-stack-merged detection (issue #13) ──

async function flagMergedBaseStacks(meta: StackMetadata): Promise<void> {
  const trunk = await git.trunkBranch();
  const flagged: { stack: string; base: string; reason: string }[] = [];

  for (const [name, stack] of Object.entries(meta.stacks)) {
    const base = stackBase(stack);
    if (base === "main" || base === "master") continue; // trunk-rooted: not affected

    const baseExists = await git.localBranchExists(base);
    if (!baseExists) {
      flagged.push({
        stack: name,
        base,
        reason: `base branch ${pc.yellow(base)} is gone (parent stack likely merged)`,
      });
      continue;
    }

    // Base still exists — has it already landed in trunk?
    let baseInTrunk = false;
    for (const ref of [`origin/${trunk}`, trunk]) {
      try {
        if (await git.isAncestor(base, ref)) {
          baseInTrunk = true;
          break;
        }
      } catch {
        // ref not available locally — ignore
      }
    }
    if (baseInTrunk) {
      flagged.push({
        stack: name,
        base,
        reason: `base ${pc.yellow(base)} is already in ${pc.cyan(trunk)}`,
      });
    }
  }

  if (flagged.length === 0) return;

  console.log();
  p.log.warn("Stacks whose base appears merged into main:");
  for (const { stack, reason } of flagged) {
    console.log(`  ${pc.yellow("⚠")} ${pc.yellow(stack)} — ${reason}`);
  }
  console.log();
  console.log(`  ${pc.dim("Re-root each onto main once its parent has merged:")}`);
  console.log(`    ${pc.green("gh-stack checkout <stack>")}`);
  console.log(`    ${pc.green("gh-stack restack --onto main")}`);
}
