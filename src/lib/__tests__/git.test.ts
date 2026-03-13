// Tests for git module — uses temp repos
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as git from "../git.ts";

let tmpDir: string;
let originalCwd: string;

async function createTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-test-"));

  await $`git init ${dir}`.quiet();
  await $`git -C ${dir} config user.email "test@test.com"`.quiet();
  await $`git -C ${dir} config user.name "Test"`.quiet();

  // Create initial commit on main
  await Bun.write(`${dir}/README.md`, "# Test\n");
  await $`git -C ${dir} add .`.quiet();
  await $`git -C ${dir} commit -m "initial commit"`.quiet();
  await $`git -C ${dir} branch -M main`.quiet();

  return dir;
}

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("currentBranch", () => {
  test("returns main on fresh repo", async () => {
    const branch = await git.currentBranch();
    expect(branch).toBe("main");
  });

  test("returns correct branch after checkout", async () => {
    await $`git checkout -b feature-1`.quiet();
    const branch = await git.currentBranch();
    expect(branch).toBe("feature-1");
  });
});

describe("isGitRepo", () => {
  test("returns true in a git repo", async () => {
    expect(await git.isGitRepo()).toBe(true);
  });

  test("returns false outside a git repo", async () => {
    const nonGitDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "non-git-"));
    process.chdir(nonGitDir);
    expect(await git.isGitRepo()).toBe(false);
    process.chdir(tmpDir);
    await fs.rm(nonGitDir, { recursive: true, force: true });
  });
});

describe("isCleanWorkingTree", () => {
  test("returns true on clean tree", async () => {
    expect(await git.isCleanWorkingTree()).toBe(true);
  });

  test("returns false with uncommitted changes", async () => {
    await Bun.write(`${tmpDir}/dirty.txt`, "dirty\n");
    await $`git add dirty.txt`.quiet();
    expect(await git.isCleanWorkingTree()).toBe(false);
  });
});

describe("mergeBase", () => {
  test("finds common ancestor", async () => {
    const mainSha = (await $`git rev-parse main`.text()).trim();

    await $`git checkout -b feature-1`.quiet();
    await Bun.write(`${tmpDir}/feature.txt`, "feature\n");
    await $`git add .`.quiet();
    await $`git commit -m "feature commit"`.quiet();

    const mb = await git.mergeBase("feature-1", "main");
    expect(mb).toBe(mainSha);
  });
});

describe("isAncestor", () => {
  test("returns true when ancestor", async () => {
    await $`git checkout -b feature-1`.quiet();
    await Bun.write(`${tmpDir}/feature.txt`, "feature\n");
    await $`git add .`.quiet();
    await $`git commit -m "feature commit"`.quiet();

    expect(await git.isAncestor("main", "feature-1")).toBe(true);
  });

  test("returns false when not ancestor", async () => {
    await $`git checkout -b feature-1`.quiet();
    await Bun.write(`${tmpDir}/feature.txt`, "feature\n");
    await $`git add .`.quiet();
    await $`git commit -m "feature commit"`.quiet();

    expect(await git.isAncestor("feature-1", "main")).toBe(false);
  });
});

describe("tags", () => {
  test("create and verify tag", async () => {
    const sha = (await $`git rev-parse HEAD`.text()).trim();
    await git.createTag("test-tag", sha);
    expect(await git.tagExists("test-tag")).toBe(true);
    expect(await git.tagExists("nonexistent")).toBe(false);
  });

  test("delete tags matching pattern", async () => {
    const sha = (await $`git rev-parse HEAD`.text()).trim();
    const tag1 = git.tempBaseTagName("feature/one");
    const tag2 = git.tempBaseTagName("feature/two");
    await git.createTag(tag1, sha);
    await git.createTag(tag2, sha);
    await git.createTag("other-tag", sha);

    await git.deleteTagsMatching(git.STACK_SYNC_TAG_GLOB);

    expect(await git.tagExists(tag1)).toBe(false);
    expect(await git.tagExists(tag2)).toBe(false);
    expect(await git.tagExists("other-tag")).toBe(true);
  });
});

describe("rebaseOnto", () => {
  test("successfully rebases branch", async () => {
    // Create two branches from main
    await $`git checkout -b feature-1`.quiet();
    await Bun.write(`${tmpDir}/f1.txt`, "feature 1\n");
    await $`git add .`.quiet();
    await $`git commit -m "f1"`.quiet();

    await $`git checkout main`.quiet();
    await Bun.write(`${tmpDir}/main-update.txt`, "main update\n");
    await $`git add .`.quiet();
    await $`git commit -m "main update"`.quiet();

    await $`git checkout -b feature-2`.quiet();
    await Bun.write(`${tmpDir}/f2.txt`, "feature 2\n");
    await $`git add .`.quiet();
    await $`git commit -m "f2"`.quiet();

    // Rebase feature-2 onto feature-1
    const mainSha = (await $`git merge-base feature-2 main`.text()).trim();
    const success = await git.rebaseOnto("feature-1", mainSha, "feature-2");

    expect(success).toBe(true);

    // feature-2 should now be a descendant of feature-1
    expect(await git.isAncestor("feature-1", "feature-2")).toBe(true);
  });
});

describe("tempBaseTagName", () => {
  test("includes a readable slug", () => {
    expect(git.tempBaseTagName("kiliman/feature-WEB-1234")).toContain(
      "stack-sync-base-kiliman-feature-web-123",
    );
  });

  test("is deterministic for the same branch", () => {
    expect(git.tempBaseTagName("simple-branch")).toBe(git.tempBaseTagName("simple-branch"));
  });

  test("avoids collisions for similarly normalized names", () => {
    expect(git.tempBaseTagName("foo/bar")).not.toBe(git.tempBaseTagName("foo_bar"));
  });
});
