import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  checkout,
  cleanup,
  createBranch,
  createLinearStack,
  createTempRepo,
  makeCommit,
  metadataExists,
  readMetadata,
} from "./helpers.ts";
import restack from "../commands/restack.ts";
import sync from "../commands/sync.ts";
import merge from "../commands/merge.ts";
import submit from "../commands/submit.ts";
import log from "../commands/log.ts";
import list from "../commands/list.ts";
import { buildStackViz } from "../commands/update-prs.ts";
import { STACK_SYNC_TAG_GLOB } from "../lib/git.ts";
import { getCurrentBranch, getSha } from "./helpers.ts";

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

describe("command dry-run safety", () => {
  test("restack --dry-run does not create snapshots or temp tags", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr2");

    await restack(["--dry-run"]);

    const meta = await readMetadata(tmpDir);
    expect(meta.snapshots).toBeUndefined();

    const tags = (await $`git tag -l ${STACK_SYNC_TAG_GLOB}`.text()).trim();
    expect(tags).toBe("");
  });

  test("sync --dry-run does not create snapshots or temp tags", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr1");

    await sync(["--dry-run"]);

    const meta = await readMetadata(tmpDir);
    expect(meta.snapshots).toBeUndefined();

    const tags = (await $`git tag -l ${STACK_SYNC_TAG_GLOB}`.text()).trim();
    expect(tags).toBe("");
  });

  test("merge --dry-run does not change refs or metadata", async () => {
    const { shas } = await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");

    await merge(["--dry-run"]);

    const meta = await readMetadata(tmpDir);
    expect(meta.snapshots).toBeUndefined();
    expect(meta.archive).toBeUndefined();
    expect(await getCurrentBranch(tmpDir)).toBe("pr3");
    expect(await getSha(tmpDir, "pr1")).toBe(shas.pr1!);
    expect(await getSha(tmpDir, "pr2")).toBe(shas.pr2!);
    expect(await getSha(tmpDir, "pr3")).toBe(shas.pr3!);
  });

  test("merge --collapse --dry-run does not change refs, metadata, or archive", async () => {
    const { shas } = await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");

    await merge(["--collapse", "--dry-run"]);

    const meta = await readMetadata(tmpDir);
    expect(meta.snapshots).toBeUndefined();
    expect(meta.archive).toBeUndefined();
    // Stack must remain in stacks (not archived) — that's the whole point of collapse
    expect(meta.stacks["test-stack"]).toBeDefined();
    expect(await getCurrentBranch(tmpDir)).toBe("pr3");
    expect(await getSha(tmpDir, "pr1")).toBe(shas.pr1!);
    expect(await getSha(tmpDir, "pr2")).toBe(shas.pr2!);
    expect(await getSha(tmpDir, "pr3")).toBe(shas.pr3!);
  });

  test("merge --stop-at-base is an alias for --collapse", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");

    // Just verify it runs without error and behaves like --collapse
    await merge(["--stop-at-base", "--dry-run"]);

    const meta = await readMetadata(tmpDir);
    expect(meta.archive).toBeUndefined();
    expect(meta.stacks["test-stack"]).toBeDefined();
  });

  test("submit --dry-run self-heals a bare chain without writing metadata", async () => {
    // Bare local chain main → a → b → c, no metadata, no remotes
    await createBranch(tmpDir, "a", "main");
    await makeCommit(tmpDir, "a.txt", "a\n", "a: commit");
    await createBranch(tmpDir, "b", "a");
    await makeCommit(tmpDir, "b.txt", "b\n", "b: commit");
    await createBranch(tmpDir, "c", "b");
    await makeCommit(tmpDir, "c.txt", "c\n", "c: commit");
    await checkout(tmpDir, "c");

    // No metadata exists yet
    expect(await metadataExists(tmpDir)).toBe(false);

    await submit(["--dry-run"]);

    // Dry-run must not persist anything
    expect(await metadataExists(tmpDir)).toBe(false);
    // Still on the same branch, nothing checked out/pushed
    expect(await getCurrentBranch(tmpDir)).toBe("c");
  });
});

// Run `fn`, swallowing an intentional `process.exit` so it doesn't kill the
// test runner. Rethrows any other error.
async function runExpectingExit(fn: () => Promise<void>): Promise<void> {
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`__process_exit__${code ?? 0}`);
  }) as never;
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("__process_exit__")) throw err;
  } finally {
    process.exit = origExit;
  }
}

describe("metadata tracking for display commands", () => {
  // The current stack is derived from the branch you're on, never a sticky
  // stored hint. Standing on a branch that's in no stack (here: `scratch` off
  // main) means there is NO current stack — `log`/`list` report "not in any
  // stack" and exit rather than resurfacing a remembered one. They must also
  // leave the untouched stack's `last_branch` intact.

  test("log reports out-of-stack instead of resurfacing the last stack, leaving last_branch intact", async () => {
    await createLinearStack(tmpDir);
    await createBranch(tmpDir, "scratch", "main");
    await checkout(tmpDir, "scratch");

    // Exits via the "not in any stack" path rather than rendering test-stack.
    await runExpectingExit(() => log([]));

    // Early exit means no write — the stack's last_branch is untouched.
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.last_branch).toBe("pr3");
  });

  test("list reports out-of-stack instead of resurfacing the last stack, leaving last_branch intact", async () => {
    await createLinearStack(tmpDir);
    await createBranch(tmpDir, "scratch", "main");
    await checkout(tmpDir, "scratch");

    await runExpectingExit(() => list([]));

    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.last_branch).toBe("pr3");
  });
});

describe("buildStackViz", () => {
  test("uses PR URLs from GitHub instead of a hardcoded repository path", () => {
    const viz = buildStackViz(
      [
        {
          branch: "pr1",
          prNumber: 123,
          prTitle: "Backend models",
          prUrl: "https://github.com/acme/widgets/pull/123",
        },
        {
          branch: "pr2",
          prNumber: 124,
          prTitle: "Frontend UI",
          prUrl: "https://github.com/acme/widgets/pull/124",
        },
      ],
      1,
    );

    expect(viz).toContain('href="https://github.com/acme/widgets/pull/123"');
    expect(viz).toContain('href="https://github.com/acme/widgets/pull/124"');
    expect(viz).not.toContain("beehiiv/swarm");
  });

  test("numbers each branch by its stack position and omits review emoji", () => {
    const viz = buildStackViz(
      [
        { branch: "pr1", prNumber: 123, prTitle: "Backend models", prUrl: null },
        { branch: "pr2", prNumber: 124, prTitle: "Frontend UI", prUrl: null },
      ],
      1,
    );

    // 1-based stack index prefixes each line.
    expect(viz).toContain("1. #123 Backend models");
    expect(viz).toContain("2. #124 Frontend UI 👈");
    // Review/CI status is intentionally not rendered (tracked out-of-band).
    expect(viz).not.toContain("✅");
    expect(viz).not.toContain("⏳");
    expect(viz).not.toContain("👀");
  });

  test("defaults the base node to main", () => {
    const viz = buildStackViz(
      [
        { branch: "pr1", prNumber: 1, prTitle: "One", prUrl: null },
        { branch: "pr2", prNumber: 2, prTitle: "Two", prUrl: null },
      ],
      0,
    );
    expect(viz).toContain("⚫ main");
  });

  test("renders a split stack's base branch (with PR link) instead of main", () => {
    const viz = buildStackViz(
      [
        { branch: "pr12", prNumber: 12, prTitle: "New work", prUrl: null },
        { branch: "pr13", prNumber: 13, prTitle: "More work", prUrl: null },
      ],
      0,
      { label: "pr11", prNumber: 11, prUrl: "https://github.com/acme/widgets/pull/11" },
    );
    // Base node points at PR11, not main.
    expect(viz).toContain('<a href="https://github.com/acme/widgets/pull/11">#11</a> pr11');
    expect(viz).not.toContain("⚫ main");
  });

  test("single-branch split stack links the base PR", () => {
    const viz = buildStackViz([{ branch: "pr12", prNumber: 12, prTitle: "Solo", prUrl: null }], 0, {
      label: "pr11",
      prNumber: 11,
      prUrl: null,
    });
    expect(viz).toContain("#11 pr11");
    expect(viz).not.toContain("**main**");
  });

  // The submit fast-path (#16) skips a PR's PATCH when the rendered block is
  // byte-identical to last time. These guard the two invariants that makes
  // that hash-skip safe and correct.
  test("is deterministic for identical inputs (enables hash-skip)", () => {
    const branches = [
      { branch: "pr1", prNumber: 1, prTitle: "One", prUrl: null },
      { branch: "pr2", prNumber: 2, prTitle: "Two", prUrl: null },
    ];
    expect(buildStackViz(branches, 0)).toBe(buildStackViz(branches, 0));
  });

  test("adding a branch changes existing PRs' rendered block (forces re-PATCH)", () => {
    const before = [
      { branch: "pr1", prNumber: 1, prTitle: "One", prUrl: null },
      { branch: "pr2", prNumber: 2, prTitle: "Two", prUrl: null },
    ];
    const after = [...before, { branch: "pr3", prNumber: 3, prTitle: "Three", prUrl: null }];

    // PR1's block (targetIndex 0) must differ once a new tip joins the stack,
    // so its cached hash misses and it gets the updated tree.
    expect(buildStackViz(after, 0)).not.toBe(buildStackViz(before, 0));
    expect(buildStackViz(after, 0)).toContain("3. #3 Three");
  });
});
