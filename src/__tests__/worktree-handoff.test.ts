// A stack submitted in one worktree and then tracked in another keeps its PRs.
//
// Stack files live in each worktree's own git dir, but the `ghstack-pr` branch
// config is shared by all of them. The dependency sweep opens its PRs from a
// worktree, removes it, and runs `gh-stack add` in the main checkout. `add`
// used to create PR-less entries there, so `merge --base` refused ("has no
// PR") and `sync` could not see the bottom PR merge.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
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
