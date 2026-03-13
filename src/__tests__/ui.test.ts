// Tests for UI rendering: tree output, branch ordering
import { describe, test, expect } from "bun:test";
import type { Stack } from "../types.ts";
import { renderStackTree } from "../lib/ui.ts";

// Strip ANSI codes for easier assertion
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderStackTree", () => {
  test("renders single branch stack", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr1",
      branches: {
        pr1: { parent: "main", pr: 1, description: "First PR" },
      },
    };

    const tree = stripAnsi(renderStackTree(stack, "pr1"));

    expect(tree).toContain("main");
    expect(tree).toContain("pr1");
    expect(tree).toContain("#1");
    expect(tree).toContain("First PR");
    expect(tree).toContain("(current)");
    expect(tree).toContain("┗━◯"); // Last item uses └
  });

  test("renders multi-branch stack with correct tree chars", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr3",
      branches: {
        pr1: { parent: "main", pr: 1, description: "PR 1" },
        pr2: { parent: "pr1", pr: 2, description: "PR 2" },
        pr3: { parent: "pr2", pr: 3, description: "PR 3" },
      },
    };

    const tree = stripAnsi(renderStackTree(stack, "pr2"));

    // Check ordering
    const lines = tree.split("\n");
    const mainIdx = lines.findIndex((l) => l.includes("main"));
    const pr1Idx = lines.findIndex((l) => l.includes("pr1"));
    const pr2Idx = lines.findIndex((l) => l.includes("pr2") && l.includes("(current)"));
    const pr3Idx = lines.findIndex((l) => l.includes("pr3"));

    expect(mainIdx).toBeLessThan(pr1Idx);
    expect(pr1Idx).toBeLessThan(pr2Idx);
    expect(pr2Idx).toBeLessThan(pr3Idx);

    // Current branch marker
    expect(tree).toContain("(current)");

    // Middle items use ┣, last uses ┗
    expect(tree).toContain("┣━◯");
    expect(tree).toContain("┗━◯");
  });

  test("renders branch without PR number", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr1",
      branches: {
        pr1: { parent: "main", description: "No PR yet" },
      },
    };

    const tree = stripAnsi(renderStackTree(stack, "pr1"));
    expect(tree).toContain("(no PR)");
    expect(tree).toContain("No PR yet");
  });

  test("renders with branch numbers", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr2",
      branches: {
        pr1: { parent: "main", pr: 1, description: "PR 1" },
        pr2: { parent: "pr1", pr: 2, description: "PR 2" },
      },
    };

    const tree = stripAnsi(renderStackTree(stack, "pr1"));
    expect(tree).toContain("[1]");
    expect(tree).toContain("[2]");
  });

  test("renders without branch numbers when disabled", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr1",
      branches: {
        pr1: { parent: "main", pr: 1, description: "PR 1" },
      },
    };

    const tree = stripAnsi(renderStackTree(stack, "pr1", { showNumbers: false }));
    expect(tree).not.toContain("[1]");
  });

  test("non-current branch is dimmed (no current marker)", () => {
    const stack: Stack = {
      description: "test",
      last_branch: "pr2",
      branches: {
        pr1: { parent: "main", pr: 1, description: "PR 1" },
        pr2: { parent: "pr1", pr: 2, description: "PR 2" },
      },
    };

    const tree = stripAnsi(renderStackTree(stack, "pr1"));

    // pr2 should NOT have (current) marker
    const lines = tree.split("\n");
    const pr2Lines = lines.filter((l) => l.includes("pr2"));
    for (const line of pr2Lines) {
      expect(line).not.toContain("(current)");
    }
  });

  test("empty stack renders only main", () => {
    const stack: Stack = {
      description: "test",
      last_branch: null,
      branches: {},
    };

    const tree = stripAnsi(renderStackTree(stack, "main"));
    expect(tree).toContain("main");
    expect(tree.split("\n").length).toBe(1); // Just the main line
  });
});
