// Tests for metadata module
import { describe, test, expect } from "bun:test";
import type { StackMetadata, Stack } from "../../types.ts";
import {
  getOrderedBranches,
  getChildren,
  buildRebaseChain,
  findStackForBranch,
} from "../metadata.ts";

// ── Pure function tests (no git required) ──

describe("getOrderedBranches", () => {
  test("returns branches in parent-first order", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr3",
      branches: {
        pr1: { parent: "main", pr: 1 },
        pr2: { parent: "pr1", pr: 2 },
        pr3: { parent: "pr2", pr: 3 },
      },
    };

    expect(getOrderedBranches(stack)).toEqual(["pr1", "pr2", "pr3"]);
  });

  test("handles single branch stack", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr1",
      branches: {
        pr1: { parent: "main", pr: 1 },
      },
    };

    expect(getOrderedBranches(stack)).toEqual(["pr1"]);
  });

  test("handles empty stack", () => {
    const stack: Stack = {
      description: "test",
      last_branch: null,
      branches: {},
    };

    expect(getOrderedBranches(stack)).toEqual([]);
  });

  test("handles branching (multiple children of same parent)", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr2b",
      branches: {
        pr1: { parent: "main", pr: 1 },
        pr2a: { parent: "pr1", pr: 2 },
        pr2b: { parent: "pr1", pr: 3 },
      },
    };

    const ordered = getOrderedBranches(stack);
    expect(ordered).toContain("pr1");
    expect(ordered).toContain("pr2a");
    expect(ordered).toContain("pr2b");
    expect(ordered.indexOf("pr1")).toBeLessThan(ordered.indexOf("pr2a"));
    expect(ordered.indexOf("pr1")).toBeLessThan(ordered.indexOf("pr2b"));
  });
});

describe("getChildren", () => {
  test("returns direct children", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr3",
      branches: {
        pr1: { parent: "main", pr: 1 },
        pr2: { parent: "pr1", pr: 2 },
        pr3: { parent: "pr1", pr: 3 },
      },
    };

    expect(getChildren(stack, "pr1")).toEqual(["pr2", "pr3"]);
  });

  test("returns empty array for leaf branch", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr2",
      branches: {
        pr1: { parent: "main", pr: 1 },
        pr2: { parent: "pr1", pr: 2 },
      },
    };

    expect(getChildren(stack, "pr2")).toEqual([]);
  });

  test("returns children of main", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr1",
      branches: {
        pr1: { parent: "main", pr: 1 },
      },
    };

    expect(getChildren(stack, "main")).toEqual(["pr1"]);
  });
});

describe("buildRebaseChain", () => {
  test("builds chain from start branch to all descendants", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr3",
      branches: {
        pr1: { parent: "main", pr: 1 },
        pr2: { parent: "pr1", pr: 2 },
        pr3: { parent: "pr2", pr: 3 },
      },
    };

    expect(buildRebaseChain(stack, "pr1")).toEqual(["pr1", "pr2", "pr3"]);
  });

  test("returns only start branch for leaf", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr3",
      branches: {
        pr1: { parent: "main", pr: 1 },
        pr2: { parent: "pr1", pr: 2 },
        pr3: { parent: "pr2", pr: 3 },
      },
    };

    expect(buildRebaseChain(stack, "pr3")).toEqual(["pr3"]);
  });

  test("includes branching children", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr2b",
      branches: {
        pr1: { parent: "main", pr: 1 },
        pr2a: { parent: "pr1", pr: 2 },
        pr2b: { parent: "pr1", pr: 3 },
      },
    };

    const chain = buildRebaseChain(stack, "pr1");
    expect(chain).toContain("pr1");
    expect(chain).toContain("pr2a");
    expect(chain).toContain("pr2b");
    expect(chain.length).toBe(3);
  });
});

describe("findStackForBranch", () => {
  test("finds stack containing a branch", () => {
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
    expect(findStackForBranch(meta, "pr3")).toBeNull();
  });
});
