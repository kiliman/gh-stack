// Branch-chain detection and stack reconciliation.
//
// Shared by `init` (interactive stack creation) and `submit` (self-healing:
// auto-create/register a stack from a bare set of local branches so the
// end state is always stack registered + branches pushed + PRs created).
import * as git from "./git.ts";
import { allBranchMemberships, type BranchMembership } from "./branch-config.ts";
import { findStackForBranch, getOrderedBranches, stackBase } from "./metadata.ts";
import type { StackMetadata, Branch } from "../types.ts";

/**
 * A new stack entry for a branch, keeping the PR number and id already
 * recorded for it in git config. Git config is shared by every worktree of a
 * repo, but stack files are not: a branch submitted in one worktree and then
 * tracked in another (the dependency sweep's handoff) would otherwise lose its
 * PR, and `sync` and `merge --base` would not see it merge.
 */
function newBranchEntry(parent: string, recorded: BranchMembership | undefined): Branch {
  return {
    parent,
    ...(recorded?.pr != null && { pr: recorded.pr }),
    ...(recorded?.id && { id: recorded.id }),
  };
}

/**
 * The refs that count as trunk: local `trunk` and, when it exists,
 * `origin/<trunk>`. Local trunk is often stale in a worktree, since it moves
 * only when someone pulls it, while `origin/<trunk>` moves with every fetch
 * from any worktree. A branch whose tip is on either one is trunk history, not
 * a stack member. This also matches `sync`, which rebases onto origin. (#73)
 */
export async function trunkRefs(trunk: string): Promise<string[]> {
  const refs = [trunk];
  if (await git.refExists(`refs/remotes/origin/${trunk}`)) refs.push(`origin/${trunk}`);
  return refs;
}

/** Whether `ref`'s tip is already in the history of any of `trunks`. */
async function onTrunk(ref: string, trunks: string[]): Promise<boolean> {
  for (const t of trunks) {
    if (await git.isAncestor(ref, t)) return true;
  }
  return false;
}

/** A branch left out of a detected chain because another one sits at the same commit. */
export interface SkippedBranch {
  branch: string;
  /** The branch at the same commit that was kept in the chain instead. */
  keptInstead: string;
}

export interface DetectedChain {
  /** Bottom-up: [closest-to-trunk, ..., current]. */
  chain: string[];
  /** Branches at the same commit as a chain member, left out of the chain. */
  skipped: SkippedBranch[];
}

/**
 * Detect a chain of branches from trunk to the current branch.
 *
 * Collects local branches whose tips are strict ancestors of the current
 * branch and not already on trunk (local or origin, see `trunkRefs`), then
 * orders them by commit distance (furthest = closest to trunk).
 *
 * Two branches at the same commit can't be parent and child, since neither is
 * above the other. Only one of them goes in the chain: the one gh-stack has
 * recorded in git config (shared by every worktree), else the first by name.
 * The others come back in `skipped` so callers can say so. (#73)
 */
export async function detectChain(currentBranch: string, trunk: string): Promise<DetectedChain> {
  const tips = await git.localBranchTips();
  const trunks = await trunkRefs(trunk);
  const recorded = await allBranchMemberships();

  // Branches to exclude: current, trunk, and always main/master
  const excluded = new Set([currentBranch, trunk, "main", "master"]);

  // Candidate ancestors, grouped by tip commit.
  const byTip = new Map<string, { names: string[]; distance: number }>();
  for (const [branch, sha] of tips) {
    if (excluded.has(branch)) continue;
    if (!(await git.isAncestor(branch, currentBranch))) continue;
    if (await onTrunk(branch, trunks)) continue;
    const group = byTip.get(sha);
    if (group) {
      group.names.push(branch);
      continue;
    }
    // How many commits between this branch and current? 0 = same commit as
    // current: a colocated branch, not a parent (see colocatedBranches).
    const distance = await git.commitCount(branch, currentBranch);
    if (distance > 0) byTip.set(sha, { names: [branch], distance });
  }

  // Furthest from current first, so the list runs trunk → current.
  const groups = [...byTip.values()].toSorted((a, b) => b.distance - a.distance);

  const chain: string[] = [];
  const skipped: SkippedBranch[] = [];
  for (const group of groups) {
    const names = group.names.toSorted((a, b) => {
      const ra = recorded.has(a) ? 0 : 1;
      const rb = recorded.has(b) ? 0 : 1;
      return ra - rb || a.localeCompare(b);
    });
    const kept = names[0]!;
    // Every link must be a real ancestor of the next. Ancestors of one branch
    // are always ordered on a linear history; this guards merge-commit shapes.
    const below = chain[chain.length - 1];
    if (below && !(await git.isAncestor(below, kept))) continue;
    chain.push(kept);
    for (const other of names.slice(1)) skipped.push({ branch: other, keptInstead: kept });
  }
  chain.push(currentBranch);

  return { chain, skipped };
}

/**
 * The chain alone, trunk → current. See `detectChain`.
 * For a branch based directly off trunk, returns just [current].
 */
export async function detectBranchChain(currentBranch: string, trunk: string): Promise<string[]> {
  return (await detectChain(currentBranch, trunk)).chain;
}

/** One line per skipped branch, for init/add/submit to print as a warning. */
export function describeSkipped(skipped: SkippedBranch[]): string {
  return (
    `Left out of the stack: these branches point at the same commit as one already in it, so they can't be its parent or child:\n` +
    skipped.map((s) => `    ${s.branch} (same commit as ${s.keptInstead})`).join("\n")
  );
}

/**
 * Local branches (other than trunk) whose tip is the SAME commit as `branch`.
 * A branch with no commits of its own sits at its parent's tip rather than
 * above it, so `detectBranchChain` can't see the parent — and from ancestry
 * alone the two are indistinguishable. Callers use this to warn instead of
 * silently rooting the branch at trunk. (#37)
 */
export async function colocatedBranches(branch: string, trunk: string): Promise<string[]> {
  const tip = await git.revParse(branch);
  const trunks = await trunkRefs(trunk);
  const excluded = new Set([branch, trunk, "main", "master"]);
  const out: string[] = [];
  for (const [other, sha] of await git.localBranchTips()) {
    if (excluded.has(other) || sha !== tip) continue;
    // A branch sitting on trunk (local or origin) isn't a stack parent, just trunk.
    if (await onTrunk(other, trunks)) continue;
    out.push(other);
  }
  return out;
}

export interface StackResolution {
  stackName: string;
  base: string; // effective base of the resulting stack (for display)
  chain: string[]; // resulting stack's branches, base→tip (for display)
  created: boolean; // true if a brand-new stack was created
  addedBranches: string[]; // branches newly registered into the stack
  skipped: SkippedBranch[]; // same-commit branches left out of the chain (#73)
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
  const { chain: fullChain, skipped } = await detectChain(branch, trunk); // trunk→current
  const recorded = await allBranchMemberships();

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
      stack.branches[name] = newBranchEntry(parent, recorded.get(name));
      stack.last_branch = name;
      addedBranches.push(name);
    }

    return {
      stackName: anchorStack,
      base: stackBase(stack),
      chain: getOrderedBranches(stack),
      created: false,
      addedBranches,
      skipped,
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
    stack.branches[name] = newBranchEntry(parent, recorded.get(name));
    stack.last_branch = name;
    addedBranches.push(name);
  }

  return {
    stackName,
    base: trunk,
    chain: getOrderedBranches(stack),
    created: true,
    addedBranches,
    skipped,
  };
}
