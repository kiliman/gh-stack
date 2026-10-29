// #51: `merge --base` must re-root the next branch onto the trunk as it is
// AFTER the bottom PR's squash lands, not the trunk it fetched before merging.
// Also: GH_STACK_NO_PUSH keeps the re-root local, and a re-root that stopped
// (on a conflict, or a trunk that doesn't show the merge yet) is finished by
// re-running `merge --base`.
//
// A second clone stands in for GitHub: the fake `gh pr merge 1` squashes PR #1
// into main there and pushes it, then reports the PR as MERGED.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  checkout,
  cleanup,
  createLinearStack,
  createTempRepo,
  pushAllBranches,
  readMetadata,
  setupRemote,
} from "./helpers.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let otherDir: string;
let binDir: string;
let shas: Record<string, string>;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  ({ shas } = await createLinearStack(tmpDir)); // main → pr1 → pr2 → pr3, PRs #1-#3
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  otherDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-github-"));
  await $`git clone -q ${remoteDir} ${otherDir}`.quiet();
  await $`git -C ${otherDir} config user.email gh@test`.quiet();
  await $`git -C ${otherDir} config user.name GitHub`.quiet();
  binDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-fakegh-"));
  await installGhStub();
  await writePr(1, openPr("pr1", "main", shas.pr1!));
  await writePr(2, openPr("pr2", "pr1", shas.pr2!));
  await writePr(3, openPr("pr3", "pr2", shas.pr3!));
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, otherDir, binDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env } as Record<string, string>;
  delete base.GH_STACK_YES;
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

/**
 * A fake `gh`: `pr view N` prints $GH_PR_DIR/N.json, `pr merge N` runs
 * $GH_PR_DIR/merge-N.sh, `repo view` names a repo, and `api` fails (no live
 * branch refs, so merge never tries to heal a stale PR head).
 */
async function installGhStub(): Promise<void> {
  await Bun.write(
    `${binDir}/gh`,
    `#!/bin/sh
echo "$*" >> "$GH_LOG"
if [ "$1 $2" = "pr view" ]; then cat "$GH_PR_DIR/$3.json"; exit 0; fi
if [ "$1 $2" = "pr merge" ]; then
  sh "$GH_PR_DIR/merge-$3.sh" || exit 1
  # Like gh: --delete-branch removes the head branch on origin and locally.
  case "$*" in *--delete-branch*)
    head=$(sed 's/.*"headRefName":"\\([^"]*\\)".*/\\1/' "$GH_PR_DIR/$3.json")
    git push -q origin --delete "$head"
    git branch -q -D "$head"
  esac
  exit 0
fi
if [ "$1 $2" = "repo view" ]; then echo acme/widgets; exit 0; fi
if [ "$1" = "api" ]; then exit 1; fi
exit 0
`,
  );
  await fs.chmod(`${binDir}/gh`, 0o755);
}

function openPr(head: string, base: string, headSha: string): Record<string, unknown> {
  return {
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefName: head,
    headRefOid: headSha,
    baseRefName: base,
    mergeCommit: null,
  };
}

async function writePr(n: number, data: Record<string, unknown>): Promise<void> {
  await Bun.write(`${binDir}/${n}.json`, JSON.stringify(data));
}

/**
 * `gh pr merge 1` squashes pr1 into main on "GitHub" and pushes it, then
 * reports PR #1 as MERGED with that commit. With `landOnMain: false`, GitHub
 * reports the merge but origin's main never shows it.
 */
async function githubSquashesPr1(opts: { landOnMain: boolean } = { landOnMain: true }) {
  const g = `git -C '${otherDir}'`;
  await Bun.write(
    `${binDir}/merge-1.sh`,
    `set -e
${g} checkout -q main
${g} pull -q --ff-only origin main
${g} fetch -q origin pr1
${g} merge -q --squash origin/pr1 >/dev/null
${g} commit -q -m 'PR 1 (#1)'
${opts.landOnMain ? `${g} push -q origin main` : ""}
sha=$(${g} rev-parse HEAD)
printf '{"state":"MERGED","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN","headRefName":"pr1","headRefOid":"${shas.pr1}","baseRefName":"main","mergeCommit":{"oid":"%s"}}' "$sha" > '${binDir}/1.json'
`,
  );
}

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${dir} ${args}`.text()).trim();
}

async function contains(dir: string, ancestor: string, ref: string): Promise<boolean> {
  return (
    (await $`git -C ${dir} merge-base --is-ancestor ${ancestor} ${ref}`.nothrow().quiet())
      .exitCode === 0
  );
}

async function remoteSha(branch: string): Promise<string> {
  return git(remoteDir, "rev-parse", `refs/heads/${branch}`);
}

/** main moves on "GitHub" with a pr2.txt of its own, so re-rooting pr2 conflicts. */
async function mainAddsConflictingPr2File(): Promise<void> {
  await git(otherDir, "checkout", "-q", "main");
  await Bun.write(`${otherDir}/pr2.txt`, "main's version\n");
  await git(otherDir, "add", "pr2.txt");
  await git(otherDir, "commit", "-q", "-m", "main: its own pr2.txt");
  await git(otherDir, "push", "-q", "origin", "main");
}

describe("merge --base re-roots onto the trunk after the squash (#51)", () => {
  test("the next branch lands on main with the merged PR's squash, and the tail follows", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base"]);

    expect(res.exitCode).toBe(0);
    const squash = await remoteSha("main");
    expect(squash).not.toBe(shas.main);
    // On origin and locally, pr2 sits on the squash, and pr3 on pr2.
    expect(await contains(remoteDir, squash, "refs/heads/pr2")).toBe(true);
    expect(await contains(remoteDir, "refs/heads/pr2", "refs/heads/pr3")).toBe(true);
    expect(await contains(tmpDir, squash, "pr2")).toBe(true);
    // pr2's PR diff is just pr2.txt: nothing of pr1's shows as deleted.
    expect(await git(tmpDir, "diff", "--name-status", `${squash}...pr2`)).toBe("A\tpr2.txt");
    expect(await git(tmpDir, "rev-list", "--count", `${squash}..pr2`)).toBe("1");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr edit 2 --base main");
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.branches["pr1"]).toBeUndefined();
    expect(meta.stacks["test-stack"]!.branches["pr2"]!.parent).toBe("main");
  });

  test("with --delete-branch, which deletes the merged branch locally too", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base", "--delete-branch"]);

    expect(res.exitCode).toBe(0);
    expect(await git(tmpDir, "branch", "--list", "pr1")).toBe("");
    const squash = await remoteSha("main");
    expect(await contains(remoteDir, squash, "refs/heads/pr2")).toBe(true);
    expect(await git(tmpDir, "rev-list", "--count", `${squash}..pr2`)).toBe("1");
    expect(await contains(remoteDir, "refs/heads/pr2", "refs/heads/pr3")).toBe(true);
  });

  test("stops before re-rooting when origin's main doesn't show the merge", async () => {
    await githubSquashesPr1({ landOnMain: false });
    await checkout(tmpDir, "pr1");
    const pr2 = await git(tmpDir, "rev-parse", "pr2");

    const res = await runCli(["merge", "--base"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("PR #1 is merged, but origin/main doesn't show its merge commit");
    expect(res.out).toContain("gh-stack merge --base");
    // Nothing was re-rooted or pushed, and the stack still has pr1.
    expect(await git(tmpDir, "rev-parse", "pr2")).toBe(pr2);
    expect(await remoteSha("pr2")).toBe(pr2);
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.branches["pr2"]!.parent).toBe("pr1");
  });
});

describe("merge --base --no-push (#51)", () => {
  test("GH_STACK_NO_PUSH merges on GitHub but keeps the re-root and tail local", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base"], { GH_STACK_NO_PUSH: "1" });

    expect(res.exitCode).toBe(0);
    const squash = await remoteSha("main");
    expect(squash).not.toBe(shas.main);
    expect(await contains(tmpDir, squash, "pr2")).toBe(true);
    expect(await contains(tmpDir, "pr2", "pr3")).toBe(true);
    // Origin and the PR base are untouched.
    expect(await remoteSha("pr2")).toBe(shas.pr2!);
    expect(await remoteSha("pr3")).toBe(shas.pr3!);
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr merge 1 --squash");
    expect(calls).not.toContain("pr edit");
  });

  test("--push wins over GH_STACK_NO_PUSH", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base", "--push"], { GH_STACK_NO_PUSH: "1" });

    expect(res.exitCode).toBe(0);
    expect(await contains(remoteDir, await remoteSha("main"), "refs/heads/pr2")).toBe(true);
  });
});

describe("a re-root stopped on a conflict is finished by re-running (#51)", () => {
  test("resolve, continue, re-run merge --base -d: pr2 is pushed and retargeted, pr3 follows", async () => {
    await mainAddsConflictingPr2File();
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const first = await runCli(["merge", "--base", "-d"]);
    expect(first.exitCode).toBe(2);
    expect(first.out).toContain("Rebase conflict re-rooting pr2 onto main");
    expect(first.out).toContain("gh-stack merge --base");

    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await git(tmpDir, "add", "pr2.txt");
    await $`git -C ${tmpDir} -c core.editor=true rebase --continue`.quiet();

    const second = await runCli(["merge", "--base", "-d"]);

    expect(second.exitCode).toBe(0);
    expect(second.out).toContain("pr2 is already on main");
    const squash = await remoteSha("main");
    expect(await remoteSha("pr2")).toBe(await git(tmpDir, "rev-parse", "pr2"));
    expect(await contains(remoteDir, squash, "refs/heads/pr2")).toBe(true);
    expect(await contains(remoteDir, "refs/heads/pr2", "refs/heads/pr3")).toBe(true);
    // pr3 carries only its own commit on top of the re-rooted pr2.
    expect(await git(tmpDir, "rev-list", "--count", "pr2..pr3")).toBe("1");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr edit 2 --base main");
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.branches["pr1"]).toBeUndefined();
    expect(meta.stacks["test-stack"]!.branches["pr2"]!.parent).toBe("main");
  });
});

describe("sync's re-root stopped on a conflict is finished by re-running sync (#51)", () => {
  test("resolve, continue, re-run sync: pr2 is pushed and retargeted, pr3 follows", async () => {
    await mainAddsConflictingPr2File();
    // PR #1 merges on GitHub outside gh-stack.
    await githubSquashesPr1();
    await $`sh ${binDir}/merge-1.sh`.quiet();
    await checkout(tmpDir, "pr2");

    const first = await runCli(["sync"]);
    expect(first.exitCode).toBe(2);
    expect(first.out).toContain("Rebase conflict re-rooting pr2 onto main");
    expect(first.out).toContain("gh-stack sync");

    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await git(tmpDir, "add", "pr2.txt");
    await $`git -C ${tmpDir} -c core.editor=true rebase --continue`.quiet();

    const second = await runCli(["sync"]);

    expect(second.exitCode).toBe(0);
    expect(second.out).toContain("pr2 is already on main");
    const squash = await remoteSha("main");
    expect(await remoteSha("pr2")).toBe(await git(tmpDir, "rev-parse", "pr2"));
    expect(await contains(remoteDir, squash, "refs/heads/pr2")).toBe(true);
    expect(await contains(remoteDir, "refs/heads/pr2", "refs/heads/pr3")).toBe(true);
    expect(await git(tmpDir, "rev-list", "--count", "pr2..pr3")).toBe("1");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr edit 2 --base main");
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.branches["pr1"]).toBeUndefined();
    expect(meta.stacks["test-stack"]!.branches["pr2"]!.parent).toBe("main");
  });
});
