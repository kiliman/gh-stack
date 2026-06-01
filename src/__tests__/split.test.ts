// Tests for `gh-stack split` and base-aware stack ordering.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, createLinearStack, createTempRepo, readMetadata } from "./helpers.ts";
import split from "../commands/split.ts";
import { getOrderedBranches, stackBase } from "../lib/metadata.ts";
import { setAutoYes } from "../lib/ui.ts";
import type { Stack } from "../types.ts";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  setAutoYes(true); // auto-confirm the split
});

afterEach(async () => {
  setAutoYes(false);
  process.chdir(originalCwd);
  await cleanup(tmpDir);
});

// ── base-aware ordering (pure) ──

describe("stackBase / getOrderedBranches", () => {
  test("defaults base to main when unset", () => {
    const stack: Stack = {
      description: "",
      last_branch: "a",
      branches: { a: { parent: "main" } },
    };
    expect(stackBase(stack)).toBe("main");
    expect(getOrderedBranches(stack)).toEqual(["a"]);
  });

  test("roots ordering at a non-main base", () => {
    // Stack rooted on feat-2 (a branch in another stack).
    const stack: Stack = {
      description: "",
      last_branch: "feat-4",
      base: "feat-2",
      branches: {
        "feat-3": { parent: "feat-2" },
        "feat-4": { parent: "feat-3" },
      },
    };
    expect(stackBase(stack)).toBe("feat-2");
    // Must find the root (parent === base) and walk up from there.
    expect(getOrderedBranches(stack)).toEqual(["feat-3", "feat-4"]);
  });

  test("returns empty when no branch roots at the base", () => {
    const stack: Stack = {
      description: "",
      last_branch: null,
      base: "nonexistent",
      branches: { a: { parent: "main" } },
    };
    expect(getOrderedBranches(stack)).toEqual([]);
  });
});

// ── split command ──

describe("split", () => {
  test("cuts a linear stack into two at the given branch", async () => {
    // main → pr1 → pr2 → pr3, current_stack = "test-stack"
    await createLinearStack(tmpDir);

    await split(["pr2"]);

    const meta = await readMetadata(tmpDir);

    // Original stack keeps pr1 only, still rooted on main.
    const orig = meta.stacks["test-stack"]!;
    expect(Object.keys(orig.branches).sort()).toEqual(["pr1"]);
    expect(orig.base ?? "main").toBe("main");
    expect(orig.last_branch).toBe("pr1");

    // New stack holds pr2 + pr3, based on pr1 (which stayed in the original).
    const created = meta.stacks["pr2"]!;
    expect(created).toBeDefined();
    expect(Object.keys(created.branches).sort()).toEqual(["pr2", "pr3"]);
    expect(created.base).toBe("pr1");
    expect(created.last_branch).toBe("pr3");
    // pr2's parent pointer is unchanged — it IS the new root.
    expect(created.branches["pr2"]!.parent).toBe("pr1");
  });

  test("honors --name for the new stack", async () => {
    await createLinearStack(tmpDir);

    await split(["pr3", "--name", "phase-2"]);

    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["phase-2"]).toBeDefined();
    expect(meta.stacks["phase-2"]!.base).toBe("pr2");
    expect(Object.keys(meta.stacks["phase-2"]!.branches)).toEqual(["pr3"]);
    // Original keeps pr1, pr2.
    expect(Object.keys(meta.stacks["test-stack"]!.branches).sort()).toEqual(["pr1", "pr2"]);
  });

  test("the split-off stack is independently well-formed (single root at its base)", async () => {
    await createLinearStack(tmpDir);
    await split(["pr2"]);

    const meta = await readMetadata(tmpDir);
    const created = meta.stacks["pr2"]!;
    const base = stackBase(created);
    const roots = Object.keys(created.branches).filter((b) => created.branches[b]!.parent === base);
    expect(roots).toEqual(["pr2"]);
  });
});
