// Snapshot system for undo support and pre-rewrite base recovery
import type { StackMetadata, Snapshot } from "../types.ts";
import * as git from "./git.ts";
import { writeMetadata, getOrderedBranches } from "./metadata.ts";

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
