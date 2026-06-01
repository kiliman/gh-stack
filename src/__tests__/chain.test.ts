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

  test("adopts into the nearest ancestor's stack across a non-main base (#11)", async () => {
    // stack-b is stacked on top of stack-a (base = "a", a non-main branch).
    // A new untracked branch `c` on top of stack-b's tip must be adopted into
    // stack-b — the walk stops at stack-b's base and never crosses into
    // stack-a, so this is NOT treated as an ambiguous multi-stack chain.
    await bareChain();
    const meta: StackMetadata = {
      version: 2,
      current_stack: "stack-b",
      stacks: {
        "stack-a": {
          description: "",
          last_branch: "a",
          branches: { a: { parent: "main" } },
          base: "main",
        },
        "stack-b": {
          description: "",
          last_branch: "b",
          branches: { b: { parent: "a" } },
          base: "a",
        },
      },
    };

    const res = await resolveOrCreateStack(meta, "c", "main");

    expect(res.created).toBe(false);
    expect(res.stackName).toBe("stack-b");
    expect(res.base).toBe("a");
    expect(res.addedBranches).toEqual(["c"]);
    expect(meta.stacks["stack-b"]!.branches["c"]!.parent).toBe("b");
    // stack-a is untouched — the walk never crossed the base boundary.
    expect(Object.keys(meta.stacks["stack-a"]!.branches)).toEqual(["a"]);
  });

  test("adopts a new tip onto a child stack with a non-main base — full repro (#11)", async () => {
    // Parent stack S0: main → s0a → mocktip ; child stack S1 (base mocktip):
    // mocktip → pr1 → pr2. New untracked branch pr3 on top of pr2.
    await createBranch(tmpDir, "s0a", "main");
    await makeCommit(tmpDir, "s0a.txt", "s0a\n", "s0a");
    await createBranch(tmpDir, "mocktip", "s0a");
    await makeCommit(tmpDir, "mocktip.txt", "mocktip\n", "mocktip");
    await createBranch(tmpDir, "pr1", "mocktip");
    await makeCommit(tmpDir, "pr1.txt", "pr1\n", "pr1");
    await createBranch(tmpDir, "pr2", "pr1");
    await makeCommit(tmpDir, "pr2.txt", "pr2\n", "pr2");
    await createBranch(tmpDir, "pr3", "pr2");
    await makeCommit(tmpDir, "pr3.txt", "pr3\n", "pr3");

    const meta: StackMetadata = {
      version: 2,
      current_stack: "S1",
      stacks: {
        S0: {
          description: "",
          last_branch: "mocktip",
          branches: { s0a: { parent: "main" }, mocktip: { parent: "s0a" } },
          base: "main",
        },
        S1: {
          description: "",
          last_branch: "pr2",
          branches: { pr1: { parent: "mocktip" }, pr2: { parent: "pr1" } },
          base: "mocktip",
        },
      },
    };

    const res = await resolveOrCreateStack(meta, "pr3", "main");

    expect(res.created).toBe(false);
    expect(res.stackName).toBe("S1");
    expect(res.base).toBe("mocktip");
    expect(res.addedBranches).toEqual(["pr3"]);
    expect(meta.stacks["S1"]!.branches["pr3"]!.parent).toBe("pr2");
    expect(meta.stacks["S1"]!.last_branch).toBe("pr3");
    // S0 (the parent stack) is left completely alone.
    expect(Object.keys(meta.stacks["S0"]!.branches).sort()).toEqual(["mocktip", "s0a"]);
  });
});
