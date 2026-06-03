// Pre-flight safety checks
import * as git from "./git.ts";
import {
  metadataExists,
  legacyMetadataExists,
  readMetadata,
  findStackForBranch,
  stackBase,
} from "./metadata.ts";
import type { StackMetadata, Stack } from "../types.ts";
import * as p from "./output.ts";
import pc from "picocolors";

/**
 * Ensure we're in a git repository.
 */
export async function ensureGitRepo(): Promise<void> {
  if (!(await git.isGitRepo())) {
    p.cancel("Not in a git repository");
    process.exit(1);
  }
}

/**
 * If no v3 store exists but a legacy v2 monolith does, halt and point the user
 * at `gh-stack doctor`. Call this from any command that checks for metadata
 * directly (i.e. doesn't go through ensureMetadata) so the migration gate is
 * uniform. No-op when there's no legacy file to migrate.
 */
export async function gateLegacyMetadata(): Promise<void> {
  if (await metadataExists()) return;
  if (await legacyMetadataExists()) {
    p.cancel(
      `Stack metadata is in the old format and needs migrating.\n\n  Run:\n    ${pc.green("gh-stack doctor")}`,
    );
    process.exit(1);
  }
}

export async function ensureMetadata(): Promise<StackMetadata> {
  if (!(await metadataExists())) {
    // A v2 monolith still on disk means this repo predates v3 — gate behind an
    // explicit one-time migration rather than silently reading the old format.
    await gateLegacyMetadata();
    p.cancel(
      `No stack metadata found.\n\n  Create your first stack with:\n    ${pc.green("gh-stack init")}`,
    );
    process.exit(1);
  }

  const meta = await readMetadata();
  if (!meta) {
    p.cancel("Failed to read stack metadata");
    process.exit(1);
  }

  return meta;
}

/**
 * Ensure there's a current stack set. Returns the stack name.
 */
export function ensureCurrentStack(meta: StackMetadata): string {
  const stack = meta.current_stack;
  if (!stack || !meta.stacks[stack]) {
    p.cancel(
      `No current stack set.\n\n  Create a new stack with:\n    ${pc.green("gh-stack init")}`,
    );
    process.exit(1);
  }
  return stack;
}

/**
 * Resolve the stack to operate on from a branch argument. The branch names its
 * own stack unambiguously, so commands that take a branch (split, delete) use
 * this instead of trusting the current stack — letting `<cmd> <branch>` work
 * from anywhere, not only while standing on that stack.
 */
export function resolveStackForBranchArg(meta: StackMetadata, branch: string): string {
  const stackName = findStackForBranch(meta, branch);
  if (!stackName) {
    p.cancel(
      `Branch ${pc.yellow(branch)} is not in any stack.\n\n  See your stacks with:\n    ${pc.green("gh-stack stacks")}`,
    );
    process.exit(1);
  }
  return stackName;
}

/**
 * Ensure current branch is in a stack. Returns the stack name.
 */
export async function ensureBranchInStack(meta: StackMetadata): Promise<string> {
  const branch = await git.currentBranch();
  const stackName = findStackForBranch(meta, branch);

  if (!stackName) {
    p.cancel(
      `Branch ${pc.blue(branch)} is not in any stack.\n\n  Add it with:\n    ${pc.green("gh-stack create")}\n\n  Or create a new stack:\n    ${pc.green("gh-stack init")}`,
    );
    process.exit(1);
  }

  return stackName;
}

/**
 * Ensure working tree is clean (no uncommitted changes).
 */
export async function ensureCleanWorkingTree(): Promise<void> {
  if (!(await git.isCleanWorkingTree())) {
    p.cancel("Working tree is not clean.\n\n  Please commit or stash your changes first.");
    process.exit(1);
  }
}

/**
 * Ensure we're not on main.
 */
export async function ensureNotOnMain(): Promise<void> {
  const branch = await git.currentBranch();
  if (branch === "main" || branch === "master") {
    p.cancel(`Cannot run this command on ${pc.red(branch)}`);
    process.exit(1);
  }
}

/**
 * Guard against force-pushing main.
 */
export function ensureNotMain(branch: string): void {
  if (branch === "main" || branch === "master") {
    p.cancel(`${pc.red("REFUSED:")} Cannot force-push ${pc.red(branch)}`);
    process.exit(1);
  }
}

/**
 * Validate stack metadata before destructive operations.
 */
export async function validateStack(meta: StackMetadata, stackName: string): Promise<string[]> {
  const stack = meta.stacks[stackName];
  if (!stack) return [`Stack "${stackName}" not found`];

  const branchNames = Object.keys(stack.branches);
  const errors: string[] = [];
  const base = stackBase(stack);

  for (const branchName of branchNames) {
    const branch = stack.branches[branchName]!;

    if (!(await git.localBranchExists(branchName))) {
      errors.push(`Branch "${branchName}" does not exist locally`);
    }

    if (branch.parent === branchName) {
      errors.push(`Branch "${branchName}" cannot be its own parent`);
    }

    // A branch's parent must be either the stack's base (the root branch) or
    // another branch in the stack. For a split stack the base is a branch in
    // the parent stack, which legitimately lives outside `stack.branches`.
    if (branch.parent !== base && !stack.branches[branch.parent]) {
      errors.push(`Branch "${branchName}" has unknown parent "${branch.parent}"`);
    }
  }

  errors.push(...validateStackGraph(stack));
  return errors;
}

export async function ensureValidStack(meta: StackMetadata, stackName: string): Promise<void> {
  const errors = await validateStack(meta, stackName);
  if (errors.length === 0) return;

  p.cancel(`Invalid stack metadata for ${pc.yellow(stackName)}`);
  console.log();
  for (const error of errors) {
    console.log(`  ${pc.red("•")} ${error}`);
  }
  console.log();
  console.log(
    pc.dim(`Repair the local branches, or run ${pc.green("gh-stack doctor")}, before retrying.`),
  );
  process.exit(1);
}

function validateStackGraph(stack: Stack): string[] {
  const branchNames = Object.keys(stack.branches);
  if (branchNames.length === 0) return [];

  const errors: string[] = [];
  const base = stackBase(stack);
  const roots = branchNames.filter((branchName) => {
    return stack.branches[branchName]!.parent === base;
  });

  if (roots.length === 0) {
    errors.push(`Stack has no root branch with parent "${base}"`);
  }
  if (roots.length > 1) {
    errors.push(`Stack must have exactly one root branch; found ${roots.length}`);
  }

  const childrenByParent = new Map<string, string[]>();
  for (const [branchName, branch] of Object.entries(stack.branches)) {
    const siblings = childrenByParent.get(branch.parent) ?? [];
    siblings.push(branchName);
    childrenByParent.set(branch.parent, siblings);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  function walk(branchName: string) {
    if (visiting.has(branchName)) {
      errors.push(`Cycle detected involving "${branchName}"`);
      return;
    }
    if (visited.has(branchName)) return;

    visiting.add(branchName);
    for (const child of childrenByParent.get(branchName) ?? []) {
      walk(child);
    }
    visiting.delete(branchName);
    visited.add(branchName);
  }

  for (const root of roots) {
    walk(root);
  }

  // If the graph is malformed, walk any remaining nodes so we can report
  // cycles/unreachable branches instead of stopping at the root error.
  for (const branchName of branchNames) {
    if (!visited.has(branchName)) {
      walk(branchName);
    }
  }

  if (visited.size !== branchNames.length) {
    const unreachable = branchNames.filter((branchName) => !visited.has(branchName));
    errors.push(`Unreachable or cyclic branches detected: ${unreachable.join(", ")}`);
  }

  return errors;
}
