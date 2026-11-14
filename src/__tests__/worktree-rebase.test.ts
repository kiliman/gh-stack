// #78: stack branches checked out in another worktree.
//
// git refuses to check out or rebase a branch that another worktree has checked
// out ("already used by worktree at …"), so restack and sync used to fail
// partway. Agent sessions then rebased by hand or detached the other worktree.
//
// gh-stack now rebases such a branch from its own worktree (`git -C <path>`),
// which moves that worktree's files along with the branch. That only works
// when the worktree is clean and not in the middle of a rebase or merge; if it
// isn't, the command stops before changing anything and names the worktree.
//
// main → pr1 → pr2 → pr3 (PRs #1-#3), with pr2 checked out in a second
// worktree. A second clone stands in for GitHub to squash-merge PR #1.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  checkout,
  cleanup,
  createBranch,
  createGhStub,
  createTempRepo,
  ghStubEnv,
  makeCommit,
  pushAllBranches,
  readMetadata,
  setupRemote,
  writeMetadata,
} from "./helpers.ts";
import * as gitLib from "../lib/git.ts";

setDefaultTimeout(60_000);

const cliPath = new URL("../index.ts", import.meta.url).pathname;

let tmpDir: string;
let remoteDir: string;
let githubDir: string;
let stubDir: string;
let worktreeDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  await createBranch(tmpDir, "pr1", "main");
  await makeCommit(tmpDir, "pr1.txt", "pr1\n", "pr1: add file");
  await createBranch(tmpDir, "pr2", "pr1");
  await makeCommit(tmpDir, "pr2.txt", "pr2\n", "pr2: add file");
  await createBranch(tmpDir, "pr3", "pr2");
  await makeCommit(tmpDir, "pr3.txt", "pr3\n", "pr3: add file");
  await writeMetadata(tmpDir, {
    version: 2,
    current_stack: "test-stack",
    stacks: {
      "test-stack": {
        description: "Test stack",
        last_branch: "pr3",
        branches: {
          pr1: { parent: "main", pr: 1, description: "PR 1" },
          pr2: { parent: "pr1", pr: 2, description: "PR 2" },
          pr3: { parent: "pr2", pr: 3, description: "PR 3" },
        },
      },
    },
  });
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);

  githubDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-github-"));
  await $`git clone -q ${remoteDir} ${githubDir}`.quiet();
  await git(githubDir, "config", "user.email", "gh@test");
  await git(githubDir, "config", "user.name", "GitHub");

  stubDir = await createGhStub();
  await writePr(1, { state: "OPEN", headRefName: "pr1", baseRefName: "main" });
  await writePr(2, { state: "OPEN", headRefName: "pr2", baseRefName: "pr1" });
  await writePr(3, { state: "OPEN", headRefName: "pr3", baseRefName: "pr2" });

  // Another session's worktree has pr2 checked out.
  worktreeDir = `${tmpDir}.worktree`;
  await checkout(tmpDir, "pr1");
  await git(tmpDir, "worktree", "add", "-q", worktreeDir, "pr2");
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, githubDir, stubDir, worktreeDir);
});

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${dir} ${args}`.text()).trim();
}

async function writePr(n: number, data: Record<string, unknown>): Promise<void> {
  await Bun.write(
    `${stubDir}/${n}.json`,
    JSON.stringify({ number: n, title: `PR ${n}`, url: `https://x/${n}`, ...data }),
  );
}

async function runCli(args: string[], cwd = tmpDir) {
  const base = { ...process.env } as Record<string, string>;
  delete base.GH_STACK_NO_PUSH;
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd,
    env: {
      ...base,
      ...ghStubEnv(stubDir),
      GH_PR_VIEW_DIR: stubDir,
      NO_COLOR: "1",
      GH_STACK_NO_COLOR: "1",
      GH_STACK_YES: "1",
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

/** The branch tips, to show a refused command moved nothing. */
async function tips(): Promise<string[]> {
  return Promise.all(["pr1", "pr2", "pr3"].map((b) => git(tmpDir, "rev-parse", b)));
}

async function isAncestor(ancestor: string, descendant: string): Promise<boolean> {
  const { exitCode } = await $`git -C ${tmpDir} merge-base --is-ancestor ${ancestor} ${descendant}`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

/** The worktree still has pr2 checked out, at the rebased tip, with nothing left over. */
async function expectWorktreeFollowed(): Promise<void> {
  expect(await git(worktreeDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pr2");
  expect(await git(worktreeDir, "rev-parse", "HEAD")).toBe(await git(tmpDir, "rev-parse", "pr2"));
  expect(await git(worktreeDir, "status", "--porcelain")).toBe("");
}

/** On "GitHub": squash PR #1 into main and record it as merged. */
async function mergePr1OnGithub(): Promise<void> {
  await git(githubDir, "checkout", "-q", "main");
  await git(githubDir, "fetch", "-q", "origin", "pr1");
  await git(githubDir, "merge", "-q", "--squash", "origin/pr1");
  await git(githubDir, "commit", "-q", "-m", "pr1 (#1)");
  await git(githubDir, "push", "-q", "origin", "main");
  const sha = await git(githubDir, "rev-parse", "HEAD");
  await writePr(1, {
    state: "MERGED",
    headRefName: "pr1",
    baseRefName: "main",
    mergeCommit: { oid: sha },
    mergedAt: "2026-11-13T10:00:00Z",
  });
}

describe("restack with a branch checked out in another worktree (#78)", () => {
  test("rebases it from its own worktree, which follows the branch", async () => {
    await makeCommit(tmpDir, "pr1-more.txt", "more\n", "pr1: more");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain(`in its worktree at ${worktreeDir}`);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    await expectWorktreeFollowed();
    expect(await Bun.file(`${worktreeDir}/pr1-more.txt`).exists()).toBe(true);
    // Pushed, like any other rebased branch.
    expect(await git(remoteDir, "rev-parse", "refs/heads/pr2")).toBe(
      await git(tmpDir, "rev-parse", "pr2"),
    );
    // This worktree never took pr2 from the other one.
    expect(await git(worktreeDir, "worktree", "list", "--porcelain")).toContain(
      `worktree ${worktreeDir}\nHEAD ${await git(tmpDir, "rev-parse", "pr2")}\nbranch refs/heads/pr2`,
    );
  });

  test("a branch with no commits of its own is moved in its worktree too", async () => {
    // pr2 becomes an empty placeholder on pr1, then pr1 moves on.
    await git(worktreeDir, "reset", "-q", "--hard", "pr1");
    await makeCommit(tmpDir, "pr1-more.txt", "more\n", "pr1: more");

    const res = await runCli(["restack", "--no-push"]);

    expect(res.exitCode).toBe(0);
    expect(await git(tmpDir, "rev-parse", "pr2")).toBe(await git(tmpDir, "rev-parse", "pr1"));
    await expectWorktreeFollowed();
  });

  test("stops before changing anything when that worktree has uncommitted changes", async () => {
    await makeCommit(tmpDir, "pr1-more.txt", "more\n", "pr1: more");
    await Bun.write(`${worktreeDir}/pr2.txt`, "work in progress\n");
    const before = await tips();
    const pr1OnOrigin = await git(remoteDir, "rev-parse", "refs/heads/pr1");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Stopped before changing anything");
    // Checked up front: not even pr1's new commit was pushed.
    expect(await git(remoteDir, "rev-parse", "refs/heads/pr1")).toBe(pr1OnOrigin);
    expect(res.out).toContain("pr2");
    expect(res.out).toContain(worktreeDir);
    expect(res.out).toContain("uncommitted changes");
    expect(await tips()).toEqual(before);
    expect(await Bun.file(`${worktreeDir}/pr2.txt`).text()).toBe("work in progress\n");
  });

  test("stops before changing anything when that worktree is mid-rebase", async () => {
    await makeCommit(tmpDir, "pr1-more.txt", "more\n", "pr1: more");
    // A clean worktree paused at an `edit` step: nothing uncommitted, but busy.
    await $`git -C ${worktreeDir} rebase -q -i HEAD~1`
      .env({ ...process.env, GIT_SEQUENCE_EDITOR: "sed -i.bak s/^pick/edit/" })
      .quiet();
    const before = await tips();

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain(worktreeDir);
    expect(res.out).toContain("in the middle of a rebase");
    expect(await tips()).toEqual(before);
  });

  test("a conflict stops in that worktree; resolve it there, then --resume finishes", async () => {
    // pr1 now writes pr2.txt too, so replaying pr2 is an add/add conflict.
    await makeCommit(tmpDir, "pr2.txt", "pr1's version\n", "pr1: claims pr2.txt");

    const stopped = await runCli(["restack"]);

    expect(stopped.exitCode).toBe(2);
    expect(stopped.out).toContain(`git -C ${worktreeDir} rebase --continue`);
    expect(stopped.out).toContain(`git -C ${worktreeDir} rebase --abort`);
    // The rebase is paused over there, not here.
    expect(await git(worktreeDir, "status")).toContain("rebase in progress");
    expect(await git(tmpDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pr1");

    // A resume while it's still paused is refused, naming the worktree.
    const early = await runCli(["restack", "--resume"]);
    expect(early.exitCode).toBe(1);
    expect(early.out).toContain(worktreeDir);
    expect(early.out).toContain(`git -C ${worktreeDir} rebase --continue`);
    expect(early.out).not.toContain("didn't happen");

    await Bun.write(`${worktreeDir}/pr2.txt`, "merged\n");
    await git(worktreeDir, "add", "pr2.txt");
    await $`git -C ${worktreeDir} rebase --continue`
      .env({ ...process.env, GIT_EDITOR: "true" })
      .quiet();

    const resumed = await runCli(["restack", "--resume"]);

    expect(resumed.exitCode).toBe(0);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    await expectWorktreeFollowed();
  });
});

describe("sync with a branch checked out in another worktree (#78)", () => {
  test("re-roots it onto main from its own worktree after the bottom PR merges", async () => {
    await mergePr1OnGithub();
    await checkout(tmpDir, "pr3");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    await git(tmpDir, "fetch", "-q", "origin");
    expect(await isAncestor("origin/main", "pr2")).toBe(true);
    expect(await git(tmpDir, "rev-list", "--count", "origin/main..pr2")).toBe("1");
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    await expectWorktreeFollowed();
    expect(await Bun.file(`${stubDir}/calls.log`).text()).toContain("pr edit 2 --base main");
    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks["test-stack"]!.branches)).toEqual(["pr2", "pr3"]);
  });

  test("stops before changing anything when that worktree has uncommitted changes", async () => {
    await mergePr1OnGithub();
    await checkout(tmpDir, "pr3");
    await Bun.write(`${worktreeDir}/pr2.txt`, "work in progress\n");
    const before = await tips();

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Stopped before changing anything");
    expect(res.out).toContain(worktreeDir);
    expect(res.out).toContain("uncommitted changes");
    expect(await tips()).toEqual(before);
    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks["test-stack"]!.branches)).toEqual(["pr1", "pr2", "pr3"]);
  });

  test("a re-root conflict stops in that worktree; resolve it there and re-run sync", async () => {
    await mergePr1OnGithub();
    // main gets its own pr2.txt, so re-rooting pr2 is an add/add conflict.
    await Bun.write(`${githubDir}/pr2.txt`, "main's version\n");
    await git(githubDir, "add", "pr2.txt");
    await git(githubDir, "commit", "-q", "-m", "main: its own pr2.txt");
    await git(githubDir, "push", "-q", "origin", "main");
    await checkout(tmpDir, "pr3");

    const stopped = await runCli(["sync"]);

    expect(stopped.exitCode).toBe(2);
    expect(stopped.out).toContain(`It stopped in the worktree at ${worktreeDir}`);
    expect(stopped.out).toContain(`git -C ${worktreeDir} rebase --continue`);
    expect(await git(worktreeDir, "status")).toContain("rebase in progress");

    await Bun.write(`${worktreeDir}/pr2.txt`, "merged\n");
    await git(worktreeDir, "add", "pr2.txt");
    await $`git -C ${worktreeDir} rebase --continue`
      .env({ ...process.env, GIT_EDITOR: "true" })
      .quiet();
    const finished = await runCli(["sync"]);

    expect(finished.exitCode).toBe(0);
    await git(tmpDir, "fetch", "-q", "origin");
    expect(await isAncestor("origin/main", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    await expectWorktreeFollowed();
  });

  test("a worktree whose folder is gone is named, with the prune that frees it", async () => {
    await mergePr1OnGithub();
    await checkout(tmpDir, "pr3");
    await fs.rm(worktreeDir, { recursive: true, force: true });
    const before = await tips();

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Stopped before changing anything");
    expect(res.out).toContain(worktreeDir);
    expect(res.out).toContain("git worktree prune");
    expect(await tips()).toEqual(before);
  });
});

describe("the check right before a rewrite in another worktree (#78)", () => {
  test("rebaseBranch refuses a worktree that turned dirty, and changes nothing", async () => {
    await makeCommit(tmpDir, "pr1-more.txt", "more\n", "pr1: more");
    await Bun.write(`${worktreeDir}/pr2.txt`, "work in progress\n");
    const before = await tips();
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const attempt = gitLib.rebaseBranch("pr2", "pr1", null);
      await expect(attempt).rejects.toBeInstanceOf(gitLib.WorktreeBusyError);
      const reset = gitLib.resetBranch("pr2", "pr1");
      await expect(reset).rejects.toBeInstanceOf(gitLib.WorktreeBusyError);
    } finally {
      process.chdir(cwd);
    }
    expect(await tips()).toEqual(before);
    expect(await Bun.file(`${worktreeDir}/pr2.txt`).text()).toBe("work in progress\n");
  });
});

describe("navigating to a branch checked out in another worktree (#78)", () => {
  test("up names the worktree instead of git's bare refusal", async () => {
    const res = await runCli(["up"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain(`pr2 is checked out in the worktree at ${worktreeDir}`);
    expect(await git(tmpDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pr1");
  });
});
