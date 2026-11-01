// A stack submitted in one worktree and then tracked in another keeps its PRs.
//
// Stack files live in each worktree's own git dir, but the `ghstack-pr` branch
// config is shared by all of them. The dependency sweep opens its PRs from a
// worktree, removes it, and runs `gh-stack add` in the main checkout. `add`
// used to create PR-less entries there, so `merge --base` refused ("has no
// PR") and `sync` could not see the bottom PR merge.
//
// Because that config is shared, each branch records the worktree that owns it
// (`ghstack-gitdir`), and a write in one worktree leaves the branches another
// live worktree is stacking alone (#64).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import {
  cleanup,
  createBranch,
  createGhStub,
  createTempRepo,
  ghStubEnv,
  makeCommit,
  setupRemote,
} from "./helpers.ts";

const cliPath = new URL("../index.ts", import.meta.url).pathname;

let tmpDir: string;
let remoteDir: string;
let stubDir: string;
let worktreeDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = await setupRemote(tmpDir);
  stubDir = await createGhStub();
  worktreeDir = `${tmpDir}.worktree`;
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, stubDir, worktreeDir);
});

async function runCli(cwd: string, args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd,
    env: { ...process.env, ...ghStubEnv(stubDir), GH_STACK_NO_COLOR: "1", GH_STACK_YES: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function trackedPrs(cwd: string): Promise<Record<string, number | null>> {
  const res = await runCli(cwd, ["stacks", "--json"]);
  const out: Record<string, number | null> = {};
  for (const stack of JSON.parse(res.stdout).stacks) {
    for (const b of stack.branches) out[b.branch] = b.pr;
  }
  return out;
}

describe("worktree handoff", () => {
  test("add in the main checkout keeps the PRs a worktree's submit opened", async () => {
    await $`git -C ${tmpDir} worktree add -q -b deps/sweep ${worktreeDir} main`.quiet();
    await makeCommit(worktreeDir, "safe.txt", "safe\n", "chore(deps): safe updates");
    await createBranch(worktreeDir, "deps/major", "deps/sweep");
    await makeCommit(worktreeDir, "major.txt", "major\n", "chore(deps)!: major upgrade");

    const submit = await runCli(worktreeDir, ["submit", "-t", "deps", "-b", "body"]);
    expect(submit.exitCode).toBe(0);
    expect(await trackedPrs(worktreeDir)).toEqual({ "deps/sweep": 101, "deps/major": 102 });

    await $`git -C ${tmpDir} worktree remove ${worktreeDir}`.quiet();
    const add = await runCli(tmpDir, ["add", "deps/major"]);
    expect(add.exitCode).toBe(0);

    expect(await trackedPrs(tmpDir)).toEqual({ "deps/sweep": 101, "deps/major": 102 });
    // The write after `add` must not have cleared the shared config either.
    expect((await $`git -C ${tmpDir} config branch.deps/sweep.ghstack-pr`.text()).trim()).toBe(
      "101",
    );
  });

  test("a branch with no recorded PR is still tracked without one", async () => {
    await createBranch(tmpDir, "wip", "main");
    await makeCommit(tmpDir, "wip.txt", "wip\n", "wip");

    expect((await runCli(tmpDir, ["add", "wip"])).exitCode).toBe(0);
    expect(await trackedPrs(tmpDir)).toEqual({ wip: null });
  });
});

/** One `ghstack-<field>` config value for a branch, or "" when unset. */
async function config(cwd: string, branch: string, field: string): Promise<string> {
  return (await $`git -C ${cwd} config branch.${branch}.ghstack-${field}`.quiet().nothrow())
    .text()
    .trim();
}

async function gitDirOf(cwd: string): Promise<string> {
  return (await $`git -C ${cwd} rev-parse --absolute-git-dir`.text()).trim();
}

describe("worktrees sharing branch config (#64)", () => {
  // main checkout stacks feat-a; a linked worktree stacks feat-b.
  async function twoWorktrees(): Promise<void> {
    await createBranch(tmpDir, "feat-a", "main");
    await makeCommit(tmpDir, "a.txt", "a\n", "feat: a");
    expect((await runCli(tmpDir, ["add", "feat-a"])).exitCode).toBe(0);

    await $`git -C ${tmpDir} worktree add -q -b feat-b ${worktreeDir} main`.quiet();
    await makeCommit(worktreeDir, "b.txt", "b\n", "feat: b");
    expect((await runCli(worktreeDir, ["add", "feat-b"])).exitCode).toBe(0);
  }

  test("a write in one worktree leaves the other's branch config alone", async () => {
    await twoWorktrees();
    // The worktree's `add` wrote, and the main checkout's branch kept its config.
    expect(await config(tmpDir, "feat-a", "stack")).toBe("feat-a");
    expect(await config(tmpDir, "feat-a", "gitdir")).toBe(await gitDirOf(tmpDir));
    expect(await config(tmpDir, "feat-b", "gitdir")).toBe(await gitDirOf(worktreeDir));

    const doctor = await runCli(tmpDir, ["doctor"]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain(
      "Left 1 branch(es) alone that another worktree is stacking: feat-b",
    );
    expect(await config(tmpDir, "feat-b", "stack")).toBe("feat-b");
    expect(await config(tmpDir, "feat-b", "id")).not.toBe("");
  });

  test("a branch renamed in one worktree after a write in the other is still recognized", async () => {
    await twoWorktrees();
    expect((await runCli(tmpDir, ["doctor"])).exitCode).toBe(0);

    await $`git -C ${worktreeDir} branch -m feat-b feat-b2`.quiet();
    expect(await trackedPrs(worktreeDir)).toEqual({ "feat-b2": null });
  });

  test("a removed worktree's config is cleared by the next write", async () => {
    await twoWorktrees();
    await $`git -C ${tmpDir} worktree remove ${worktreeDir}`.quiet();

    const doctor = await runCli(tmpDir, ["doctor"]);
    expect(doctor.stdout).toContain("1 stale membership(s) cleared");
    expect(await config(tmpDir, "feat-b", "stack")).toBe("");
    expect(await config(tmpDir, "feat-a", "stack")).toBe("feat-a");
  });

  test("so is the config of a worktree whose checkout was deleted without git", async () => {
    await twoWorktrees();
    await fs.rm(worktreeDir, { recursive: true, force: true }); // not pruned yet

    expect((await runCli(tmpDir, ["doctor"])).exitCode).toBe(0);
    expect(await config(tmpDir, "feat-b", "stack")).toBe("");
  });

  test("add takes a branch over from a worktree that's still around", async () => {
    await $`git -C ${tmpDir} worktree add -q -b deps/sweep ${worktreeDir} main`.quiet();
    await makeCommit(worktreeDir, "safe.txt", "safe\n", "chore(deps): safe updates");
    expect((await runCli(worktreeDir, ["submit", "-t", "deps", "-b", "body"])).exitCode).toBe(0);
    // The worktree moves to another branch so the main checkout can take it.
    await $`git -C ${worktreeDir} checkout -q --detach`.quiet();

    expect((await runCli(tmpDir, ["add", "deps/sweep"])).exitCode).toBe(0);
    expect(await config(tmpDir, "deps/sweep", "gitdir")).toBe(await gitDirOf(tmpDir));

    // The worktree still tracks it, and dropping it there doesn't clear the
    // config the main checkout now owns.
    expect((await runCli(worktreeDir, ["doctor"])).exitCode).toBe(0);
    const del = await runCli(worktreeDir, ["delete", "deps/sweep", "--keep-branch"]);
    expect(del.exitCode).toBe(0);
    expect(await config(tmpDir, "deps/sweep", "pr")).toBe("101");
    expect(await config(tmpDir, "deps/sweep", "gitdir")).toBe(await gitDirOf(tmpDir));
    expect(await trackedPrs(tmpDir)).toEqual({ "deps/sweep": 101 });
  });
});
