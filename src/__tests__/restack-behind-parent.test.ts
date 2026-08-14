// A child that sits BEHIND its rewritten parent must not fall back to
// merge-base(child, parent) — that boundary predates the parent's own commits,
// so the rebase replays them onto their already-rebased equivalents (issue #30,
// the #2 failure mode reached through the #5 guard's rejection).
//
// Shape: main → A → B, where B was created off A before A's last commit landed
// (the everyday "placeholder branch for the next PR" state). Sync then rebases
// A onto an advanced main; B's restack boundary must come from the rejected
// snapshot (merge-base of B with A's recorded pre-rewrite tip), and a B with
// zero unique commits must move to A's tip without invoking rebase at all.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  checkout,
  cleanup,
  createBranch,
  createTempRepo,
  makeCommit,
  writeMetadata,
} from "./helpers.ts";
import restack from "../commands/restack.ts";
import { readMetadata as readLibMetadata } from "../lib/metadata.ts";
import { resolveRestackBoundary } from "../lib/snapshot.ts";
import { setAutoYes } from "../lib/ui.ts";
import type { StackMetadata } from "../types.ts";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  setAutoYes(true); // auto-confirm rebase prompts
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

// Build the issue-#30 state and hand back the tips restack will reason about:
//   1. A off main with one commit; B off A (optionally with its own commit)
//   2. a review fix lands on A            ← B is now behind A
//   3. main advances
//   4. the pre-sync snapshot records A at its fixed tip (aRecordedTip)
//   5. sync's step 1: A is rebased onto the new main
// Metadata is seeded with that snapshot; branches carry no PRs, so restack
// won't try to push anywhere (no remote exists).
async function buildBehindParentState(opts: { childCommit: boolean }): Promise<{
  aRecordedTip: string;
  bTip: string;
}> {
  await createBranch(tmpDir, "A", "main");
  await makeCommit(tmpDir, "a.txt", "a\n", "A: add a.txt");
  await createBranch(tmpDir, "B", "A");
  if (opts.childCommit) {
    await makeCommit(tmpDir, "b.txt", "b\n", "B: add b.txt");
  }
  const bTip = await sha("B");

  await checkout(tmpDir, "A");
  await makeCommit(tmpDir, "a-fix.txt", "fix\n", "A: review fix");
  const aRecordedTip = await sha("A");

  await checkout(tmpDir, "main");
  await makeCommit(tmpDir, "main-new.txt", "new\n", "main: advance");

  const meta: StackMetadata = {
    version: 2,
    current_stack: "S",
    stacks: {
      S: {
        description: "",
        last_branch: "B",
        base: "main",
        branches: { A: { parent: "main" }, B: { parent: "A" } },
      },
    },
    snapshots: [
      {
        timestamp: "2026-08-01T00:00:00.000Z",
        operation: "sync",
        stack: "S",
        branches: { A: aRecordedTip, B: bTip },
      },
    ],
  };
  await writeMetadata(tmpDir, meta);

  // Sync's step 1: rebase A onto the advanced main (rewrites A's history).
  await $`git -C ${tmpDir} rebase main A`.quiet();

  return { aRecordedTip, bTip };
}

describe("restack with child behind rewritten parent (#30)", () => {
  test("zero-commit child moves to the parent's tip — no rebase, no conflict", async () => {
    await buildBehindParentState({ childCommit: false });

    await checkout(tmpDir, "B");
    await restack([]);

    expect(await rebaseInProgress()).toBe(false);
    // B has no commits of its own — it must land exactly on A's tip,
    // never replaying A's commits onto their rebased equivalents.
    expect(await sha("B")).toBe(await sha("A"));
    expect(await count("A..B")).toBe(0);
  });

  test("child with one unique commit replays exactly that commit onto the parent", async () => {
    await buildBehindParentState({ childCommit: true });

    await checkout(tmpDir, "B");
    await restack([]);

    expect(await rebaseInProgress()).toBe(false);
    // Exactly B's own commit above A — A's history was not replayed.
    expect(await count("A..B")).toBe(1);
    // B contains everything: advanced main, both A commits, its own.
    await checkout(tmpDir, "B");
    expect(await Bun.file(`${tmpDir}/main-new.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/a.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/a-fix.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/b.txt`).exists()).toBe(true);
  });

  test("resolver derives the fork point from the rejected snapshot", async () => {
    const { aRecordedTip, bTip } = await buildBehindParentState({ childCommit: false });
    const m = (await readLibMetadata())!;

    // The recorded tip proves A was rewritten but is B's DESCENDANT, not its
    // ancestor — the #5 guard rejects it. The derived boundary is B's own tip
    // (its fork point on A's old history), not merge-base(B, A) = old main.
    const result = await resolveRestackBoundary(m, "A", "B");
    expect(result).toEqual({ sha: bTip, source: "snapshot-derived" });
    expect(result!.sha).not.toBe(await sha("main~1"));
    expect(aRecordedTip).not.toBe(bTip);
  });

  test("refuses instead of guessing when parent and child share no history", async () => {
    // Orphan child: no snapshots, no common ancestor with its recorded parent.
    await createBranch(tmpDir, "A", "main");
    await makeCommit(tmpDir, "a.txt", "a\n", "A: add a.txt");
    await $`git -C ${tmpDir} checkout --orphan B`.quiet();
    await $`git -C ${tmpDir} rm -rf .`.quiet();
    await makeCommit(tmpDir, "b.txt", "b\n", "B: orphan commit");
    const bTipBefore = await sha("B");

    const meta: StackMetadata = {
      version: 2,
      current_stack: "S",
      stacks: {
        S: {
          description: "",
          last_branch: "B",
          base: "main",
          branches: { A: { parent: "main" }, B: { parent: "A" } },
        },
      },
    };
    await writeMetadata(tmpDir, meta);

    await checkout(tmpDir, "B");
    const exitCode = await runExpectingExit(() => restack([]));

    // Refused with exit 1 — B untouched, no rebase started.
    expect(exitCode).toBe(1);
    expect(await rebaseInProgress()).toBe(false);
    expect(await sha("B")).toBe(bTipBefore);
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
