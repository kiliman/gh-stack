// #54: when several bottom PRs have merged, `sync` (and `merge --base`) must
// drop all of them and re-root only the first unmerged branch onto main, from
// the last merged branch's tip. Re-rooting a merged branch replays its
// pre-squash commits onto a main that already holds them squashed.
//
// pr2 has two commits that write pr2.txt differently, so replaying its first
// commit onto main (which holds the final pr2.txt) is an add/add conflict, as
// it is for real multi-commit PRs. With one commit per branch the replay
// merges cleanly and the bug hides.
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
  makeCommit,
  pushAllBranches,
  readMetadata,
  setupRemote,
  writeMetadata,
} from "./helpers.ts";
import { strandedMerges } from "../lib/advance.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let otherDir: string;
let binDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  // main → pr1 → pr2 (two commits) → pr3, PRs #1-#3.
  await createBranch(tmpDir, "pr1", "main");
  await makeCommit(tmpDir, "pr1.txt", "pr1\n", "pr1: add file");
  await createBranch(tmpDir, "pr2", "pr1");
  await makeCommit(tmpDir, "pr2.txt", "draft\n", "pr2: first draft");
  await makeCommit(tmpDir, "pr2.txt", "final\n", "pr2: final version");
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
  otherDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-github-"));
  await $`git clone -q ${remoteDir} ${otherDir}`.quiet();
  await $`git -C ${otherDir} config user.email gh@test`.quiet();
  await $`git -C ${otherDir} config user.name GitHub`.quiet();
  binDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-fakegh-"));
  await installGhStub();
  await writePr(3, { state: "OPEN", headRefName: "pr3", baseRefName: "pr2" });
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, otherDir, binDir);
});

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

/**
 * A fake `gh`: `pr view N` prints $GH_PR_DIR/N.json, `pr merge N` runs
 * $GH_PR_DIR/merge-N.sh, `repo view` names a repo, and `api` fails.
 */
async function installGhStub(): Promise<void> {
  await Bun.write(
    `${binDir}/gh`,
    `#!/bin/sh
echo "$*" >> "$GH_LOG"
if [ "$1 $2" = "pr view" ]; then cat "$GH_PR_DIR/$3.json"; exit 0; fi
if [ "$1 $2" = "pr merge" ]; then sh "$GH_PR_DIR/merge-$3.sh"; exit $?; fi
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
async function squashOnGithub(pr: number, child: string, into: string, mergedAt: string) {
  await git(otherDir, "checkout", "-q", into);
  await git(otherDir, "pull", "-q", "--ff-only", "origin", into);
  await git(otherDir, "fetch", "-q", "origin", child);
  await git(otherDir, "merge", "-q", "--squash", `origin/${child}`);
  await git(otherDir, "commit", "-q", "-m", `${child} (#${pr})`);
  await git(otherDir, "push", "-q", "origin", into);
  const sha = await git(otherDir, "rev-parse", "HEAD");
  await writePr(pr, {
    state: "MERGED",
    headRefName: child,
    baseRefName: into,
    mergeCommit: { oid: sha },
    mergedAt,
  });
  return sha;
}

/** `merge --approved`'s collapse: PR #2 squashed into pr1, then PR #1 into main. */
async function collapseThenLand(): Promise<void> {
  await squashOnGithub(2, "pr2", "pr1", "2026-10-31T10:00:00Z");
  await squashOnGithub(1, "pr1", "main", "2026-10-31T11:00:00Z");
}

/** On "GitHub": main gets its own pr3.txt, so re-rooting pr3 conflicts. */
async function mainAddsConflictingPr3File(): Promise<void> {
  await git(otherDir, "checkout", "-q", "main");
  await git(otherDir, "pull", "-q", "--ff-only", "origin", "main");
  await Bun.write(`${otherDir}/pr3.txt`, "main's version\n");
  await git(otherDir, "add", "pr3.txt");
  await git(otherDir, "commit", "-q", "-m", "main: its own pr3.txt");
  await git(otherDir, "push", "-q", "origin", "main");
}

/** pr3 is the stack's only branch, on origin/main with just its own commit, PR retargeted. */
async function expectOnlyPr3OnMain(): Promise<void> {
  await git(tmpDir, "fetch", "-q", "origin");
  expect(await git(tmpDir, "diff", "--name-status", "origin/main...pr3")).toBe("A\tpr3.txt");
  expect(await git(tmpDir, "rev-list", "--count", "origin/main..pr3")).toBe("1");
  expect(await git(remoteDir, "rev-parse", "refs/heads/pr3")).toBe(
    await git(tmpDir, "rev-parse", "pr3"),
  );
  const calls = await Bun.file(`${binDir}/gh.log`).text();
  expect(calls).toContain("pr edit 3 --base main");
  const meta = await readMetadata(tmpDir);
  const branches = meta.stacks["test-stack"]!.branches;
  expect(Object.keys(branches)).toEqual(["pr3"]);
  expect(branches["pr3"]!.parent).toBe("main");
}

describe("sync advances past every merged bottom in one re-root (#54)", () => {
  test("after a collapse lands (merge --approved), only the unmerged tail is re-rooted", async () => {
    await collapseThenLand();
    await checkout(tmpDir, "pr3");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Re-rooting pr2");
    expect(res.out).toContain("Re-rooting pr3 onto main");
    await expectOnlyPr3OnMain();
  });

  test("two PRs merged into main one after the other", async () => {
    await squashOnGithub(1, "pr1", "main", "2026-10-31T10:00:00Z");
    await squashOnGithub(2, "pr2", "main", "2026-10-31T11:00:00Z");
    await checkout(tmpDir, "pr3");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Re-rooting pr2");
    await expectOnlyPr3OnMain();
  });

  test("a conflict re-rooting the tail leaves the stack as it was; re-running sync finishes", async () => {
    await mainAddsConflictingPr3File();
    await collapseThenLand();
    await checkout(tmpDir, "pr3");

    const first = await runCli(["sync"]);
    expect(first.exitCode).toBe(2);
    expect(first.out).toContain("Rebase conflict re-rooting pr3 onto main");
    // Nothing dropped yet: a re-run still sees both merged PRs.
    const mid = await readMetadata(tmpDir);
    expect(Object.keys(mid.stacks["test-stack"]!.branches).toSorted()).toEqual([
      "pr1",
      "pr2",
      "pr3",
    ]);

    await Bun.write(`${tmpDir}/pr3.txt`, "resolved\n");
    await git(tmpDir, "add", "pr3.txt");
    await $`git -C ${tmpDir} -c core.editor=true rebase --continue`.quiet();

    const second = await runCli(["sync"]);

    expect(second.exitCode).toBe(0);
    expect(second.out).toContain("pr3 is already on main");
    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks["test-stack"]!.branches)).toEqual(["pr3"]);
    expect(meta.stacks["test-stack"]!.branches["pr3"]!.parent).toBe("main");
    expect(await Bun.file(`${binDir}/gh.log`).text()).toContain("pr edit 3 --base main");
  });

  test("warns when a PR merged into a branch that had already landed", async () => {
    // PR #1 lands first; PR #2 then merges into the dead pr1 branch.
    await squashOnGithub(1, "pr1", "main", "2026-10-31T10:00:00Z");
    await squashOnGithub(2, "pr2", "pr1", "2026-10-31T11:00:00Z");
    await checkout(tmpDir, "pr3");

    const res = await runCli(["sync"]);

    expect(res.out).toContain("PR #2 merged into pr1 after PR #1 had landed");
  });
});

describe("merge --base drops PRs collapsed into the base (#54)", () => {
  test("the next unmerged branch is re-rooted, not the collapsed one", async () => {
    await squashOnGithub(2, "pr2", "pr1", "2026-10-31T10:00:00Z");
    await writePr(1, {
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefName: "pr1",
      headRefOid: await git(remoteDir, "rev-parse", "refs/heads/pr1"),
      baseRefName: "main",
      mergeCommit: null,
    });
    // `gh pr merge 1` squashes pr1 (with PR #2 in it) into main.
    await Bun.write(
      `${binDir}/merge-1.sh`,
      `cd '${otherDir}' && git checkout -q main && git pull -q --ff-only origin main &&
git fetch -q origin pr1 && git merge -q --squash origin/pr1 >/dev/null &&
git commit -q -m 'pr1 (#1)' && git push -q origin main &&
printf '{"state":"MERGED","headRefName":"pr1","baseRefName":"main","mergeCommit":{"oid":"%s"}}' "$(git rev-parse HEAD)" > '${binDir}/1.json'
`,
    );
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base", "--skip-collapse-check"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Re-rooting pr2");
    await expectOnlyPr3OnMain();
  });
});

describe("merge --approved when the repo doesn't allow auto-merge (#54)", () => {
  test("says to merge the base PR directly, not to retry --auto", async () => {
    await writePr(1, { state: "OPEN", reviewDecision: "APPROVED", baseRefName: "main" });
    await writePr(2, { state: "OPEN", reviewDecision: "REVIEW_REQUIRED", baseRefName: "pr1" });
    await Bun.write(
      `${binDir}/merge-1.sh`,
      `echo "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)" >&2; exit 1\n`,
    );
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--approved"]);

    expect(res.out).toContain("This repo doesn't allow auto-merge");
    expect(res.out).toContain("gh pr merge 1 --squash");
    expect(res.out).not.toContain("gh pr merge 1 --squash --auto");
  });
});

function mergedRun(entries: Array<[string, string, string | null, string | null]>) {
  return entries.map(([branch, parent, baseRefName, mergedAt], i) => ({
    branch,
    parent,
    pr: i + 1,
    baseRefName,
    mergedAt,
  }));
}

describe("strandedMerges", () => {
  test("a collapse that landed after its children is fine", () => {
    const merged = mergedRun([
      ["pr1", "main", "main", "2026-10-31T11:00:00Z"],
      ["pr2", "pr1", "pr1", "2026-10-31T10:00:00Z"],
    ]);
    expect(strandedMerges(merged, "main")).toEqual([]);
  });

  test("PRs merged into main one by one are fine", () => {
    const merged = mergedRun([
      ["pr1", "main", "main", "2026-10-31T10:00:00Z"],
      ["pr2", "pr1", "main", "2026-10-31T11:00:00Z"],
    ]);
    expect(strandedMerges(merged, "main")).toEqual([]);
  });

  test("a PR merged into its parent after the parent landed is stranded", () => {
    const merged = mergedRun([
      ["pr1", "main", "main", "2026-10-31T10:00:00Z"],
      ["pr2", "pr1", "pr1", "2026-10-31T11:00:00Z"],
    ]);
    expect(strandedMerges(merged, "main")).toEqual([
      { branch: "pr2", pr: 2, into: "pr1", landedPr: 1 },
    ]);
  });

  test("a PR merged into a branch outside the merged run is stranded", () => {
    const merged = mergedRun([
      ["pr1", "main", "main", "2026-10-31T10:00:00Z"],
      ["pr2", "pr1", "elsewhere", "2026-10-31T09:00:00Z"],
    ]);
    expect(strandedMerges(merged, "main")).toEqual([
      { branch: "pr2", pr: 2, into: "elsewhere", landedPr: null },
    ]);
  });

  test("missing facts never claim stranded", () => {
    const merged = mergedRun([
      ["pr1", "main", "main", null],
      ["pr2", "pr1", "pr1", "2026-10-31T11:00:00Z"],
    ]);
    expect(strandedMerges(merged, "main")).toEqual([]);
  });
});
