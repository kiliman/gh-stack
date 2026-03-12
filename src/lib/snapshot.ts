// Snapshot system for undo support
import type { StackMetadata, Snapshot, Stack } from "../types.ts";
import * as git from "./git.ts";
import { writeMetadata, getOrderedBranches } from "./metadata.ts";

const MAX_SNAPSHOTS = 10;

/**
 * Take a snapshot of all branch HEADs in the current stack before a destructive operation.
 */
export async function takeSnapshot(
  meta: StackMetadata,
  stackName: string,
  operation: string
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
  meta: StackMetadata
): Promise<{ meta: StackMetadata; snapshot: Snapshot | null }> {
  if (!meta.snapshots || meta.snapshots.length === 0) {
    return { meta, snapshot: null };
  }

  const snapshot = meta.snapshots.pop()!;
  await writeMetadata(meta);
  return { meta, snapshot };
}
