// Tests for branch-chain detection and stack reconciliation (issue #7).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTempRepo, makeCommit, createBranch, checkout, cleanup } from "./helpers.ts";
import { detectBranchChain, resolveOrCreateStack } from "../lib/chain.ts";
import type { StackMetadata } from "../types.ts";

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

/** Build a bare local chain main → a → b → c (no metadata, no remotes). */
async function bareChain(): Promise<void> {
  await createBranch(tmpDir, "a", "main");
  await makeCommit(tmpDir, "a.txt", "a\n", "a: commit");
  await createBranch(tmpDir, "b", "a");
  await makeCommit(tmpDir, "b.txt", "b\n", "b: commit");
  await createBranch(tmpDir, "c", "b");
  await makeCommit(tmpDir, "c.txt", "c\n", "c: commit");
}

function emptyMeta(): StackMetadata {
  return { version: 2, current_stack: null, stacks: {} };
}

describe("detectBranchChain", () => {
  test("reconstructs a full chain trunk→current from the top branch", async () => {
    await bareChain();
    await checkout(tmpDir, "c");

    const chain = await detectBranchChain("c", "main");
    expect(chain).toEqual(["a", "b", "c"]);
  });

  test("returns just the current branch when based directly off trunk", async () => {
    await createBranch(tmpDir, "solo", "main");
    await makeCommit(tmpDir, "solo.txt", "solo\n", "solo: commit");
    await checkout(tmpDir, "solo");

    const chain = await detectBranchChain("solo", "main");
    expect(chain).toEqual(["solo"]);
  });

  test("stops at current — does not include descendants", async () => {
    await bareChain();
    // Run from the middle branch b — should not include c
    const chain = await detectBranchChain("b", "main");
    expect(chain).toEqual(["a", "b"]);
  });
});

describe("resolveOrCreateStack", () => {
  test("creates a new stack from a bare chain with correct parent links", async () => {
    await bareChain();
    const meta = emptyMeta();

    const res = await resolveOrCreateStack(meta, "c", "main");

    expect(res.created).toBe(true);
    expect(res.chain).toEqual(["a", "b", "c"]);
    expect(res.addedBranches).toEqual(["a", "b", "c"]);

    const stack = meta.stacks[res.stackName]!;
    expect(stack.branches["a"]!.parent).toBe("main");
    expect(stack.branches["b"]!.parent).toBe("a");
    expect(stack.branches["c"]!.parent).toBe("b");
    expect(stack.last_branch).toBe("c");
    expect(meta.current_stack).toBe(res.stackName);
  });

  test("creates a single-branch stack for a branch off trunk", async () => {
    await createBranch(tmpDir, "solo", "main");
    await makeCommit(tmpDir, "solo.txt", "solo\n", "solo: commit");
    const meta = emptyMeta();

    const res = await resolveOrCreateStack(meta, "solo", "main");

    expect(res.created).toBe(true);
    expect(res.chain).toEqual(["solo"]);
    const stack = meta.stacks[res.stackName]!;
    expect(Object.keys(stack.branches)).toEqual(["solo"]);
    expect(stack.branches["solo"]!.parent).toBe("main");
  });

  test("reconciles untracked branches into an existing stack", async () => {
    await bareChain();
    // Pre-existing stack tracks only a and b; c is untracked
    const meta: StackMetadata = {
      version: 2,
      current_stack: "existing",
      stacks: {
        existing: {
          description: "",
          last_branch: "b",
          branches: {
            a: { parent: "main" },
            b: { parent: "a" },
          },
        },
      },
    };

    const res = await resolveOrCreateStack(meta, "c", "main");

    expect(res.created).toBe(false);
    expect(res.stackName).toBe("existing");
    expect(res.addedBranches).toEqual(["c"]);

    const stack = meta.stacks["existing"]!;
    expect(stack.branches["c"]!.parent).toBe("b");
    // Existing entries untouched
    expect(stack.branches["a"]!.parent).toBe("main");
    expect(stack.branches["b"]!.parent).toBe("a");
  });

  test("auto-suffixes the stack name when the branch name is already taken", async () => {
    await bareChain();
    // A stack literally named "c" exists but doesn't contain branch c
    const meta: StackMetadata = {
      version: 2,
      current_stack: "c",
      stacks: {
        c: {
          description: "",
          last_branch: "other",
          branches: { other: { parent: "main" } },
        },
      },
    };

    const res = await resolveOrCreateStack(meta, "c", "main");

    expect(res.created).toBe(true);
    expect(res.stackName).toBe("c-2");
    expect(meta.stacks["c-2"]).toBeDefined();
    expect(meta.stacks["c"]!.branches["other"]).toBeDefined();
  });

  test("throws when the chain spans multiple existing stacks", async () => {
    await bareChain();
    const meta: StackMetadata = {
      version: 2,
      current_stack: "stack-a",
      stacks: {
        "stack-a": {
          description: "",
          last_branch: "a",
          branches: { a: { parent: "main" } },
        },
        "stack-b": {
          description: "",
          last_branch: "b",
          branches: { b: { parent: "a" } },
        },
      },
    };

    await expect(resolveOrCreateStack(meta, "c", "main")).rejects.toThrow(/span multiple stacks/);
  });
});
