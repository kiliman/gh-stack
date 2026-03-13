// Pre-flight safety checks
import * as git from "./git.ts";
import { metadataExists, readMetadata, findStackForBranch } from "./metadata.ts";
import type { StackMetadata } from "../types.ts";
import * as p from "@clack/prompts";
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
 * Ensure metadata file exists. Returns the metadata.
 */
export async function ensureMetadata(): Promise<StackMetadata> {
  if (!(await metadataExists())) {
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
 * Ensure current branch is in a stack. Returns the stack name.
 */
export async function ensureBranchInStack(meta: StackMetadata): Promise<string> {
  const branch = await git.currentBranch();
  const stackName = findStackForBranch(meta, branch);

  if (!stackName) {
    p.cancel(
      `Branch ${pc.blue(branch)} is not in any stack.\n\n  Add it with:\n    ${pc.green("gh-stack add")}\n\n  Or create a new stack:\n    ${pc.green("gh-stack init")}`,
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
