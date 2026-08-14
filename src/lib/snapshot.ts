// Snapshot system for undo support and pre-rewrite base recovery.
//
// v3 stores each snapshot as its own append-only file under
// `.git/.gh-stack/snapshots/`, retained per-stack. This replaces the single
// growing `snapshots[]` array of v2 — the array was rewritten on every command
// (churn + a conflict magnet) and global trimming could evict a dependent
// stack's only record while a busy sibling stack churned (see issue #13).
import type { StackMetadata, Snapshot } from "../types.ts";
import * as git from "./git.ts";
import { getOrderedBranches, stackBase } from "./metadata.ts";
import { snapshotsDir } from "./paths.ts";
import { mkdir, readdir, unlink } from "node:fs/promises";

const MAX_SNAPSHOTS_PER_STACK = 10;

/** Where a resolved restack boundary came from. */
export type BoundarySource = "snapshot" | "snapshot-derived" | "merge-base";

export type RestackBoundary = { sha: string; source: BoundarySource };

/**
 * Resolve the rebase boundary for restacking `childBranch` onto
 * `parentBranch`: the commit whose range `boundary..child` contains exactly
 * the child's own commits, for `git rebase --onto <parent> <boundary> <child>`.
 *
 * Resolution order:
 *
 * 1. `"snapshot"` (issue #2) — the most recent snapshot whose recorded tip for
 *    the parent is no longer an ancestor of the parent's current tip: that
 *    snapshot predates a rewrite of the parent (typically `sync` rebasing it
 *    onto a new main), and its orphaned old tip is exactly where the child's
 *    own commits start. The recorded tip must also still be an ancestor of the
 *    child (issue #5) — a stale tip the child was already rebased past would
 *    replay a wildly wrong range; those candidates are skipped, not used.
 *
 * 2. `"snapshot-derived"` (issue #30) — a snapshot proves the parent was
 *    rewritten but its recorded tip is not an ancestor of the child, e.g. the
 *    child sat BEHIND the parent at snapshot time (committed to the parent,
 *    then synced, before the child got its first commit). The recorded tip
 *    still pins the parent's pre-rewrite history, and the child forked
 *    somewhere on it: `merge-base(child, recordedTip)` is that fork point.
 *    Only used when it is a DESCENDANT of `merge-base(child, parent)` — the
 *    higher boundary is always the safe one, since everything below it already
 *    exists in the new base's history. (A stale #5-shaped snapshot derives a
 *    fork point BELOW the current merge-base; using it would replay the
 *    parent's commits, so the current merge-base wins there.)
 *
 * 3. `"merge-base"` — `merge-base(child, parent)`, correct whenever the parent
 *    has only had commits appended, never been rewritten.
 *
 * Returns null when nothing resolves (no snapshot evidence and no common
 * history) — the caller must refuse rather than guess.
 *
 * If the child branch doesn't exist locally, snapshot validation degrades to
 * parent-only (the newest rewritten tip is accepted without the child check).
 */
export async function resolveRestackBoundary(
  meta: StackMetadata,
  parentBranch: string,
  childBranch: string,
): Promise<RestackBoundary | null> {
  let currentParentTip: string | null = null;
  try {
    currentParentTip = await git.revParse(parentBranch);
  } catch {
    currentParentTip = null;
  }

  let currentChildTip: string | null = null;
  try {
    currentChildTip = await git.revParse(childBranch);
  } catch {
    currentChildTip = null;
  }

  // Walk snapshots newest → oldest for evidence the parent was rewritten.
  let accepted: string | null = null;
  let rejected: string | null = null; // newest rewritten tip that failed the child check
  if (currentParentTip && meta.snapshots) {
    for (let i = meta.snapshots.length - 1; i >= 0; i--) {
      const recorded = meta.snapshots[i]!.branches[parentBranch];
      if (!recorded || recorded === currentParentTip) continue;
      if (await git.isAncestor(recorded, currentParentTip)) continue; // appended-to, not rewritten
      if (!currentChildTip || (await git.isAncestor(recorded, currentChildTip))) {
        accepted = recorded;
        break;
      }
      rejected ??= recorded;
    }
  }

  if (accepted) return { sha: accepted, source: "snapshot" };

  const mbCurrent = await git.mergeBase(childBranch, parentBranch);

  if (rejected && currentChildTip) {
    const derived = await git.mergeBase(childBranch, rejected);
    if (derived) {
      if (!mbCurrent) return { sha: derived, source: "snapshot-derived" };
      if (derived !== mbCurrent && (await git.isAncestor(mbCurrent, derived))) {
        return { sha: derived, source: "snapshot-derived" };
      }
    }
  }

  return mbCurrent ? { sha: mbCurrent, source: "merge-base" } : null;
}

/**
 * Find the recorded tip of a stack's (non-main) base branch — the boundary a
 * re-root needs to replay only the dependent stack's own commits.
 *
 * Walks snapshots newest-first for one whose recorded `baseBranch` matches and
 * whose recorded `baseTip` is still an ancestor of `rootBranch` (the dependent
 * stack's root). That tip is exactly where the root forked off the base, so
 * `git rebase --onto <new-base> <baseTip> <root>` drops the already-merged
 * prefix instead of replaying it.
 *
 * Unlike `resolveRestackBoundary`, this does NOT require the base branch to still
 * exist locally — that's the whole point: after a squash-merge deletes the base
 * branch, its tip survives only in these snapshots. The ancestor-of-root check
 * rejects stale candidates (an older base tip the root no longer sits on).
 *
 * Returns null if no snapshot recorded this base, or none is still an ancestor
 * of the root (in which case the caller must refuse rather than guess).
 */
export async function findRecordedBaseTip(
  meta: StackMetadata,
  baseBranch: string,
  rootBranch: string,
): Promise<string | null> {
  if (!meta.snapshots || meta.snapshots.length === 0) return null;

  let rootTip: string;
  try {
    rootTip = await git.revParse(rootBranch);
  } catch {
    return null;
  }

  // Walk newest → oldest; first base tip that the root still sits on wins.
  for (let i = meta.snapshots.length - 1; i >= 0; i--) {
    const snap = meta.snapshots[i]!;
    if (snap.baseBranch !== baseBranch || !snap.baseTip) continue;
    if (await git.isAncestor(snap.baseTip, rootTip)) return snap.baseTip;
  }

  return null;
}

// Snapshot files are named `<sortable-timestamp>__<encoded-stack>.json`. The
// timestamp keeps colons/dots out of the filename (Windows-safe) while sorting
// chronologically as a plain string; the stack name is URL-encoded so `/` in a
// branch-derived name doesn't create subdirectories.
function snapshotFileName(snapshot: Snapshot): string {
  const ts = snapshot.timestamp.replace(/[:.]/g, "-");
  return `${ts}__${encodeURIComponent(snapshot.stack ?? "")}.json`;
}

/** Write a fully-formed snapshot to its file. Used by takeSnapshot and the
 * v2→v3 migration (which replays historical snapshots without touching git). */
export async function writeSnapshotFile(snapshot: Snapshot): Promise<void> {
  const dir = await snapshotsDir();
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/${snapshotFileName(snapshot)}`, JSON.stringify(snapshot, null, 2) + "\n");
}

/**
 * Load all snapshots from disk, oldest → newest. This populates
 * `meta.snapshots` on read so the in-memory shape matches v2.
 */
export async function loadSnapshots(): Promise<Snapshot[]> {
  const dir = await snapshotsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const snapshots: Snapshot[] = [];
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    try {
      snapshots.push((await Bun.file(`${dir}/${file}`).json()) as Snapshot);
    } catch {
      // Skip malformed snapshot files.
    }
  }

  // ISO 8601 timestamps sort chronologically as strings.
  return snapshots.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Take a snapshot of all branch HEADs in the current stack before a destructive
 * operation. Writes one append-only file and trims that stack's history to the
 * most recent N — sibling stacks are never touched.
 */
export async function takeSnapshot(
  meta: StackMetadata,
  stackName: string,
  operation: string,
): Promise<StackMetadata> {
  const stack = meta.stacks[stackName];
  if (!stack) return meta;

  const branches: Record<string, string> = {};
  const ordered = getOrderedBranches(stack);

  for (const branch of ordered) {
    try {
      branches[branch] = await git.revParse(branch);
    } catch {
      // Branch might not exist locally — skip
    }
  }

  const snapshot: Snapshot = {
    timestamp: new Date().toISOString(),
    operation,
    branches,
    stack: stackName,
  };

  // For a non-main base (a stack stacked on top of another stack), record the
  // base branch's tip too — kept out of `branches` so `undo` won't reset a
  // branch that belongs to the parent stack. This is the boundary a later
  // re-root needs if the base branch is deleted by a squash-merge (issue #13).
  const base = stackBase(stack);
  if (base !== "main" && base !== "master") {
    try {
      snapshot.baseTip = await git.revParse(base);
      snapshot.baseBranch = base;
    } catch {
      // Base branch already gone locally — nothing to record.
    }
  }

  await writeSnapshotFile(snapshot);

  // Keep in-memory array consistent for callers that read it afterward.
  if (!meta.snapshots) meta.snapshots = [];
  meta.snapshots.push(snapshot);

  await gcStackSnapshots(stackName);

  return meta;
}

/** Trim a single stack's snapshot files to the most recent N. */
async function gcStackSnapshots(stackName: string): Promise<void> {
  const dir = await snapshotsDir();
  const suffix = `__${encodeURIComponent(stackName)}.json`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const mine = entries.filter((f) => f.endsWith(suffix)).toSorted(); // sortable ts prefix
  const excess = mine.length - MAX_SNAPSHOTS_PER_STACK;
  for (let i = 0; i < excess; i++) {
    await unlink(`${dir}/${mine[i]!}`).catch(() => {});
  }
}

/**
 * Get the last snapshot (for undo).
 */
export function getLastSnapshot(meta: StackMetadata): Snapshot | null {
  if (!meta.snapshots || meta.snapshots.length === 0) {
    return null;
  }
  return meta.snapshots[meta.snapshots.length - 1]!;
}

/**
 * Pop the last snapshot (remove it after restoring) — deletes its file too.
 */
export async function popSnapshot(
  meta: StackMetadata,
): Promise<{ meta: StackMetadata; snapshot: Snapshot | null }> {
  if (!meta.snapshots || meta.snapshots.length === 0) {
    return { meta, snapshot: null };
  }

  const snapshot = meta.snapshots.pop()!;
  const dir = await snapshotsDir();
  await unlink(`${dir}/${snapshotFileName(snapshot)}`).catch(() => {});
  return { meta, snapshot };
}
