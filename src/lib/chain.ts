// Branch-chain detection and stack reconciliation.
//
// Shared by `init` (interactive stack creation) and `submit` (self-healing:
// auto-create/register a stack from a bare set of local branches so the
// end state is always stack registered + branches pushed + PRs created).
import * as git from "./git.ts";
import { findStackForBranch, getOrderedBranches, stackBase } from "./metadata.ts";
import type { StackMetadata, Branch } from "../types.ts";

/**
 * Detect a chain of branches from trunk to the current branch.
 *
 * Walks down from the current branch by finding local branches whose tips
 * are strict ancestors of the current branch. Sorts by commit distance
 * (closest = direct parent) to reconstruct the chain. Branches already
 * merged into trunk are skipped (stale/old branches).
 *
 * Returns branches in bottom-up order: [closest-to-trunk, ..., current].
 * For a branch based directly off trunk, returns just [current].
 */
export async function detectBranchChain(currentBranch: string, trunk: string): Promise<string[]> {
  const allBranches = await git.allLocalBranches();

  // Branches to exclude: current, trunk, and always main/master
  const excluded = new Set([currentBranch, trunk, "main", "master"]);

  // Find branches that are strict ancestors of current (and not trunk)
  const ancestors: { name: string; distance: number }[] = [];

  for (const branch of allBranches) {
    if (excluded.has(branch)) continue;

    // Is this branch's tip an ancestor of current?
    if (await git.isAncestor(branch, currentBranch)) {
      // Skip branches already merged into trunk (stale/old branches)
      if (await git.isAncestor(branch, trunk)) continue;

      // How many commits between this branch and current?
      const distance = await git.commitCount(branch, currentBranch);
      if (distance > 0) {
        ancestors.push({ name: branch, distance });
      }
    }
  }

  // Sort by distance descending (furthest from current = closest to trunk)
  ancestors.sort((a, b) => b.distance - a.distance);

  // Build chain: ancestors (sorted trunk→current) + current branch
  const chain = ancestors.map((a) => a.name);
  chain.push(currentBranch);

  return chain;
}

export interface StackResolution {
  stackName: string;
  base: string; // effective base of the resulting stack (for display)
  chain: string[]; // resulting stack's branches, base→tip (for display)
  created: boolean; // true if a brand-new stack was created
  addedBranches: string[]; // branches newly registered into the stack
}

/**
 * Ensure a stack exists for `branch`, reconstructing it from local branch
 * ancestry if needed. Mutates `meta` in place but does NOT persist — the
 * caller decides when to write (so `--dry-run` can preview without side
 * effects).
 *
 * Behavior:
 *   - Detects the ancestry chain trunk→current.
 *   - Finds the NEAREST tracked ancestor of `branch`. If one exists, adopts
 *     the untracked tail above it into that ancestor's stack — stopping at
 *     that stack's boundary. This is what lets a stack with a non-main base
 *     (one stacked on top of another stack) keep accepting new branches: the
 *     walk never crosses into the parent stack, so it can't mistake a clean
 *     stacked-on-a-stack layout for an ambiguous multi-stack chain. (#11)
 *   - Otherwise creates a new stack rooted at `trunk`, named after the current
 *     branch (auto-suffixed if that name is taken). (#7)
 *
 * Throws only if the untracked tail genuinely interleaves another stack's
 * branches — which a clean stacked-on-a-stack layout never does.
 */
export async function resolveOrCreateStack(
  meta: StackMetadata,
  branch: string,
  trunk: string,
): Promise<StackResolution> {
  const fullChain = await detectBranchChain(branch, trunk); // trunk→current

  // Walk from just below `branch` downward; the first tracked ancestor is the
  // attachment point. Everything above it (up to `branch`) is the untracked
  // tail we adopt — by definition not tracked, since this is the *nearest*
  // tracked ancestor.
  let anchorIndex = -1;
  let anchorStack: string | null = null;
  for (let i = fullChain.length - 2; i >= 0; i--) {
    const owner = findStackForBranch(meta, fullChain[i]!);
    if (owner) {
      anchorIndex = i;
      anchorStack = owner;
      break;
    }
  }

  if (anchorStack) {
    const stack = meta.stacks[anchorStack]!;
    const tail = fullChain.slice(anchorIndex); // [anchor, ...untracked..., current]
    const addedBranches: string[] = [];

    for (let i = 1; i < tail.length; i++) {
      const name = tail[i]!;
      const parent = tail[i - 1]!;

      // Safety net: a clean stacked-on-a-stack layout never trips this, but if
      // the tail somehow already belongs to a different stack, it's genuinely
      // ambiguous — refuse rather than silently move branches between stacks.
      const existingOwner = findStackForBranch(meta, name);
      if (existingOwner && existingOwner !== anchorStack) {
        throw new Error(
          `Branches in this chain span multiple stacks (${anchorStack}, ${existingOwner}). Resolve manually with gh-stack init / delete.`,
        );
      }

      if (stack.branches[name]) continue; // already tracked — leave as-is
      stack.branches[name] = { parent };
      stack.last_branch = name;
      addedBranches.push(name);
    }

    return {
      stackName: anchorStack,
      base: stackBase(stack),
      chain: getOrderedBranches(stack),
      created: false,
      addedBranches,
    };
  }

  // No tracked ancestor — create a new stack rooted at trunk.
  let stackName = branch;
  let n = 2;
  while (meta.stacks[stackName]) {
    stackName = `${branch}-${n++}`;
  }
  meta.stacks[stackName] = {
    description: "",
    last_branch: null,
    branches: {},
    base: trunk,
  };
  meta.current_stack = stackName;

  const stack = meta.stacks[stackName]!;
  const addedBranches: string[] = [];
  for (let i = 0; i < fullChain.length; i++) {
    const name = fullChain[i]!;
    if (stack.branches[name]) continue;
    const parent = i === 0 ? trunk : fullChain[i - 1]!;
    const branchData: Branch = { parent };
    stack.branches[name] = branchData;
    stack.last_branch = name;
    addedBranches.push(name);
  }

  return {
    stackName,
    base: trunk,
    chain: getOrderedBranches(stack),
    created: true,
    addedBranches,
  };
}
