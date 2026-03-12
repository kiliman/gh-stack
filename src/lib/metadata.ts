// Read/write/validate .git/git-stack-metadata.json
import type {
  StackMetadata,
  StackMetadataV1,
  Stack,
  Branch,
  RestackState,
} from "../types.ts";
import { gitDir } from "./git.ts";

let cachedGitDir: string | null = null;

async function getGitDir(): Promise<string> {
  if (!cachedGitDir) {
    cachedGitDir = await gitDir();
  }
  return cachedGitDir;
}

/**
 * Get the path to the metadata file.
 */
export async function metadataPath(): Promise<string> {
  const dir = await getGitDir();
  return `${dir}/git-stack-metadata.json`;
}

/**
 * Get the path to the restack state file.
 */
export async function restackStatePath(): Promise<string> {
  const dir = await getGitDir();
  return `${dir}/.git-stack-sync-state`;
}

/**
 * Check if metadata file exists.
 */
export async function metadataExists(): Promise<boolean> {
  const path = await metadataPath();
  return Bun.file(path).exists();
}

/**
 * Read and parse metadata, with auto-migration from v1.
 * Returns null if file doesn't exist.
 */
export async function readMetadata(): Promise<StackMetadata | null> {
  const path = await metadataPath();
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return null;
  }

  const raw = await file.json();

  // Auto-migrate v1 -> v2
  if (!raw.version) {
    const v1 = raw as StackMetadataV1;
    const v2: StackMetadata = {
      version: 2,
      current_stack: v1.current_stack,
      stacks: v1.stacks,
    };
    await writeMetadata(v2);
    return v2;
  }

  return raw as StackMetadata;
}

/**
 * Write metadata to disk.
 */
export async function writeMetadata(data: StackMetadata): Promise<void> {
  const path = await metadataPath();
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Initialize an empty metadata file.
 */
export async function initMetadata(): Promise<StackMetadata> {
  const data: StackMetadata = {
    version: 2,
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
  stackName: string
): Promise<StackMetadata> {
  meta.current_stack = stackName;
  await writeMetadata(meta);
  return meta;
}

/**
 * Find which stack contains a given branch.
 */
export function findStackForBranch(
  meta: StackMetadata,
  branch: string
): string | null {
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
  description: string
): Promise<StackMetadata> {
  meta.stacks[name] = {
    description,
    last_branch: null,
    branches: {},
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
  branch: Branch
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
  branchName: string
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
  for (const [name, b] of Object.entries(stack.branches)) {
    if (b.parent === branchName) {
      b.parent = removedParent;
    }
  }

  // Remove the branch
  delete stack.branches[branchName];

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

  addChildrenOf("main");
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
export function buildRebaseChain(
  stack: Stack,
  startBranch: string
): string[] {
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
  branch: string
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
  const path = await restackStatePath();
  await Bun.write(path, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Load restack state for resume.
 * Returns null if no state file exists.
 */
export async function loadRestackState(): Promise<RestackState | null> {
  const path = await restackStatePath();
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return null;
  }

  return file.json();
}

/**
 * Clear restack state file.
 */
export async function clearRestackState(): Promise<void> {
  const path = await restackStatePath();
  const file = Bun.file(path);

  if (await file.exists()) {
    const { unlink } = await import("node:fs/promises");
    await unlink(path);
  }
}
