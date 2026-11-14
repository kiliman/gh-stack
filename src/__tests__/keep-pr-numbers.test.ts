// #67: PR numbers were lost when a stack moved between worktrees.
//
// - Clearing a branch's membership (delete --keep-branch, or a removed
//   worktree's branches cleared by the next write) wiped its ghstack-pr too.
// - Only resolveOrCreateStack picked a recorded PR back up; add --parent didn't.
// - submit recorded the PRs it created only in its last write, so a run that
//   died after `gh pr create` left them unrecorded.
// - update-prs only worked from a checked-out branch of the stack.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import {
  checkout,
  cleanup,
  createBranch,
  createGhStub,
  createTempRepo,
  ghStubEnv,
  makeCommit,
  readMetadata,
  setupRemote,
  writeMetadata,
} from "./helpers.ts";
import type { Stack } from "../types.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let stubDir: string;
let remoteDir: string | undefined;

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...process.env,
      ...ghStubEnv(stubDir),
      NO_COLOR: "1",
      GH_STACK_NO_COLOR: "1",
      GH_STACK_YES: "1",
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, out: stdout + stderr };
}

async function config(key: string): Promise<string | null> {
  const r = await $`git -C ${tmpDir} config --get ${key}`.nothrow().quiet();
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

/** main → parent → child, tracked as stack "deps" with PRs #141 and #143. */
const DEPS: Stack = {
  description: "",
  last_branch: "child",
  base: "main",
  branches: {
    parent: { parent: "main", pr: 141 },
    child: { parent: "parent", pr: 143 },
  },
};

beforeEach(async () => {
  tmpDir = await createTempRepo();
  stubDir = await createGhStub();
  remoteDir = undefined;
  await createBranch(tmpDir, "parent", "main");
  await makeCommit(tmpDir, "parent.txt", "parent\n", "parent: commit");
  await createBranch(tmpDir, "child", "parent");
  await makeCommit(tmpDir, "child.txt", "child\n", "child: commit");
});

afterEach(async () => {
  await cleanup(tmpDir, stubDir, ...(remoteDir ? [remoteDir] : []));
});

describe("a branch that leaves its stack keeps its PR number", () => {
  test("delete --keep-branch keeps ghstack-pr, and add brings it back", async () => {
    await writeMetadata(tmpDir, { version: 2, current_stack: "deps", stacks: { deps: DEPS } });
    // Any write mirrors the stack into branch config.
    expect((await runCli(["doctor"])).exitCode).toBe(0);
    expect(await config("branch.child.ghstack-pr")).toBe("143");

    expect((await runCli(["delete", "child", "--keep-branch"])).exitCode).toBe(0);
    expect(await config("branch.child.ghstack-pr")).toBe("143");
    expect(await config("branch.child.ghstack-stack")).toBeNull();

    expect((await runCli(["add", "child"])).exitCode).toBe(0);
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["deps"]!.branches["child"]!.pr).toBe(143);
  });

  test("a removed worktree's branches keep their PRs through another worktree's writes", async () => {
    // What update-prs in a throwaway worktree leaves behind once it's removed.
    await $`git -C ${tmpDir} config branch.child.ghstack-stack sweep`.quiet();
    await $`git -C ${tmpDir} config branch.child.ghstack-parent parent`.quiet();
    await $`git -C ${tmpDir} config branch.child.ghstack-pr 143`.quiet();
    await $`git -C ${tmpDir} config branch.child.ghstack-gitdir /nonexistent/worktrees/gone`.quiet();

    // The main checkout tracks parent first: a write that clears child's membership.
    expect((await runCli(["add", "parent"])).exitCode).toBe(0);
    expect(await config("branch.child.ghstack-gitdir")).toBeNull();
    expect(await config("branch.child.ghstack-pr")).toBe("143");

    expect((await runCli(["add", "child"])).exitCode).toBe(0);
    const meta = await readMetadata(tmpDir);
    const stack = Object.values(meta.stacks).find((s) => s.branches["child"])!;
    expect(stack.branches["child"]!.pr).toBe(143);
  });

  test("add --parent picks up a PR recorded in git config", async () => {
    await $`git -C ${tmpDir} config branch.child.ghstack-pr 143`.quiet();

    expect((await runCli(["add", "child", "--parent", "parent"])).exitCode).toBe(0);
    const meta = await readMetadata(tmpDir);
    const stack = Object.values(meta.stacks).find((s) => s.branches["child"])!;
    expect(stack.branches["child"]!.pr).toBe(143);
  });
});

describe("submit records each PR as soon as it creates it", () => {
  test("a run killed after gh pr create still recorded the PR", async () => {
    remoteDir = await setupRemote(tmpDir);
    await checkout(tmpDir, "child");
    await writeMetadata(tmpDir, {
      version: 2,
      current_stack: "deps",
      stacks: {
        deps: {
          ...DEPS,
          branches: { parent: { parent: "main" }, child: { parent: "parent" } },
        },
      },
    });

    // The stub kills gh-stack at the first `gh pr edit` (title/viz updates),
    // which comes after both PRs are created and before the run's last write.
    const res = await runCli(["submit"], { GH_KILL_ON_EDIT: "1" });
    expect(res.exitCode).not.toBe(0);

    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["deps"]!.branches["parent"]!.pr).toBe(101);
    expect(meta.stacks["deps"]!.branches["child"]!.pr).toBe(102);
    expect(await config("branch.child.ghstack-pr")).toBe("102");
  });
});

describe("update-prs names its stack instead of needing a checkout", () => {
  beforeEach(async () => {
    await writeMetadata(tmpDir, {
      version: 2,
      current_stack: null,
      stacks: { deps: { ...DEPS, branches: { ...DEPS.branches, child: { parent: "parent" } } } },
    });
    // Detached HEAD on main: no branch of the stack is checked out.
    await $`git -C ${tmpDir} checkout -q --detach main`.quiet();
  });

  test("--stack <name> adopts a PR opened outside gh-stack", async () => {
    const res = await runCli(["update-prs", "--stack", "deps"], { GH_EXISTING_PR: "child=143" });
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Adopted PR #143 for child");
    expect((await readMetadata(tmpDir)).stacks["deps"]!.branches["child"]!.pr).toBe(143);
  });

  test("a branch argument finds its stack", async () => {
    const res = await runCli(["update-prs", "child"], { GH_EXISTING_PR: "child=143" });
    expect(res.exitCode).toBe(0);
    expect((await readMetadata(tmpDir)).stacks["deps"]!.branches["child"]!.pr).toBe(143);
  });

  test("with neither, a detached HEAD says how to name the stack", async () => {
    const res = await runCli(["update-prs"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("update-prs --stack <name>");
  });

  test("an unknown --stack is refused", async () => {
    const res = await runCli(["update-prs", "--stack", "nope"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("No active stack named nope");
  });
});
