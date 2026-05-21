// Branch-chain detection and stack reconciliation.
//
// Shared by `init` (interactive stack creation) and `submit` (self-healing:
// auto-create/register a stack from a bare set of local branches so the
// end state is always stack registered + branches pushed + PRs created).
import * as git from "./git.ts";
import { findStackForBranch } from "./metadata.ts";
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
  chain: string[]; // trunk→current order
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
 *   - Detects the chain trunk→current.
 *   - If any branch in the chain already belongs to a stack, reconciles
 *     into that existing stack (adds only the missing branches).
 *   - Otherwise creates a new stack named after the current branch
 *     (auto-suffixed if that name is taken).
 *   - Registers missing branches with correct parent links (chain[0]'s
 *     parent is trunk; each subsequent branch's parent is the prior one).
 *
 * Throws if the chain spans more than one existing stack (ambiguous).
 */
export async function resolveOrCreateStack(
  meta: StackMetadata,
  branch: string,
  trunk: string,
): Promise<StackResolution> {
  const chain = await detectBranchChain(branch, trunk);

  // Which existing stacks (if any) already own branches in this chain?
  const owningStacks = new Set<string>();
  for (const b of chain) {
    const owner = findStackForBranch(meta, b);
    if (owner) owningStacks.add(owner);
  }

  if (owningStacks.size > 1) {
    throw new Error(
      `Branches in this chain span multiple stacks (${[...owningStacks].join(
        ", ",
      )}). Resolve manually with gh-stack init / delete.`,
    );
  }

  let stackName: string;
  let created = false;

  if (owningStacks.size === 1) {
    // Reconcile into the existing stack
    stackName = [...owningStacks][0]!;
  } else {
    // Create a new stack named after the current branch (auto-suffix on clash)
    stackName = branch;
    let n = 2;
    while (meta.stacks[stackName]) {
      stackName = `${branch}-${n++}`;
    }
    meta.stacks[stackName] = {
      description: "",
      last_branch: null,
      branches: {},
    };
    meta.current_stack = stackName;
    created = true;
  }

  const stack = meta.stacks[stackName]!;
  const addedBranches: string[] = [];

  // Register missing branches with correct parent links.
  for (let i = 0; i < chain.length; i++) {
    const name = chain[i]!;
    if (stack.branches[name]) continue; // already tracked — leave as-is

    const parent = i === 0 ? trunk : chain[i - 1]!;
    const branchData: Branch = { parent };
    stack.branches[name] = branchData;
    stack.last_branch = name;
    addedBranches.push(name);
  }

  return { stackName, chain, created, addedBranches };
}
