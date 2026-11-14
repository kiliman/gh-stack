// A parent rebased OUTSIDE gh-stack (a plain `git rebase origin/main`) leaves
// no snapshot of its old tip, so restack used to fall back to
// merge-base(child, parent) — the old main — and replay the parent's own
// commits onto their rebased copies (issue #83). The old tip is still in the
// parent's reflog; the boundary must come from there.
//
// Shape: main → A → B. A is rebased onto an advanced main with plain git, then
// gets a new commit that edits the file its first commit added — so replaying
// that first commit onto the new A is an add/add conflict, exactly as in the
// swarm session that filed the issue.
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
import type { StackMetadata, Snapshot } from "../types.ts";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  setAutoYes(true);
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

async function seed(snapshots: Snapshot[] = []): Promise<void> {
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
    snapshots,
  };
  await writeMetadata(tmpDir, meta);
}

// main advances, A is rebased onto it with plain git, then A gets a commit
// that rewrites a.txt (the file A's first commit added).
async function rebaseParentOutside(): Promise<void> {
  await checkout(tmpDir, "main");
  await makeCommit(tmpDir, "main-new.txt", "new\n", "main: advance");
  await $`git -C ${tmpDir} rebase main A`.quiet();
  await makeCommit(tmpDir, "a.txt", "a, reworked\n", "A: rework a.txt");
}

describe("restack after the parent was rebased outside gh-stack (#83)", () => {
  test("replays only the child's own commits, without conflict", async () => {
    await createBranch(tmpDir, "A", "main");
    await makeCommit(tmpDir, "a.txt", "a\n", "A: add a.txt");
    await createBranch(tmpDir, "B", "A");
    await makeCommit(tmpDir, "b.txt", "b\n", "B: add b.txt");
    await makeCommit(tmpDir, "b2.txt", "b2\n", "B: add b2.txt");
    const oldParentTip = await sha("A");
    await seed();
    await rebaseParentOutside();

    const m = (await readLibMetadata())!;
    expect(await resolveRestackBoundary(m, "A", "B")).toEqual({
      sha: oldParentTip,
      source: "reflog",
    });

    await checkout(tmpDir, "B");
    await restack([]);

    expect(await rebaseInProgress()).toBe(false);
    expect(await count("A..B")).toBe(2);
    expect(await Bun.file(`${tmpDir}/a.txt`).text()).toBe("a, reworked\n");
    expect(await Bun.file(`${tmpDir}/main-new.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/b2.txt`).exists()).toBe(true);
  });

  test("a stale snapshot loses to the parent's newer former tip", async () => {
    // gh-stack last ran while A had one commit; A then got a second commit with
    // plain git, B was built on it, and only then was A rebased outside.
    await createBranch(tmpDir, "A", "main");
    await makeCommit(tmpDir, "a.txt", "a\n", "A: add a.txt");
    const staleTip = await sha("A");
    await makeCommit(tmpDir, "a.txt", "a, second\n", "A: second pass on a.txt");
    const oldParentTip = await sha("A");
    await createBranch(tmpDir, "B", "A");
    await makeCommit(tmpDir, "b.txt", "b\n", "B: add b.txt");
    await seed([
      {
        timestamp: "2026-11-01T00:00:00.000Z",
        operation: "submit",
        stack: "S",
        branches: { A: staleTip },
      },
    ]);
    await rebaseParentOutside();

    const m = (await readLibMetadata())!;
    expect(await resolveRestackBoundary(m, "A", "B")).toEqual({
      sha: oldParentTip,
      source: "reflog",
    });

    await checkout(tmpDir, "B");
    await restack([]);

    expect(await rebaseInProgress()).toBe(false);
    expect(await count("A..B")).toBe(1);
    expect(await Bun.file(`${tmpDir}/a.txt`).text()).toBe("a, reworked\n");
  });

  test("a tip the parent retreated from is never a boundary", async () => {
    // The wrong-branch fix: the child's work was committed on A, B was cut at
    // that commit, and A was moved back one. A's reflog now holds B's own tip;
    // trusting it would make B look empty and reset it onto A.
    await createBranch(tmpDir, "A", "main");
    const aTip = await makeCommit(tmpDir, "a.txt", "a\n", "A: add a.txt");
    await makeCommit(tmpDir, "c.txt", "c\n", "B's work, committed on A by mistake");
    await $`git -C ${tmpDir} branch B`.quiet();
    await $`git -C ${tmpDir} reset -q --hard HEAD~1`.quiet();
    await seed();
    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "main-new.txt", "new\n", "main: advance");
    await $`git -C ${tmpDir} rebase main A`.quiet();

    // The walk skips B's tip (A retreated from it) and stops at A's real old
    // tip, one below: B replays exactly its own commit.
    const m = (await readLibMetadata())!;
    expect(await resolveRestackBoundary(m, "A", "B")).toEqual({ sha: aTip, source: "reflog" });

    await checkout(tmpDir, "B");
    await restack([]);

    expect(await rebaseInProgress()).toBe(false);
    expect(await count("A..B")).toBe(1);
    expect(await Bun.file(`${tmpDir}/c.txt`).exists()).toBe(true);
  });

  test("a lower reflog tip never overrides a higher snapshot", async () => {
    // gh-stack recorded A at its second commit and B was built there; then A
    // was moved back off that commit (so the reflog skips it as a retreat) and
    // rebased. The snapshot still knows B starts above it. The reflog's best
    // is one lower, and taking it would replay the dropped commit into B.
    await createBranch(tmpDir, "A", "main");
    await makeCommit(tmpDir, "a.txt", "a\n", "A: add a.txt");
    const recordedTip = await makeCommit(tmpDir, "a2.txt", "a2\n", "A: a2, dropped later");
    await createBranch(tmpDir, "B", "A");
    await makeCommit(tmpDir, "b.txt", "b\n", "B: add b.txt");
    await seed([
      {
        timestamp: "2026-11-01T00:00:00.000Z",
        operation: "submit",
        stack: "S",
        branches: { A: recordedTip },
      },
    ]);
    await checkout(tmpDir, "A");
    await $`git -C ${tmpDir} reset -q --hard HEAD~1`.quiet();
    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "main-new.txt", "new\n", "main: advance");
    await $`git -C ${tmpDir} rebase main A`.quiet();

    const m = (await readLibMetadata())!;
    expect(await resolveRestackBoundary(m, "A", "B")).toEqual({
      sha: recordedTip,
      source: "snapshot",
    });

    await checkout(tmpDir, "B");
    await restack([]);

    expect(await rebaseInProgress()).toBe(false);
    expect(await count("A..B")).toBe(1);
    expect(await Bun.file(`${tmpDir}/a2.txt`).exists()).toBe(false);
  });

  test("the reflog never stands alone: no shared history still refuses", async () => {
    // A was replaced by an unrelated history. B still sits on A's old tip, and
    // the reflog knows it, but with no merge-base and no snapshot there is no
    // boundary to raise, so restack refuses as it always has (#30).
    await createBranch(tmpDir, "A", "main");
    await makeCommit(tmpDir, "a.txt", "a\n", "A: add a.txt");
    await createBranch(tmpDir, "B", "A");
    await makeCommit(tmpDir, "b.txt", "b\n", "B: add b.txt");
    const bTip = await sha("B");
    await $`git -C ${tmpDir} checkout -q --orphan fresh`.quiet();
    await $`git -C ${tmpDir} rm -rqf .`.quiet();
    await makeCommit(tmpDir, "other.txt", "other\n", "an unrelated history");
    await $`git -C ${tmpDir} branch -f A fresh`.quiet();
    await seed();

    const m = (await readLibMetadata())!;
    expect(await resolveRestackBoundary(m, "A", "B")).toBeNull();

    await checkout(tmpDir, "B");
    expect(await runExpectingExit(() => restack([]))).toBe(1);
    expect(await rebaseInProgress()).toBe(false);
    expect(await sha("B")).toBe(bTip);
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
