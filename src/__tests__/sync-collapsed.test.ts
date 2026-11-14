// #81: `merge` collapses the upper PRs into the base on GitHub (PR #3 squashed
// into c1, PR #2 into base), then stops because the base conflicts with main
// and advises `gh-stack sync`. Those children are done: their content sits on
// origin/base as squash commits. Sync used to restack them anyway, replaying
// their own commits onto a base that already holds them squashed, so the same
// changes conflicted with themselves.
//
// c1 and c2 each have two commits that write their file differently, so a
// replay of the first commit onto a base holding the final file is an add/add
// conflict, as it is for real multi-commit PRs.
//
// A second clone stands in for GitHub: it squash-merges PRs and pushes, and a
// fake `gh` serves each PR's state from $GH_PR_DIR/N.json.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  checkout,
  cleanup,
  createBranch,
  createTempRepo,
  getCurrentBranch,
  makeCommit,
  pushAllBranches,
  readMetadata,
  setupRemote,
  writeMetadata,
} from "./helpers.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let otherDir: string;
let binDir: string;

const branches = {
  base: { parent: "main", pr: 1, description: "PR 1" },
  c1: { parent: "base", pr: 2, description: "PR 2" },
  c2: { parent: "c1", pr: 3, description: "PR 3" },
};

beforeEach(async () => {
  tmpDir = await createTempRepo();
  // main → base → c1 (two commits) → c2 (two commits), PRs #1-#3.
  await createBranch(tmpDir, "base", "main");
  await makeCommit(tmpDir, "base.txt", "base\n", "base: add file");
  await createBranch(tmpDir, "c1", "base");
  await makeCommit(tmpDir, "c1.txt", "draft\n", "c1: first draft");
  await makeCommit(tmpDir, "c1.txt", "final\n", "c1: final version");
  await createBranch(tmpDir, "c2", "c1");
  await makeCommit(tmpDir, "c2.txt", "draft\n", "c2: first draft");
  await makeCommit(tmpDir, "c2.txt", "final\n", "c2: final version");
  remoteDir = await setupRemote(tmpDir);
  otherDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-github-"));
  binDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-fakegh-"));
  await installGhStub();
  await writePr(1, { state: "OPEN", headRefName: "base", baseRefName: "main" });
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, otherDir, binDir);
});

/** Write the metadata, push everything, and clone "GitHub". */
async function publish(extra: Record<string, { parent: string; pr: number; description: string }>) {
  await writeMetadata(tmpDir, {
    version: 2,
    current_stack: "test-stack",
    stacks: {
      "test-stack": {
        description: "Test stack",
        last_branch: Object.keys(extra).at(-1) ?? "c2",
        branches: { ...branches, ...extra },
      },
    },
  });
  await pushAllBranches(tmpDir);
  await $`git clone -q ${remoteDir} ${otherDir}`.quiet();
  await $`git -C ${otherDir} config user.email gh@test`.quiet();
  await $`git -C ${otherDir} config user.name GitHub`.quiet();
}

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[]) {
  const base = { ...process.env } as Record<string, string>;
  delete base.GH_STACK_NO_PUSH;
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...base,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_LOG: `${binDir}/gh.log`,
      GH_PR_DIR: binDir,
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

/** A fake `gh`: `pr view N` prints $GH_PR_DIR/N.json, `repo view` names a repo, `api` fails. */
async function installGhStub(): Promise<void> {
  await Bun.write(
    `${binDir}/gh`,
    `#!/bin/sh
echo "$*" >> "$GH_LOG"
if [ "$1 $2" = "pr view" ]; then cat "$GH_PR_DIR/$3.json"; exit 0; fi
if [ "$1 $2" = "repo view" ]; then echo acme/widgets; exit 0; fi
if [ "$1" = "api" ]; then exit 1; fi
exit 0
`,
  );
  await fs.chmod(`${binDir}/gh`, 0o755);
}

async function writePr(n: number, data: Record<string, unknown>): Promise<void> {
  await Bun.write(
    `${binDir}/${n}.json`,
    JSON.stringify({ number: n, title: `PR ${n}`, url: `https://x/${n}`, ...data }),
  );
}

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${dir} ${args}`.text()).trim();
}

/** On "GitHub": squash `child` into `into`, push, and record the PR as MERGED. */
async function squashOnGithub(pr: number, child: string, into: string) {
  await git(otherDir, "checkout", "-q", into);
  await git(otherDir, "pull", "-q", "--ff-only", "origin", into);
  await git(otherDir, "fetch", "-q", "origin", child);
  await git(otherDir, "merge", "-q", "--squash", `origin/${child}`);
  await git(otherDir, "commit", "-q", "-m", `${child} (#${pr})`);
  await git(otherDir, "push", "-q", "origin", into);
  await writePr(pr, {
    state: "MERGED",
    headRefName: child,
    baseRefName: into,
    mergeCommit: { oid: await git(otherDir, "rev-parse", "HEAD") },
    mergedAt: "2026-11-06T01:42:00Z",
  });
}

/** What `merge` does before it stops on the base's conflict with main. */
async function collapseIntoBase(): Promise<void> {
  await squashOnGithub(3, "c2", "c1");
  await squashOnGithub(2, "c1", "base");
}

/** On "GitHub": main moves, writing `file`. */
async function mainCommits(file: string, content: string): Promise<void> {
  await git(otherDir, "checkout", "-q", "main");
  await git(otherDir, "pull", "-q", "--ff-only", "origin", "main");
  await Bun.write(`${otherDir}/${file}`, content);
  await git(otherDir, "add", file);
  await git(otherDir, "commit", "-q", "-m", `main: ${file}`);
  await git(otherDir, "push", "-q", "origin", "main");
}

/**
 * base sits on origin/main with its own commit plus PR #2's squash commit
 * (which carries PR #3's, squashed into c1 first), and is pushed.
 */
async function expectBaseHoldsEverything(): Promise<void> {
  await git(tmpDir, "fetch", "-q", "origin");
  expect(
    await git(tmpDir, "merge-base", "--is-ancestor", "origin/main", "base").catch(() => "no"),
  ).toBe("");
  expect(await git(tmpDir, "log", "--format=%s", "origin/main..base")).toBe(
    "c1 (#2)\nbase: add file",
  );
  expect(await git(tmpDir, "show", "base:c1.txt")).toBe("final");
  expect(await git(tmpDir, "show", "base:c2.txt")).toBe("final");
  expect(await git(remoteDir, "rev-parse", "refs/heads/base")).toBe(
    await git(tmpDir, "rev-parse", "base"),
  );
}

describe("sync after merge collapsed the upper PRs into the base (#81)", () => {
  test("drops the collapsed branches and rebases only the base", async () => {
    await publish({});
    await collapseIntoBase();
    await mainCommits("other.txt", "main\n");
    await checkout(tmpDir, "c2");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("PR #2 and PR #3 are already squashed into base");
    expect(res.out).not.toContain("Rebase c1");
    expect(res.out).not.toContain("CONFLICT");
    await expectBaseHoldsEverything();
    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks["test-stack"]!.branches)).toEqual(["base"]);
    // The branch it started on left the stack, so it ends on the base.
    expect(await getCurrentBranch(tmpDir)).toBe("base");
  });

  test("a base already pulled by hand (as in the report) syncs the same way", async () => {
    await publish({});
    await collapseIntoBase();
    await mainCommits("other.txt", "main\n");
    await checkout(tmpDir, "base");
    await git(tmpDir, "pull", "-q", "--ff-only", "origin", "base");
    await checkout(tmpDir, "c1");
    await git(tmpDir, "pull", "-q", "--ff-only", "origin", "c1");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Fast-forwarded");
    expect(res.out).not.toContain("CONFLICT");
    await expectBaseHoldsEverything();
  });

  test("a conflict with main stops on the base alone, and the resume finishes", async () => {
    await publish({});
    await collapseIntoBase();
    await mainCommits("base.txt", "main's base\n");
    await checkout(tmpDir, "c2");

    const stopped = await runCli(["sync"]);
    expect(stopped.exitCode).not.toBe(0);
    expect(stopped.out).toContain("CONFLICT");
    expect(stopped.out).toContain("base.txt");
    expect(stopped.out).not.toContain("c1.txt");

    await Bun.write(`${tmpDir}/base.txt`, "both\n");
    await git(tmpDir, "add", "base.txt");
    await $`git -C ${tmpDir} -c core.editor=true rebase --continue`.quiet();
    const resumed = await runCli(["restack", "--resume"]);

    expect(resumed.exitCode).toBe(0);
    expect(resumed.out).not.toContain("c1 onto");
    expect(resumed.out).not.toContain("CONFLICT");
    await expectBaseHoldsEverything();
    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks["test-stack"]!.branches)).toEqual(["base"]);
  });

  test("an unmerged branch above them is re-rooted onto the base with only its own commit", async () => {
    await createBranch(tmpDir, "c3", "c2");
    await makeCommit(tmpDir, "c3.txt", "c3\n", "c3: add file");
    await publish({ c3: { parent: "c2", pr: 4, description: "PR 4" } });
    await writePr(4, { state: "OPEN", headRefName: "c3", baseRefName: "c2" });
    await collapseIntoBase();
    await mainCommits("other.txt", "main\n");
    await checkout(tmpDir, "c3");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("CONFLICT");
    await expectBaseHoldsEverything();
    expect(await git(tmpDir, "log", "--format=%s", "base..c3")).toBe("c3: add file");
    expect(await git(remoteDir, "rev-parse", "refs/heads/c3")).toBe(
      await git(tmpDir, "rev-parse", "c3"),
    );
    expect(await Bun.file(`${binDir}/gh.log`).text()).toContain("pr edit 4 --base base");
    const meta = await readMetadata(tmpDir);
    const stack = meta.stacks["test-stack"]!.branches;
    expect(Object.keys(stack).toSorted()).toEqual(["base", "c3"]);
    expect(stack["c3"]!.parent).toBe("base");
    expect(await getCurrentBranch(tmpDir)).toBe("c3");
  });

  test("a branch above them amended since its last push is re-rooted and pushed both times", async () => {
    await createBranch(tmpDir, "c3", "c2");
    await makeCommit(tmpDir, "c3.txt", "c3\n", "c3: add file");
    await publish({ c3: { parent: "c2", pr: 4, description: "PR 4" } });
    await writePr(4, { state: "OPEN", headRefName: "c3", baseRefName: "c2" });
    // origin's c3 is the pre-amend commit: the guard clears it (it's in the
    // reflog) and leases the re-root's push on it. The push after the base
    // moves must lease on what that push left, not on what the guard saw.
    await checkout(tmpDir, "c3");
    await git(tmpDir, "commit", "-q", "--amend", "-m", "c3: add file (amended)");
    await collapseIntoBase();
    await mainCommits("other.txt", "main\n");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("failed");
    expect(await git(tmpDir, "log", "--format=%s", "base..c3")).toBe("c3: add file (amended)");
    expect(await git(remoteDir, "rev-parse", "refs/heads/c3")).toBe(
      await git(tmpDir, "rev-parse", "c3"),
    );
  });

  test("--dry-run says what it would drop and changes nothing", async () => {
    await publish({});
    await collapseIntoBase();
    await mainCommits("other.txt", "main\n");
    await checkout(tmpDir, "c2");
    const before = await git(
      tmpDir,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    );

    const res = await runCli(["sync", "--dry-run"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("PR #2 and PR #3 are already squashed into base");
    expect(res.out).toContain("Would fast-forward base to origin/base first");
    // A real run catches the base up, so the guard has nothing to report.
    expect(res.out).not.toContain("Origin has commits");
    expect(
      await git(tmpDir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
    ).toBe(before);
    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks["test-stack"]!.branches)).toEqual(["base", "c1", "c2"]);
  });

  test("with main unchanged, it still moves off the dropped branch onto the base", async () => {
    await publish({});
    await collapseIntoBase();
    await checkout(tmpDir, "c2");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("already up to date with origin/main");
    expect(await getCurrentBranch(tmpDir)).toBe("base");
    expect(await git(tmpDir, "rev-parse", "base")).toBe(await git(remoteDir, "rev-parse", "base"));
  });

  test("run from the base itself, it fast-forwards the checked-out base", async () => {
    await publish({});
    await collapseIntoBase();
    await mainCommits("other.txt", "main\n");
    await checkout(tmpDir, "base");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Fast-forwarded base to origin/base");
    await expectBaseHoldsEverything();
  });

  test("a base that has commits origin lacks is left to the remote guard, not forced", async () => {
    await publish({});
    await collapseIntoBase();
    await checkout(tmpDir, "base");
    await makeCommit(tmpDir, "local.txt", "local\n", "base: a local commit");
    await checkout(tmpDir, "c2");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Origin has commits that the local branches don't");
    expect(res.out).not.toContain("Fast-forwarded");
    expect(res.out).not.toContain("Could not fast-forward");
  });

  test("a child merged somewhere other than its stack parent stays in the stack", async () => {
    await publish({});
    // PR #2 was retargeted to main and merged there: not a collapse into base.
    await writePr(2, { state: "MERGED", headRefName: "c1", baseRefName: "main" });
    await checkout(tmpDir, "base");

    const res = await runCli(["sync", "--dry-run"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("already squashed into base");
  });

  test("a PR merged into a branch that is still open isn't a collapse into the base", async () => {
    await publish({});
    // PR #3 was merged into c1 on GitHub, but PR #2 is still open.
    await squashOnGithub(3, "c2", "c1");
    await writePr(2, { state: "OPEN", headRefName: "c1", baseRefName: "base" });
    await checkout(tmpDir, "base");

    const res = await runCli(["sync", "--dry-run"]);

    expect(res.out).not.toContain("already squashed into base");
  });
});
