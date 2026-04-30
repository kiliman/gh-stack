// Snapshot system for undo support and pre-rewrite base recovery
import type { StackMetadata, Snapshot } from "../types.ts";
import * as git from "./git.ts";
import { writeMetadata, getOrderedBranches } from "./metadata.ts";

/**
 * Find the pre-rewrite SHA for a branch by walking snapshots newest-first.
 *
 * Returns the SHA from the most recent snapshot whose recorded tip for
 * `branchName` is NOT an ancestor of the branch's current tip — meaning
 * that snapshot was taken before the branch's history got rewritten
 * (typically by `sync` rebasing it onto a new main).
 *
 * That pre-rewrite SHA is the correct rebase base when restacking a child
 * onto this branch — `git rebase --onto <new-tip> <pre-rewrite-tip> <child>`
 * replays only the child's unique commits, never the parent's old history.
 *
 * Returns null if no snapshots exist or every snapshot's recorded tip is
 * still an ancestor of the current tip (i.e., the branch has only had
 * commits appended, never been rebased — `merge-base` is still correct).
 */
export async function findPreRewriteSha(
  meta: StackMetadata,
  branchName: string,
): Promise<string | null> {
  if (!meta.snapshots || meta.snapshots.length === 0) return null;

  let currentTip: string;
  try {
    currentTip = await git.revParse(branchName);
  } catch {
    return null;
  }

  // Walk newest → oldest
  for (let i = meta.snapshots.length - 1; i >= 0; i--) {
    const recorded = meta.snapshots[i]!.branches[branchName];
    if (!recorded) continue;
    if (recorded === currentTip) continue;

    // If the recorded SHA is no longer an ancestor of the current tip,
    // the branch's history was rewritten between then and now.
    // That recorded SHA is the orphaned tip we need.
    const stillAncestor = await git.isAncestor(recorded, currentTip);
    if (!stillAncestor) {
      return recorded;
    }
  }

  return null;
}

const MAX_SNAPSHOTS = 10;

/**
 * Take a snapshot of all branch HEADs in the current stack before a destructive operation.
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
  };

  if (!meta.snapshots) {
    meta.snapshots = [];
  }

  meta.snapshots.push(snapshot);

  // Keep only the last N snapshots
  if (meta.snapshots.length > MAX_SNAPSHOTS) {
    meta.snapshots = meta.snapshots.slice(-MAX_SNAPSHOTS);
  }

  await writeMetadata(meta);
  return meta;
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
 * Pop the last snapshot (remove it after restoring).
 */
export async function popSnapshot(
  meta: StackMetadata,
): Promise<{ meta: StackMetadata; snapshot: Snapshot | null }> {
  if (!meta.snapshots || meta.snapshots.length === 0) {
    return { meta, snapshot: null };
  }

  const snapshot = meta.snapshots.pop()!;
  await writeMetadata(meta);
  return { meta, snapshot };
}
