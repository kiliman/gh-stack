// Snapshot system for undo support and pre-rewrite base recovery.
//
// v3 stores each snapshot as its own append-only file under
// `.git/.gh-stack/snapshots/`, retained per-stack. This replaces the single
// growing `snapshots[]` array of v2 — the array was rewritten on every command
// (churn + a conflict magnet) and global trimming could evict a dependent
// stack's only record while a busy sibling stack churned (see issue #13).
import type { StackMetadata, Snapshot } from "../types.ts";
import * as git from "./git.ts";
import { getOrderedBranches } from "./metadata.ts";
import { snapshotsDir } from "./paths.ts";
import { mkdir, readdir, unlink } from "node:fs/promises";

const MAX_SNAPSHOTS_PER_STACK = 10;

/**
 * Find the pre-rewrite SHA for a parent branch by walking snapshots newest-first.
 *
 * Returns the SHA from the most recent snapshot whose recorded tip for
 * `parentBranch` is NOT an ancestor of the parent's current tip — meaning
 * that snapshot was taken before the parent's history got rewritten
 * (typically by `sync` rebasing it onto a new main).
 *
 * That pre-rewrite SHA is the correct rebase base when restacking a child
 * onto this parent — `git rebase --onto <new-tip> <pre-rewrite-tip> <child>`
 * replays only the child's unique commits, never the parent's old history.
 *
 * **Child validation (issue #5)**: When `childBranch` is provided, any candidate
 * SHA must also still be an ancestor of the child. If the child has already
 * been rebased past this point (e.g., a previous restack already moved it),
 * the recorded SHA is stale for this child and would cause `rebase --onto`
 * to replay a wildly wrong range. We skip those candidates and keep walking.
 *
 * Returns null if no snapshots exist, no recorded tip qualifies, or every
 * snapshot's recorded tip is still an ancestor of the parent's current tip
 * (i.e., the parent has only had commits appended, never been rebased —
 * `merge-base` is still correct).
 */
export async function findPreRewriteSha(
  meta: StackMetadata,
  parentBranch: string,
  childBranch?: string,
): Promise<string | null> {
  if (!meta.snapshots || meta.snapshots.length === 0) return null;

  let currentParentTip: string;
  try {
    currentParentTip = await git.revParse(parentBranch);
  } catch {
    return null;
  }

  let currentChildTip: string | null = null;
  if (childBranch) {
    try {
      currentChildTip = await git.revParse(childBranch);
    } catch {
      // Child doesn't exist locally — fall back to parent-only validation
      currentChildTip = null;
    }
  }

  // Walk newest → oldest
  for (let i = meta.snapshots.length - 1; i >= 0; i--) {
    const recorded = meta.snapshots[i]!.branches[parentBranch];
    if (!recorded) continue;
    if (recorded === currentParentTip) continue;

    // The recorded SHA must no longer be an ancestor of the parent's current
    // tip — that's how we detect the parent's history was rewritten.
    const stillAncestorOfParent = await git.isAncestor(recorded, currentParentTip);
    if (stillAncestorOfParent) continue;

    // Issue #5 guard: if we know the child, the recorded SHA must still be
    // an ancestor of the child. Otherwise the child has already been rebased
    // past this point (or never branched off it) and using it as a base
    // would replay unrelated history.
    if (currentChildTip) {
      const stillAncestorOfChild = await git.isAncestor(recorded, currentChildTip);
      if (!stillAncestorOfChild) continue;
    }

    return recorded;
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
