// Shared test helpers for creating temp git repos and stacks
import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { StackMetadata } from "../types.ts";

/**
 * Create a temp git repo with an initial commit on main.
 * Returns the directory path. Caller must clean up.
 */
export async function createTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-test-"));

  await $`git init ${dir}`.quiet();
  await $`git -C ${dir} config user.email "test@test.com"`.quiet();
  await $`git -C ${dir} config user.name "Test"`.quiet();

  // Initial commit on main
  await Bun.write(`${dir}/README.md`, "# Test Repo\n");
  await $`git -C ${dir} add .`.quiet();
  await $`git -C ${dir} commit -m "initial commit"`.quiet();
  await $`git -C ${dir} branch -M main`.quiet();

  return dir;
}

/**
 * Create a commit on the current branch in a temp repo.
 */
export async function makeCommit(
  dir: string,
  filename: string,
  content: string,
  message: string,
): Promise<string> {
  await Bun.write(`${dir}/${filename}`, content);
  await $`git -C ${dir} add ${filename}`.quiet();
  await $`git -C ${dir} commit -m ${message}`.quiet();
  const sha = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  return sha;
}

/**
 * Create a branch in a temp repo.
 */
export async function createBranch(dir: string, name: string, from?: string): Promise<void> {
  if (from) {
    await $`git -C ${dir} checkout ${from}`.quiet();
  }
  await $`git -C ${dir} checkout -b ${name}`.quiet();
}

/**
 * Checkout a branch in a temp repo.
 */
export async function checkout(dir: string, branch: string): Promise<void> {
  await $`git -C ${dir} checkout ${branch}`.quiet();
}

/**
 * Get current branch in a temp repo.
 */
export async function getCurrentBranch(dir: string): Promise<string> {
  return (await $`git -C ${dir} rev-parse --abbrev-ref HEAD`.text()).trim();
}

/**
 * Get SHA of a ref in a temp repo.
 */
export async function getSha(dir: string, ref: string): Promise<string> {
  return (await $`git -C ${dir} rev-parse ${ref}`.text()).trim();
}

/**
 * Check if ref1 is ancestor of ref2.
 */
export async function isAncestor(
  dir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const { exitCode } = await $`git -C ${dir} merge-base --is-ancestor ${ancestor} ${descendant}`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

/**
 * Write metadata directly to a temp repo's .git dir.
 */
export async function writeMetadata(dir: string, meta: StackMetadata): Promise<void> {
  await Bun.write(`${dir}/.git/gh-stack-metadata.json`, JSON.stringify(meta, null, 2) + "\n");
}

/**
 * Read metadata from a temp repo.
 */
export async function readMetadata(dir: string): Promise<StackMetadata> {
  return Bun.file(`${dir}/.git/gh-stack-metadata.json`).json();
}

/**
 * Check if metadata file exists.
 */
export async function metadataExists(dir: string): Promise<boolean> {
  return Bun.file(`${dir}/.git/gh-stack-metadata.json`).exists();
}

/**
 * Create a standard 3-branch linear stack:
 *   main → pr1 → pr2 → pr3
 *
 * Each branch has one unique commit (different files, no conflicts).
 * Returns the metadata and branch SHAs.
 */
export async function createLinearStack(
  dir: string,
  opts?: { conflicting?: boolean },
): Promise<{
  meta: StackMetadata;
  shas: Record<string, string>;
}> {
  const shas: Record<string, string> = {};

  // main already has initial commit
  shas.main = await getSha(dir, "main");

  // PR1: branch off main
  await createBranch(dir, "pr1", "main");
  if (opts?.conflicting) {
    shas.pr1 = await makeCommit(dir, "shared.txt", "pr1 version\n", "pr1: shared file");
  } else {
    shas.pr1 = await makeCommit(dir, "pr1.txt", "pr1 content\n", "pr1: add file");
  }

  // PR2: branch off pr1
  await createBranch(dir, "pr2", "pr1");
  shas.pr2 = await makeCommit(dir, "pr2.txt", "pr2 content\n", "pr2: add file");

  // PR3: branch off pr2
  await createBranch(dir, "pr3", "pr2");
  shas.pr3 = await makeCommit(dir, "pr3.txt", "pr3 content\n", "pr3: add file");

  // Write metadata
  const meta: StackMetadata = {
    version: 2,
    current_stack: "test-stack",
    stacks: {
      "test-stack": {
        description: "Test stack",
        last_branch: "pr3",
        branches: {
          pr1: { parent: "main", pr: 1, description: "PR 1" },
          pr2: { parent: "pr1", pr: 2, description: "PR 2" },
          pr3: { parent: "pr2", pr: 3, description: "PR 3" },
        },
      },
    },
  };

  await writeMetadata(dir, meta);

  // Go back to main
  await checkout(dir, "main");

  return { meta, shas };
}

/**
 * Create a branching (tree) stack:
 *   main → pr1 → pr2a
 *               → pr2b → pr3
 */
export async function createBranchingStack(dir: string): Promise<{
  meta: StackMetadata;
  shas: Record<string, string>;
}> {
  const shas: Record<string, string> = {};

  shas.main = await getSha(dir, "main");

  // PR1: branch off main
  await createBranch(dir, "pr1", "main");
  shas.pr1 = await makeCommit(dir, "pr1.txt", "pr1 content\n", "pr1: add file");

  // PR2a: branch off pr1
  await createBranch(dir, "pr2a", "pr1");
  shas.pr2a = await makeCommit(dir, "pr2a.txt", "pr2a content\n", "pr2a: add file");

  // PR2b: branch off pr1
  await createBranch(dir, "pr2b", "pr1");
  shas.pr2b = await makeCommit(dir, "pr2b.txt", "pr2b content\n", "pr2b: add file");

  // PR3: branch off pr2b
  await createBranch(dir, "pr3", "pr2b");
  shas.pr3 = await makeCommit(dir, "pr3.txt", "pr3 content\n", "pr3: add file");

  const meta: StackMetadata = {
    version: 2,
    current_stack: "tree-stack",
    stacks: {
      "tree-stack": {
        description: "Tree stack",
        last_branch: "pr3",
        branches: {
          pr1: { parent: "main", pr: 1, description: "PR 1" },
          pr2a: { parent: "pr1", pr: 2, description: "PR 2a" },
          pr2b: { parent: "pr1", pr: 3, description: "PR 2b" },
          pr3: { parent: "pr2b", pr: 4, description: "PR 3" },
        },
      },
    },
  };

  await writeMetadata(dir, meta);
  await checkout(dir, "main");

  return { meta, shas };
}

/**
 * Add a commit to main that will conflict with a branch.
 */
export async function addConflictingMainCommit(
  dir: string,
  filename: string = "shared.txt",
  content: string = "main version\n",
): Promise<string> {
  await checkout(dir, "main");
  return makeCommit(dir, filename, content, "main: conflicting change");
}

/**
 * Simulate an "origin/main" by creating a bare remote and pushing.
 */
export async function setupRemote(dir: string): Promise<string> {
  const remoteDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-remote-"));
  await $`git init --bare ${remoteDir}`.quiet();
  await $`git -C ${dir} remote add origin ${remoteDir}`.quiet();
  await $`git -C ${dir} push -u origin main`.quiet();
  return remoteDir;
}

/**
 * Push all branches to remote.
 */
export async function pushAllBranches(dir: string): Promise<void> {
  const branches = (await $`git -C ${dir} branch --format='%(refname:short)'`.text())
    .trim()
    .split("\n")
    .filter(Boolean);

  for (const branch of branches) {
    await $`git -C ${dir} push -u origin ${branch}`.quiet().nothrow();
  }
}

/**
 * Clean up a temp directory.
 */
export async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
