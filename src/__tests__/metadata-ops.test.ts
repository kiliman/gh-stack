// Tests for metadata operations: create, add, remove, re-parent, ordered branches
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { StackMetadata, Stack } from "../types.ts";
import {
  createTempRepo,
  createLinearStack,
  createBranchingStack,
  writeMetadata,
  readMetadata,
  cleanup,
} from "./helpers.ts";
import {
  getOrderedBranches,
  buildRebaseChain,
  findStackForBranch,
  removeBranchFromStack,
  addBranchToStack,
} from "../lib/metadata.ts";
import { validateStack } from "../lib/safety.ts";

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

// ────────────────────────────────────────────────────────
// Remove mid-stack with re-parenting
// ────────────────────────────────────────────────────────

describe("remove branch with re-parenting", () => {
  test("removing middle branch re-parents children to removed branch's parent", async () => {
    const { meta } = await createLinearStack(tmpDir);
    // Stack: pr1 (main) → pr2 → pr3
    // Remove pr2 → pr3 should be re-parented to pr1

    const updated = await removeBranchFromStack(meta, "test-stack", "pr2");
    const stack = updated.stacks["test-stack"]!;

    expect(stack.branches["pr2"]).toBeUndefined();
    expect(stack.branches["pr3"]!.parent).toBe("pr1");
    expect(Object.keys(stack.branches)).toEqual(["pr1", "pr3"]);
  });

  test("removing base branch re-parents children to main", async () => {
    const { meta } = await createLinearStack(tmpDir);
    // Remove pr1 → pr2 should be re-parented to main

    const updated = await removeBranchFromStack(meta, "test-stack", "pr1");
    const stack = updated.stacks["test-stack"]!;

    expect(stack.branches["pr1"]).toBeUndefined();
    expect(stack.branches["pr2"]!.parent).toBe("main");
  });

  test("removing leaf branch doesn't affect others", async () => {
    const { meta } = await createLinearStack(tmpDir);
    // Remove pr3 → pr1 and pr2 unchanged

    const updated = await removeBranchFromStack(meta, "test-stack", "pr3");
    const stack = updated.stacks["test-stack"]!;

    expect(stack.branches["pr3"]).toBeUndefined();
    expect(stack.branches["pr1"]!.parent).toBe("main");
    expect(stack.branches["pr2"]!.parent).toBe("pr1");
  });

  test("removing branch with multiple children re-parents all of them", async () => {
    // Build tree: pr1 → pr2a, pr1 → pr2b
    const { meta } = await createBranchingStack(tmpDir);
    // Remove pr1 → pr2a and pr2b should both re-parent to main

    const updated = await removeBranchFromStack(meta, "tree-stack", "pr1");
    const stack = updated.stacks["tree-stack"]!;

    expect(stack.branches["pr1"]).toBeUndefined();
    expect(stack.branches["pr2a"]!.parent).toBe("main");
    expect(stack.branches["pr2b"]!.parent).toBe("main");
    // pr3 still points to pr2b
    expect(stack.branches["pr3"]!.parent).toBe("pr2b");
  });

  test("last_branch updates when removed branch was last", async () => {
    const { meta } = await createLinearStack(tmpDir);
    // pr3 is last_branch — remove it
    const updated = await removeBranchFromStack(meta, "test-stack", "pr3");
    const stack = updated.stacks["test-stack"]!;

    expect(stack.last_branch).not.toBe("pr3");
    expect(stack.last_branch).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────
// Ordered branches
// ────────────────────────────────────────────────────────

describe("getOrderedBranches with real stacks", () => {
  test("linear stack returns correct order", async () => {
    const { meta } = await createLinearStack(tmpDir);
    const stack = meta.stacks["test-stack"]!;

    expect(getOrderedBranches(stack)).toEqual(["pr1", "pr2", "pr3"]);
  });

  test("branching stack returns DFS order", async () => {
    const { meta } = await createBranchingStack(tmpDir);
    const stack = meta.stacks["tree-stack"]!;

    const ordered = getOrderedBranches(stack);
    // pr1 first, then its children in insertion order
    expect(ordered[0]).toBe("pr1");
    expect(ordered).toContain("pr2a");
    expect(ordered).toContain("pr2b");
    expect(ordered).toContain("pr3");
    // pr3 must come after pr2b (its parent)
    expect(ordered.indexOf("pr2b")).toBeLessThan(ordered.indexOf("pr3"));
  });

  test("empty stack returns empty array", () => {
    const stack: Stack = {
      description: "empty",
      last_branch: null,
      branches: {},
    };
    expect(getOrderedBranches(stack)).toEqual([]);
  });

  test("after removing middle branch, order is still correct", async () => {
    const { meta } = await createLinearStack(tmpDir);
    await removeBranchFromStack(meta, "test-stack", "pr2");
    const stack = meta.stacks["test-stack"]!;

    const ordered = getOrderedBranches(stack);
    expect(ordered).toEqual(["pr1", "pr3"]);
  });
});

// ────────────────────────────────────────────────────────
// Build rebase chain
// ────────────────────────────────────────────────────────

describe("buildRebaseChain with real stacks", () => {
  test("chain from base includes all descendants", async () => {
    const { meta } = await createLinearStack(tmpDir);
    const stack = meta.stacks["test-stack"]!;

    expect(buildRebaseChain(stack, "pr1")).toEqual(["pr1", "pr2", "pr3"]);
  });

  test("chain from middle includes only descendants", async () => {
    const { meta } = await createLinearStack(tmpDir);
    const stack = meta.stacks["test-stack"]!;

    expect(buildRebaseChain(stack, "pr2")).toEqual(["pr2", "pr3"]);
  });

  test("chain from leaf is just the leaf", async () => {
    const { meta } = await createLinearStack(tmpDir);
    const stack = meta.stacks["test-stack"]!;

    expect(buildRebaseChain(stack, "pr3")).toEqual(["pr3"]);
  });

  test("branching chain includes all subtree", async () => {
    const { meta } = await createBranchingStack(tmpDir);
    const stack = meta.stacks["tree-stack"]!;

    const chain = buildRebaseChain(stack, "pr1");
    expect(chain).toContain("pr1");
    expect(chain).toContain("pr2a");
    expect(chain).toContain("pr2b");
    expect(chain).toContain("pr3");
    expect(chain.length).toBe(4);
  });

  test("branching chain from pr2b includes only its subtree", async () => {
    const { meta } = await createBranchingStack(tmpDir);
    const stack = meta.stacks["tree-stack"]!;

    const chain = buildRebaseChain(stack, "pr2b");
    expect(chain).toEqual(["pr2b", "pr3"]);
  });

  test("branching chain from pr2a is just pr2a (leaf)", async () => {
    const { meta } = await createBranchingStack(tmpDir);
    const stack = meta.stacks["tree-stack"]!;

    expect(buildRebaseChain(stack, "pr2a")).toEqual(["pr2a"]);
  });
});

// ────────────────────────────────────────────────────────
// Multiple stacks
// ────────────────────────────────────────────────────────

describe("multiple stacks", () => {
  test("findStackForBranch finds correct stack", async () => {
    const meta: StackMetadata = {
      version: 2,
      current_stack: "stack-a",
      stacks: {
        "stack-a": {
          description: "A",
          last_branch: "pr1",
          branches: {
            pr1: { parent: "main", pr: 1 },
          },
        },
        "stack-b": {
          description: "B",
          last_branch: "pr2",
          branches: {
            pr2: { parent: "main", pr: 2 },
          },
        },
      },
    };

    expect(findStackForBranch(meta, "pr1")).toBe("stack-a");
    expect(findStackForBranch(meta, "pr2")).toBe("stack-b");
    expect(findStackForBranch(meta, "nonexistent")).toBeNull();
  });

  test("adding branch to one stack doesn't affect another", async () => {
    const meta: StackMetadata = {
      version: 2,
      current_stack: "stack-a",
      stacks: {
        "stack-a": {
          description: "A",
          last_branch: "pr1",
          branches: {
            pr1: { parent: "main", pr: 1 },
          },
        },
        "stack-b": {
          description: "B",
          last_branch: "pr2",
          branches: {
            pr2: { parent: "main", pr: 2 },
          },
        },
      },
    };

    await writeMetadata(tmpDir, meta);
    process.chdir(tmpDir);

    // Re-read fresh
    const fresh = await readMetadata(tmpDir);
    await addBranchToStack(fresh, "stack-a", "pr1b", {
      parent: "pr1",
      description: "PR 1b",
    });

    const result = await readMetadata(tmpDir);
    expect(Object.keys(result.stacks["stack-a"]!.branches)).toContain("pr1b");
    expect(Object.keys(result.stacks["stack-b"]!.branches)).toEqual(["pr2"]);
  });
});

describe("validateStack", () => {
  test("accepts a valid linear stack", async () => {
    const { meta } = await createLinearStack(tmpDir);
    expect(await validateStack(meta, "test-stack")).toEqual([]);
  });

  test("rejects missing local branches", async () => {
    const { meta } = await createLinearStack(tmpDir);
    delete meta.stacks["test-stack"]!.branches["pr2"];
    meta.stacks["test-stack"]!.branches["missing-branch"] = { parent: "pr1", pr: 99 };

    const errors = await validateStack(meta, "test-stack");
    expect(
      errors.some((error) => error.includes('Branch "missing-branch" does not exist locally')),
    ).toBe(true);
  });

  test("rejects unknown parents", async () => {
    const { meta } = await createLinearStack(tmpDir);
    meta.stacks["test-stack"]!.branches["pr3"]!.parent = "ghost-parent";

    const errors = await validateStack(meta, "test-stack");
    expect(errors.some((error) => error.includes('unknown parent "ghost-parent"'))).toBe(true);
  });

  test("rejects multiple roots", async () => {
    const { meta } = await createLinearStack(tmpDir);
    meta.stacks["test-stack"]!.branches["pr2"]!.parent = "main";

    const errors = await validateStack(meta, "test-stack");
    expect(errors).toContain("Stack must have exactly one root branch; found 2");
  });

  test("rejects cycles", async () => {
    const { meta } = await createLinearStack(tmpDir);
    meta.stacks["test-stack"]!.branches["pr1"]!.parent = "pr3";

    const errors = await validateStack(meta, "test-stack");
    expect(errors.some((error) => error.includes("no root branch"))).toBe(true);
    expect(errors.some((error) => error.includes("Cycle detected"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────
// v1 → v2 migration
// ────────────────────────────────────────────────────────

describe("metadata migration", () => {
  test("v1 metadata (no version field) gets migrated to v2", async () => {
    // Write v1 metadata (no version field)
    const v1 = {
      current_stack: "old-stack",
      stacks: {
        "old-stack": {
          description: "Old",
          last_branch: "pr1",
          branches: {
            pr1: { parent: "main", pr: 1 },
          },
        },
      },
    };

    await Bun.write(`${tmpDir}/.git/gh-stack-metadata.json`, JSON.stringify(v1, null, 2));

    // Import and read — should auto-migrate
    // We need to reset the cached git dir since we're in a different repo
    const mod = await import("../lib/metadata.ts");
    const result = await mod.readMetadata();

    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(result!.current_stack).toBe("old-stack");
    expect(result!.stacks["old-stack"]!.branches["pr1"]!.parent).toBe("main");
  });
});
