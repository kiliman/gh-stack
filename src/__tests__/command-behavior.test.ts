import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  checkout,
  cleanup,
  createBranch,
  createLinearStack,
  createTempRepo,
  readMetadata,
} from "./helpers.ts";
import restack from "../commands/restack.ts";
import sync from "../commands/sync.ts";
import show from "../commands/show.ts";
import list from "../commands/list.ts";
import { buildStackViz } from "../commands/update-prs.ts";
import { STACK_SYNC_TAG_GLOB } from "../lib/git.ts";

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
});

describe("metadata tracking for display commands", () => {
  test("show does not overwrite last_branch when current branch is outside the stack", async () => {
    await createLinearStack(tmpDir);
    await createBranch(tmpDir, "scratch", "main");
    await checkout(tmpDir, "scratch");

    await show([]);

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
});
