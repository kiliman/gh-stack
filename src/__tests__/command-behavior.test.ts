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

describe("metadata tracking for display commands", () => {
  test("log does not overwrite last_branch when current branch is outside the stack", async () => {
    await createLinearStack(tmpDir);
    await createBranch(tmpDir, "scratch", "main");
    await checkout(tmpDir, "scratch");

    await log([]);

    const meta = await readMetadata(tmpDir);
    expect(meta.current_stack).toBe("test-stack");
    expect(meta.stacks["test-stack"]!.last_branch).toBe("pr3");
  });

  test("list does not overwrite last_branch when current branch is outside the stack", async () => {
    await createLinearStack(tmpDir);
    await createBranch(tmpDir, "scratch", "main");
    await checkout(tmpDir, "scratch");

    await list([]);

    const meta = await readMetadata(tmpDir);
    expect(meta.current_stack).toBe("test-stack");
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
          reviewEmojiStr: "✅",
        },
        {
          branch: "pr2",
          prNumber: 124,
          prTitle: "Frontend UI",
          prUrl: "https://github.com/acme/widgets/pull/124",
          reviewEmojiStr: "⏳",
        },
      ],
      1,
    );

    expect(viz).toContain('href="https://github.com/acme/widgets/pull/123"');
    expect(viz).toContain('href="https://github.com/acme/widgets/pull/124"');
    expect(viz).not.toContain("beehiiv/swarm");
  });

  test("defaults the base node to main", () => {
    const viz = buildStackViz(
      [
        { branch: "pr1", prNumber: 1, prTitle: "One", prUrl: null, reviewEmojiStr: "✅" },
        { branch: "pr2", prNumber: 2, prTitle: "Two", prUrl: null, reviewEmojiStr: "⏳" },
      ],
      0,
    );
    expect(viz).toContain("⚫ main");
  });

  test("renders a split stack's base branch (with PR link) instead of main", () => {
    const viz = buildStackViz(
      [
        { branch: "pr12", prNumber: 12, prTitle: "New work", prUrl: null, reviewEmojiStr: "⏳" },
        { branch: "pr13", prNumber: 13, prTitle: "More work", prUrl: null, reviewEmojiStr: "⏳" },
      ],
      0,
      { label: "pr11", prNumber: 11, prUrl: "https://github.com/acme/widgets/pull/11" },
    );
    // Base node points at PR11, not main.
    expect(viz).toContain('<a href="https://github.com/acme/widgets/pull/11">#11</a> pr11');
    expect(viz).not.toContain("⚫ main");
  });

  test("single-branch split stack links the base PR", () => {
    const viz = buildStackViz(
      [{ branch: "pr12", prNumber: 12, prTitle: "Solo", prUrl: null, reviewEmojiStr: "⏳" }],
      0,
      {
        label: "pr11",
        prNumber: 11,
        prUrl: null,
      },
    );
    expect(viz).toContain("#11 pr11");
    expect(viz).not.toContain("**main**");
  });
});
