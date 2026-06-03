// Tests for auto-reconcile of metadata after `git branch -m` (issue #18).
//
// The contract: rename a tracked branch with plain git, run any gh-stack
// command, and the name-keyed JSON heals itself from the rename-proof branch
// config — no manual JSON surgery. Covers tip vs mid-stack, pre- vs
// post-submit, and a split stack's base branch.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import type { StackMetadata } from "../types.ts";
import {
  createTempRepo,
  createLinearStack,
  makeCommit,
  getCurrentBranch,
  checkout,
  cleanup,
} from "./helpers.ts";
import { readMetadata, writeMetadata } from "../lib/metadata.ts";
import { allBranchMemberships } from "../lib/branch-config.ts";
import { localBranchExists } from "../lib/git.ts";
import { setAutoYes } from "../lib/ui.ts";
import renameCmd from "../commands/rename.ts";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanup(tmpDir);
});

/**
 * Build the standard main → pr1 → pr2 → pr3 stack, then do one real write so
 * branch config + stable ids exist (the helper writes files only). Leaves us
 * on `main`. Returns the freshly-read, id-stamped metadata.
 */
async function realStack(): Promise<StackMetadata> {
  await createLinearStack(tmpDir);
  const meta = (await readMetadata())!;
  await writeMetadata(meta); // stamps ids + mirrors membership into git config
  return (await readMetadata())!;
}

describe("rename reconcile", () => {
  test("stamps a stable id on every active branch (mirrored into config)", async () => {
    const meta = await realStack();
    const b = meta.stacks["test-stack"]!.branches["pr2"]!;
    expect(typeof b.id).toBe("string");
    expect(b.id!.length).toBeGreaterThan(0);

    const config = await allBranchMemberships();
    expect(config.get("pr2")?.id).toBe(b.id);
  });

  test("tip rename re-keys the entry (matched post-submit by PR / by id)", async () => {
    await realStack();
    await $`git branch -m pr3 pr3-renamed`.quiet();

    const stack = (await readMetadata())!.stacks["test-stack"]!;
    expect(stack.branches["pr3-renamed"]).toBeDefined();
    expect(stack.branches["pr3"]).toBeUndefined();
    expect(stack.branches["pr3-renamed"]!.pr).toBe(3);
    expect(stack.last_branch).toBe("pr3-renamed");
  });

  test("mid-stack rename repoints the child's parent (JSON + config)", async () => {
    await realStack();
    await $`git branch -m pr2 pr2-renamed`.quiet();

    const meta = (await readMetadata())!;
    const stack = meta.stacks["test-stack"]!;
    expect(stack.branches["pr2-renamed"]).toBeDefined();
    expect(stack.branches["pr2"]).toBeUndefined();
    // child re-pointed in the in-memory JSON immediately
    expect(stack.branches["pr3"]!.parent).toBe("pr2-renamed");

    // persisting (what any mutating command does) heals the child's config too
    await writeMetadata(meta);
    const config = await allBranchMemberships();
    expect(config.has("pr2")).toBe(false);
    expect(config.get("pr2-renamed")?.stack).toBe("test-stack");
    expect(config.get("pr3")?.parent).toBe("pr2-renamed");
  });

  test("pre-submit rename (no PR yet) is matched by the stable id", async () => {
    await $`git checkout -b wip`.quiet();
    await makeCommit(tmpDir, "wip.txt", "wip\n", "wip work");

    const meta: StackMetadata = {
      version: 3,
      current_stack: "s",
      stacks: {
        s: {
          description: "",
          last_branch: "wip",
          base: "main",
          branches: { wip: { parent: "main" } }, // note: no pr
        },
      },
    };
    await writeMetadata(meta); // stamps an id for `wip`, writes config (no pr)

    await $`git checkout main`.quiet();
    await $`git branch -m wip wip-BEE-1234`.quiet();

    const stack = (await readMetadata())!.stacks["s"]!;
    expect(stack.branches["wip-BEE-1234"]).toBeDefined();
    expect(stack.branches["wip"]).toBeUndefined();
    expect(stack.last_branch).toBe("wip-BEE-1234");
  });

  test("renaming a split stack's base branch repoints the dependent stack", async () => {
    await realStack();

    // Split: {pr2, pr3} become their own stack based on pr1 (a non-main base).
    const meta = (await readMetadata())!;
    const root = meta.stacks["test-stack"]!;
    meta.stacks["child"] = {
      description: "",
      last_branch: "pr3",
      base: "pr1",
      branches: {
        pr2: root.branches["pr2"]!,
        pr3: root.branches["pr3"]!,
      },
    };
    root.branches = { pr1: root.branches["pr1"]! };
    root.last_branch = "pr1";
    meta.current_stack = "child";
    await writeMetadata(meta);

    await $`git branch -m pr1 pr1-renamed`.quiet();

    const reread = (await readMetadata())!;
    expect(reread.stacks["test-stack"]!.branches["pr1-renamed"]).toBeDefined();
    expect(reread.stacks["child"]!.base).toBe("pr1-renamed");
    expect(reread.stacks["child"]!.branches["pr2"]!.parent).toBe("pr1-renamed");
  });

  test("no spurious changes when nothing was renamed", async () => {
    await realStack();
    const before = await Bun.file(`${tmpDir}/.git/.gh-stack/active/test-stack.json`).text();

    const meta = (await readMetadata())!; // reconcile runs, finds nothing
    expect(Object.keys(meta.stacks["test-stack"]!.branches)).toEqual(["pr1", "pr2", "pr3"]);

    const after = await Bun.file(`${tmpDir}/.git/.gh-stack/active/test-stack.json`).text();
    expect(after).toBe(before); // read did not rewrite the file
  });
});

describe("rename command", () => {
  beforeEach(() => setAutoYes(true));
  afterEach(() => setAutoYes(false));

  test("two-arg form renames the git branch and persists the new key", async () => {
    await realStack(); // on main

    await renameCmd(["pr3", "pr3-renamed"]);

    expect(await localBranchExists("pr3")).toBe(false);
    expect(await localBranchExists("pr3-renamed")).toBe(true);

    const stack = (await readMetadata())!.stacks["test-stack"]!;
    expect(stack.branches["pr3-renamed"]).toBeDefined();
    expect(stack.branches["pr3"]).toBeUndefined();
    expect(stack.last_branch).toBe("pr3-renamed");
  });

  test("one-arg form renames the current branch", async () => {
    await realStack();
    await checkout(tmpDir, "pr2");

    await renameCmd(["pr2-renamed"]);

    expect(await getCurrentBranch(tmpDir)).toBe("pr2-renamed");
    const stack = (await readMetadata())!.stacks["test-stack"]!;
    expect(stack.branches["pr2-renamed"]).toBeDefined();
    expect(stack.branches["pr3"]!.parent).toBe("pr2-renamed"); // child repointed
  });
});
