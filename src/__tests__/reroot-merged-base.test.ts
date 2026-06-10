// Re-rooting a dependent stack after its (non-main) base stack was squash-merged
// must NOT replay the already-merged commits. The boundary for the root's rebase
// is the old base branch's tip — recovered from a snapshot when the base branch
// itself has been deleted by the merge. Falling back to merge-base would replay
// the merged prefix and conflict-storm (issue #13).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  checkout,
  cleanup,
  createBranch,
  createTempRepo,
  makeCommit,
  readMetadata,
  writeMetadata,
} from "./helpers.ts";
import restack from "../commands/restack.ts";
import { setAutoYes } from "../lib/ui.ts";
import type { StackMetadata } from "../types.ts";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  setAutoYes(true); // auto-confirm the re-root prompt
});

afterEach(async () => {
  setAutoYes(false);
  process.chdir(originalCwd);
  await cleanup(tmpDir);
});

async function sha(ref: string): Promise<string> {
  return (await $`git -C ${tmpDir} rev-parse ${ref}`.text()).trim();
}

async function count(range: string): Promise<number> {
  return Number((await $`git -C ${tmpDir} rev-list --count ${range}`.text()).trim());
}

async function rebaseInProgress(): Promise<boolean> {
  const merge = await Bun.file(`${tmpDir}/.git/rebase-merge`).exists();
  const apply = await Bun.file(`${tmpDir}/.git/rebase-apply`).exists();
  return merge || apply;
}

// Build:  main → a1 → a2  (parent stack A)  and  a2 → b1 → b2  (child stack B, base a2)
// Then simulate A squash-merging into main and its branches being deleted.
// Returns the recorded a2 tip (captured while a2 still existed).
async function buildSplitStacksThenMergeA(): Promise<{
  a2tip: string;
  b1tip: string;
  b2tip: string;
}> {
  await createBranch(tmpDir, "a1", "main");
  await makeCommit(tmpDir, "a1.txt", "a1\n", "a1");
  await createBranch(tmpDir, "a2", "a1");
  await makeCommit(tmpDir, "a2.txt", "a2\n", "a2");
  await createBranch(tmpDir, "b1", "a2");
  await makeCommit(tmpDir, "b1.txt", "b1\n", "b1");
  await createBranch(tmpDir, "b2", "b1");
  await makeCommit(tmpDir, "b2.txt", "b2\n", "b2");

  const a2tip = await sha("a2");
  const b1tip = await sha("b1");
  const b2tip = await sha("b2");

  // Squash-merge stack A into main: one commit that rewrites a1.txt with
  // DIFFERENT content, so replaying old a1 onto it would collide (add/add).
  await checkout(tmpDir, "main");
  await makeCommit(tmpDir, "a1.txt", "squashed a1+a2\n", "squash-merge A (2 PRs → 1)");

  // A's branches are cleaned up after the merge — the base is now gone.
  await $`git -C ${tmpDir} branch -D a1 a2`.quiet();

  return { a2tip, b1tip, b2tip };
}

describe("re-root after a squash-merged non-main base (#13)", () => {
  test("uses the snapshot-recorded base tip — replays only the stack's own commits, no conflict", async () => {
    const { a2tip, b1tip, b2tip } = await buildSplitStacksThenMergeA();

    // Stack B with base a2, plus a prior snapshot that recorded a2's tip (taken
    // while a2 still existed — exactly what takeSnapshot now persists).
    const meta: StackMetadata = {
      version: 2,
      current_stack: "B",
      stacks: {
        B: {
          description: "",
          last_branch: "b2",
          base: "a2",
          branches: { b1: { parent: "a2" }, b2: { parent: "b1" } },
        },
      },
      snapshots: [
        {
          timestamp: "2026-06-01T00:00:00.000Z",
          operation: "restack",
          stack: "B",
          branches: { b1: b1tip, b2: b2tip },
          baseBranch: "a2",
          baseTip: a2tip,
        },
      ],
    };
    await writeMetadata(tmpDir, meta);

    await checkout(tmpDir, "b2");
    await restack(["--onto", "main"]); // re-root B onto main

    // No conflict — the rebase finished cleanly.
    expect(await rebaseInProgress()).toBe(false);

    // Each branch carries ONLY its own commit; a1/a2 were dropped, not replayed.
    expect(await count("main..b1")).toBe(1);
    expect(await count("b1..b2")).toBe(1);
    // b1 now sits directly on main.
    expect(await sha(`b1~1`)).toBe(await sha("main"));

    // Metadata reflects the new root.
    const after = await readMetadata(tmpDir);
    expect(after.stacks["B"]!.base).toBe("main");
    expect(after.stacks["B"]!.branches["b1"]!.parent).toBe("main");
  });

  test("refuses (does not replay) when the old base is gone and no snapshot recorded it", async () => {
    await buildSplitStacksThenMergeA();

    // Same layout, but NO snapshot recorded a2's tip — the boundary is unknown.
    const meta: StackMetadata = {
      version: 2,
      current_stack: "B",
      stacks: {
        B: {
          description: "",
          last_branch: "b2",
          base: "a2",
          branches: { b1: { parent: "a2" }, b2: { parent: "b1" } },
        },
      },
    };
    await writeMetadata(tmpDir, meta);

    await checkout(tmpDir, "b2");

    const exitCode = await runExpectingExit(() => restack(["--onto", "main"]));

    // Refused with exit 1 — never started a doomed rebase.
    expect(exitCode).toBe(1);
    expect(await rebaseInProgress()).toBe(false);

    // Nothing mutated: b1 still carries a1+a2+b1, base unchanged.
    expect(await count("main..b1")).toBe(3);
    const after = await readMetadata(tmpDir);
    expect(after.stacks["B"]!.base).toBe("a2");
    expect(after.stacks["B"]!.branches["b1"]!.parent).toBe("a2");
  });
});

// Swallow an intentional process.exit so it doesn't kill the runner; return the code.
async function runExpectingExit(fn: () => Promise<void>): Promise<number | undefined> {
  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__process_exit__");
  }) as never;
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "__process_exit__") throw err;
  } finally {
    process.exit = origExit;
  }
  return exitCode;
}
