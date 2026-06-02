// v3 metadata: assemble from / fan out to `.git/.gh-stack/`.
//
// The in-memory `StackMetadata` shape is unchanged from v2 — every command
// still reads `meta.stacks[...]` / `meta.current_stack` and calls
// `writeMetadata(meta)`. Only the on-disk representation changed: instead of
// one monolithic JSON file, each stack is its own file and per-branch
// membership additionally lives in git config (see ./branch-config.ts).
//
// Two structural guarantees fall out of per-stack files:
//   • A bad write can't corrupt other stacks (no all-or-nothing blast radius).
//   • A stack can never silently vanish — on write, a stale stack file is moved
//     to `deleted/` (a recoverable tombstone), never just unlinked.
import type { StackMetadata, Stack, Branch, RestackState } from "../types.ts";
import { mkdir, readdir, rename, unlink, stat } from "node:fs/promises";
import {
  ghStackDir,
  activeDir,
  archivedDir,
  deletedDir,
  snapshotsDir,
  currentFile,
  restackStateFile,
  legacyMetadataPath,
  stackFileName,
  stackNameFromFile,
} from "./paths.ts";
import {
  allBranchMemberships,
  setBranchMembership,
  clearBranchMembership,
  type BranchMembership,
} from "./branch-config.ts";
import { loadSnapshots } from "./snapshot.ts";

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Create the `.gh-stack/` folder and its subdirectories if missing. */
async function ensureDirs(): Promise<void> {
  for (const dir of [
    await activeDir(),
    await archivedDir(),
    await deletedDir(),
    await snapshotsDir(),
  ]) {
    await mkdir(dir, { recursive: true });
  }
}

/** True if the v3 store (`.git/.gh-stack/`) exists. */
export async function v3Exists(): Promise<boolean> {
  return pathExists(await ghStackDir());
}

/** True if the legacy v2 monolith exists and hasn't been migrated yet. */
export async function legacyMetadataExists(): Promise<boolean> {
  return Bun.file(await legacyMetadataPath()).exists();
}

/**
 * Whether usable metadata exists. In v3 this means the `.gh-stack/` store is
 * present. (A bare legacy file is intentionally NOT counted — it must be
 * migrated via `gh-stack doctor` first; the gate in safety.ts surfaces that.)
 */
export async function metadataExists(): Promise<boolean> {
  return v3Exists();
}

export async function restackStatePath(): Promise<string> {
  return restackStateFile();
}

/**
 * Read one directory of `<stack>.json` files into a name→Stack map. Files that
 * fail to parse are skipped (doctor reports them) rather than aborting a read.
 */
async function readStackDir(dir: string): Promise<Record<string, Stack>> {
  const out: Record<string, Stack> = {};
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    try {
      const stack = (await Bun.file(`${dir}/${file}`).json()) as Stack;
      out[stackNameFromFile(file)] = stack;
    } catch {
      // Malformed stack file — skip; `doctor` will flag it.
    }
  }
  return out;
}

async function readCurrent(): Promise<string | null> {
  try {
    const text = (await Bun.file(await currentFile()).text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Read and assemble metadata from `.git/.gh-stack/`.
 * Returns null if the store doesn't exist.
 */
export async function readMetadata(): Promise<StackMetadata | null> {
  if (!(await v3Exists())) return null;
  await ensureDirs();

  const stacks = await readStackDir(await activeDir());
  const archive = await readStackDir(await archivedDir());
  const current = await readCurrent();
  const snapshots = await loadSnapshots();

  const meta: StackMetadata = {
    version: 3,
    current_stack: current,
    stacks,
  };
  if (Object.keys(archive).length > 0) meta.archive = archive;
  if (snapshots.length > 0) meta.snapshots = snapshots;

  backfillStackBase(meta);
  return meta;
}

/**
 * The ref a stack is rooted on. Defaults to "main" for stacks created before
 * the `base` field existed.
 */
export function stackBase(stack: Stack): string {
  return stack.base ?? "main";
}

/** Ensure every stack has an explicit `base` (in-memory only). */
function backfillStackBase(meta: StackMetadata): void {
  for (const stack of Object.values(meta.stacks)) {
    if (stack.base == null) stack.base = "main";
  }
  for (const stack of Object.values(meta.archive ?? {})) {
    if (stack.base == null) stack.base = "main";
  }
}

function serializeStack(stack: Stack): string {
  const out: Stack = {
    description: stack.description,
    last_branch: stack.last_branch,
    base: stackBase(stack),
    branches: stack.branches,
  };
  return JSON.stringify(out, null, 2) + "\n";
}

/**
 * Fan `meta` out to disk: write each active/archived stack to its own file,
 * tombstone any stack file that's no longer present, and reconcile git branch
 * config to match active membership.
 */
export async function writeMetadata(meta: StackMetadata): Promise<void> {
  await ensureDirs();

  // 1. current hint
  await Bun.write(await currentFile(), (meta.current_stack ?? "") + "\n");

  const aDir = await activeDir();
  const arDir = await archivedDir();

  // 2. write active + archived stack files (write desired state BEFORE
  //    removing anything — that's what makes "can't vanish" hold).
  for (const [name, stack] of Object.entries(meta.stacks)) {
    await Bun.write(`${aDir}/${stackFileName(name)}`, serializeStack(stack));
  }
  for (const [name, stack] of Object.entries(meta.archive ?? {})) {
    await Bun.write(`${arDir}/${stackFileName(name)}`, serializeStack(stack));
  }

  // 3. reconcile stale files. A name that moved to the other category (active
  //    ↔ archived) is just unlinked here; one that left both is tombstoned.
  const activeNames = new Set(Object.keys(meta.stacks));
  const archivedNames = new Set(Object.keys(meta.archive ?? {}));
  await reconcileStale(aDir, activeNames, (name) => archivedNames.has(name));
  await reconcileStale(arDir, archivedNames, (name) => activeNames.has(name));

  // 4. mirror active membership into git config
  await syncBranchConfig(meta);
}

/**
 * Remove stack files in `dir` whose names aren't in `keep`. A file whose name
 * lives in the other lifecycle bucket (`movedElsewhere`) is unlinked; anything
 * else is moved to `deleted/` as a recoverable tombstone.
 */
async function reconcileStale(
  dir: string,
  keep: Set<string>,
  movedElsewhere: (name: string) => boolean,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    const name = stackNameFromFile(file);
    if (keep.has(name)) continue;

    const from = `${dir}/${file}`;
    if (movedElsewhere(name)) {
      await unlink(from).catch(() => {});
    } else {
      // Tombstone rather than delete — a stack must never just disappear.
      const to = `${await deletedDir()}/${file}`;
      await rename(from, to).catch(() => unlink(from).catch(() => {}));
    }
  }
}

/**
 * Reconcile git branch config so it exactly mirrors active-stack membership.
 * Only branches whose recorded membership differs are touched, to avoid
 * shelling out to `git config` for every branch on every write.
 */
async function syncBranchConfig(meta: StackMetadata): Promise<void> {
  const desired = new Map<string, BranchMembership>();
  for (const [stackName, stack] of Object.entries(meta.stacks)) {
    for (const [branchName, b] of Object.entries(stack.branches)) {
      desired.set(branchName, { stack: stackName, parent: b.parent, pr: b.pr });
    }
  }

  const existing = await allBranchMemberships();

  for (const [branch, m] of desired) {
    const cur = existing.get(branch);
    if (!cur || cur.stack !== m.stack || cur.parent !== m.parent || cur.pr !== m.pr) {
      await setBranchMembership(branch, m);
    }
  }

  // Branches that still carry gh-stack config but are no longer active members.
  for (const branch of existing.keys()) {
    if (!desired.has(branch)) await clearBranchMembership(branch);
  }
}

/**
 * Initialize an empty v3 store.
 */
export async function initMetadata(): Promise<StackMetadata> {
  await ensureDirs();
  const data: StackMetadata = {
    version: 3,
    current_stack: null,
    stacks: {},
  };
  await writeMetadata(data);
  return data;
}

/**
 * Get current stack name from metadata.
 */
export function getCurrentStack(meta: StackMetadata): string | null {
  return meta.current_stack;
}

/**
 * Set the current stack.
 */
export async function setCurrentStack(
  meta: StackMetadata,
  stackName: string,
): Promise<StackMetadata> {
  meta.current_stack = stackName;
  await writeMetadata(meta);
  return meta;
}

/**
 * Find which stack contains a given branch.
 */
export function findStackForBranch(meta: StackMetadata, branch: string): string | null {
  for (const [name, stack] of Object.entries(meta.stacks)) {
    if (branch in stack.branches) {
      return name;
    }
  }
  return null;
}

/**
 * Create a new stack.
 */
export async function createStack(
  meta: StackMetadata,
  name: string,
  description: string,
  base: string = "main",
): Promise<StackMetadata> {
  meta.stacks[name] = {
    description,
    last_branch: null,
    branches: {},
    base,
  };
  meta.current_stack = name;
  await writeMetadata(meta);
  return meta;
}

/**
 * Add a branch to a stack.
 */
export async function addBranchToStack(
  meta: StackMetadata,
  stackName: string,
  branchName: string,
  branch: Branch,
): Promise<StackMetadata> {
  const stack = meta.stacks[stackName];
  if (!stack) {
    throw new Error(`Stack "${stackName}" not found`);
  }

  stack.branches[branchName] = branch;
  stack.last_branch = branchName;
  await writeMetadata(meta);
  return meta;
}

/**
 * Remove a branch from a stack, re-parenting children to the removed branch's parent.
 */
export async function removeBranchFromStack(
  meta: StackMetadata,
  stackName: string,
  branchName: string,
): Promise<StackMetadata> {
  const stack = meta.stacks[stackName];
  if (!stack) {
    throw new Error(`Stack "${stackName}" not found`);
  }

  const branch = stack.branches[branchName];
  if (!branch) {
    throw new Error(`Branch "${branchName}" not found in stack "${stackName}"`);
  }

  const removedParent = branch.parent;

  // Re-parent children
  for (const [, b] of Object.entries(stack.branches)) {
    if (b.parent === branchName) {
      b.parent = removedParent;
    }
  }

  // Remove the branch
  delete stack.branches[branchName];

  // The removed branch may still exist in git but is no longer a member —
  // drop its membership config explicitly (syncBranchConfig also would, but
  // be direct since the branch is gone from `meta`).
  await clearBranchMembership(branchName);

  // Update last_branch if it was the removed one
  if (stack.last_branch === branchName) {
    const remaining = Object.keys(stack.branches);
    stack.last_branch = remaining.length > 0 ? remaining[remaining.length - 1]! : null;
  }

  await writeMetadata(meta);
  return meta;
}

/**
 * Get the ordered list of branches from main to leaf for a stack.
 * Follows parent pointers to build the chain.
 */
export function getOrderedBranches(stack: Stack): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();

  function addChildrenOf(parent: string) {
    for (const [name, branch] of Object.entries(stack.branches)) {
      if (branch.parent === parent && !visited.has(name)) {
        visited.add(name);
        ordered.push(name);
        addChildrenOf(name);
      }
    }
  }

  addChildrenOf(stackBase(stack));
  return ordered;
}

/**
 * Get children of a branch in a stack.
 */
export function getChildren(stack: Stack, branchName: string): string[] {
  return Object.entries(stack.branches)
    .filter(([_, b]) => b.parent === branchName)
    .map(([name]) => name);
}

/**
 * Get the top (leaf) branch of a stack.
 */
export function getTopOfStack(stack: Stack): string | null {
  return stack.last_branch;
}

/**
 * Build the rebase chain: starting branch + all descendants (BFS order).
 */
export function buildRebaseChain(stack: Stack, startBranch: string): string[] {
  const chain: string[] = [startBranch];
  const queue: string[] = [startBranch];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = getChildren(stack, current);

    for (const child of children) {
      chain.push(child);
      queue.push(child);
    }
  }

  return chain;
}

/**
 * Update the last_branch for a stack.
 */
export async function updateLastBranch(
  meta: StackMetadata,
  stackName: string,
  branch: string,
): Promise<StackMetadata> {
  const stack = meta.stacks[stackName];
  if (stack) {
    stack.last_branch = branch;
    await writeMetadata(meta);
  }
  return meta;
}

// ── Restack state (for --resume) ──

/**
 * Save restack state for resume.
 */
export async function saveRestackState(state: RestackState): Promise<void> {
  await ensureDirs();
  await Bun.write(await restackStateFile(), JSON.stringify(state, null, 2) + "\n");
}

/**
 * Load restack state for resume.
 * Returns null if no state file exists.
 */
export async function loadRestackState(): Promise<RestackState | null> {
  const file = Bun.file(await restackStateFile());
  if (!(await file.exists())) {
    return null;
  }
  return file.json();
}

/**
 * Clear restack state file.
 */
export async function clearRestackState(): Promise<void> {
  const path = await restackStateFile();
  if (await Bun.file(path).exists()) {
    await unlink(path).catch(() => {});
  }
}
