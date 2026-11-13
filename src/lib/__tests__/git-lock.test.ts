// Lock contention (#69): git fails at once when another process holds
// index.lock (or config.lock). gh-stack's git writes wait and retry instead,
// and report a lock that never frees as a GitLockError, never as a conflict.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as git from "../git.ts";
import { getBranchMembership, setBranchMembership } from "../branch-config.ts";
import { cleanup, createTempRepo, makeCommit } from "../../__tests__/helpers.ts";

let tmpDir: string;
let originalCwd: string;
let indexLock: string;

// Short waits keep the suite fast: 50+100+200+400+800 ms ≈ 1.5 s in all.
const FAST = [50, 100, 200, 400, 800];

beforeEach(async () => {
  tmpDir = await createTempRepo();
  indexLock = `${tmpDir}/.git/index.lock`;
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  git.setLockRetryDelays(FAST);
});

afterEach(async () => {
  git.setLockRetryDelays(null);
  process.chdir(originalCwd);
  await cleanup(tmpDir);
});

/** Hold a lock file now and let it go after `ms`, like a background `git status`. */
async function holdLock(file: string, ms: number): Promise<void> {
  await Bun.write(file, "");
  setTimeout(() => fs.rm(file, { force: true }), ms);
}

/** main gains a commit; `feature` has two of its own, based on the old main. */
async function divergedFeature(): Promise<void> {
  await $`git checkout -q -b feature`.quiet();
  await makeCommit(tmpDir, "f1.txt", "1\n", "f1");
  await makeCommit(tmpDir, "f2.txt", "2\n", "f2");
  await $`git checkout -q main`.quiet();
  await makeCommit(tmpDir, "m.txt", "m\n", "m");
}

async function onMain(ref: string): Promise<boolean> {
  return git.isAncestor("main", ref);
}

describe("heldLock", () => {
  test("finds the lock in checkout's and rebase's messages", () => {
    expect(
      git.heldLock("fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git"),
    ).toBe("/r/.git/index.lock");
    expect(git.heldLock("error: Unable to create '.git/config.lock': File exists.")).toBe(
      ".git/config.lock",
    );
  });

  test("ignores other failures", () => {
    expect(git.heldLock("error: pathspec 'nope' did not match any file(s) known to git")).toBe(
      null,
    );
    expect(git.heldLock("CONFLICT (content): Merge conflict in a.txt")).toBe(null);
  });
});

describe("checkout", () => {
  test("waits out a briefly held index.lock", async () => {
    await $`git branch side`.quiet();
    await holdLock(indexLock, 250);
    await git.checkout("side");
    expect(await git.currentBranch()).toBe("side");
  });

  test("a lock that never frees is a GitLockError, and nothing moved", async () => {
    await $`git branch side`.quiet();
    await Bun.write(indexLock, "");
    const err = await git.checkout("side").catch((e) => e);
    expect(err).toBeInstanceOf(git.GitLockError);
    expect(err.lockPath).toEndWith("index.lock");
    expect(err.rebaseInProgress).toBe(false);
    expect(err.waitedMs).toBe(FAST.reduce((a, b) => a + b));
    expect(await git.currentBranch()).toBe("main");
  });

  test("other failures aren't retried", async () => {
    const started = Date.now();
    const { ok, stderr } = await git.tryCheckout("no-such-branch");
    expect(ok).toBe(false);
    expect(stderr).toContain("no-such-branch");
    expect(Date.now() - started).toBeLessThan(FAST[0]! * 2);
  });
});

describe("rebase", () => {
  test("a lock held when the rebase starts: runs it again", async () => {
    await divergedFeature();
    await $`git checkout -q feature`.quiet();
    await holdLock(indexLock, 250);
    expect(await git.rebaseOnto("main", "main~1", "feature")).toBe(true);
    expect(await onMain("feature")).toBe(true);
    expect(await git.isRebaseInProgress()).toBe(false);
  });

  test("a lock that turns up midway: continues the paused rebase", async () => {
    await divergedFeature();
    await $`git checkout -q feature`.quiet();
    // After the first pick, take index.lock once (as a background reader
    // would) and let it go shortly after. git reschedules the next pick and
    // pauses; the retry continues the rebase.
    const marker = `${tmpDir}/.git/lock-taken`;
    const takeLockOnce = `test -e ${marker} || { touch ${marker} ${indexLock}; }`;
    const release = setInterval(async () => {
      if (await Bun.file(indexLock).exists()) {
        clearInterval(release);
        setTimeout(() => fs.rm(indexLock, { force: true }), 250);
      }
    }, 10);
    try {
      expect(await git.runRebase(["rebase", "-x", takeLockOnce, "main"])).toBe(true);
    } finally {
      clearInterval(release);
    }
    expect(await Bun.file(marker).exists()).toBe(true); // the lock really was taken midway
    expect(await git.isRebaseInProgress()).toBe(false);
    expect(await onMain("feature")).toBe(true);
    expect(await git.commitCount("main", "feature")).toBe(2);
  });

  test("a lock that never frees midway: paused, not reported as a conflict", async () => {
    await divergedFeature();
    await $`git checkout -q feature`.quiet();
    const err = await git.runRebase(["rebase", "-x", `touch ${indexLock}`, "main"]).catch((e) => e);
    expect(err).toBeInstanceOf(git.GitLockError);
    expect(err.rebaseInProgress).toBe(true);
    await fs.rm(indexLock, { force: true });
    await $`git rebase --abort`.quiet();
  });

  test("a real conflict still returns false", async () => {
    await $`git checkout -q -b feature`.quiet();
    await makeCommit(tmpDir, "README.md", "feature\n", "feature edit");
    await $`git checkout -q main`.quiet();
    await makeCommit(tmpDir, "README.md", "main\n", "main edit");
    await $`git checkout -q feature`.quiet();
    expect(await git.rebase("main")).toBe(false);
    expect(await git.isRebaseInProgress()).toBe(true);
    await $`git rebase --abort`.quiet();
  });
});

describe("branch config", () => {
  test("a write waits out config.lock instead of being dropped", async () => {
    await holdLock(`${tmpDir}/.git/config.lock`, 250);
    await setBranchMembership("main", { stack: "s1", parent: "trunk-ish" });
    expect(await getBranchMembership("main")).toMatchObject({ stack: "s1", parent: "trunk-ish" });
  });
});

describe("isCleanWorkingTree", () => {
  test("a lock that never frees surfaces instead of reading as dirty", async () => {
    await Bun.write(indexLock, "");
    await expect(git.isCleanWorkingTree()).rejects.toBeInstanceOf(git.GitLockError);
  });
});
