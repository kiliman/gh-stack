// #60: a branch that leaves its stack while it has several children.
//
// The dependency sweep builds exactly this: a batch PR at the bottom and one
// PR per breaking upgrade, each a sibling child of the batch. When the batch
// leaves (deleted, or merged and advanced past), its children sit side by side
// on main. One stack can't have several roots, so each child becomes its own
// stack, and every child is re-rooted, not just the first.
//
// The batch has two commits that write batch.txt differently, so replaying its
// first commit onto main (which holds the final batch.txt) conflicts, as it
// does for real multi-commit PRs. A second clone stands in for GitHub, and a
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
import type { Stack } from "../types.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let otherDir: string;
let binDir: string;

const SWEEP: Stack = {
  description: "Dependency sweep",
  last_branch: "ts-tail",
  branches: {
    batch: { parent: "main", pr: 1 },
    oxfmt: { parent: "batch", pr: 2 },
    ts: { parent: "batch", pr: 3 },
    "ts-tail": { parent: "ts", pr: 4 },
  },
};

beforeEach(async () => {
  tmpDir = await createTempRepo();
  // main → batch (two commits) → { oxfmt, ts → ts-tail }, PRs #1-#4.
  await createBranch(tmpDir, "batch", "main");
  await makeCommit(tmpDir, "batch.txt", "draft\n", "batch: first draft");
  await makeCommit(tmpDir, "batch.txt", "final\n", "batch: final version");
  await createBranch(tmpDir, "oxfmt", "batch");
  await makeCommit(tmpDir, "oxfmt.txt", "oxfmt\n", "oxfmt: upgrade");
  await createBranch(tmpDir, "ts", "batch");
  await makeCommit(tmpDir, "ts.txt", "ts\n", "ts: upgrade");
  await createBranch(tmpDir, "ts-tail", "ts");
  await makeCommit(tmpDir, "ts-tail.txt", "tail\n", "ts-tail: follow-up");
  await writeMetadata(tmpDir, {
    version: 2,
    current_stack: "deps",
    stacks: { deps: structuredClone(SWEEP) },
  });
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  otherDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-github-"));
  await $`git clone -q ${remoteDir} ${otherDir}`.quiet();
  await $`git -C ${otherDir} config user.email gh@test`.quiet();
  await $`git -C ${otherDir} config user.name GitHub`.quiet();
  binDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-fakegh-"));
  await installGhStub();
  await writePr(2, { state: "OPEN", headRefName: "oxfmt", baseRefName: "batch" });
  await writePr(3, { state: "OPEN", headRefName: "ts", baseRefName: "batch" });
  await writePr(4, { state: "OPEN", headRefName: "ts-tail", baseRefName: "ts" });
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, otherDir, binDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...process.env,
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

/** The script `gh pr merge 1` runs: squash batch into main on "GitHub", mark #1 MERGED. */
const MERGE_BATCH =
  () => `cd '${otherDir}' && git checkout -q main && git pull -q --ff-only origin main &&
git fetch -q origin batch && git merge -q --squash origin/batch >/dev/null &&
git commit -q -m 'batch (#1)' && git push -q origin main &&
printf '{"number":1,"state":"MERGED","headRefName":"batch","baseRefName":"main","mergeCommit":{"oid":"%s"},"mergedAt":"2026-11-01T10:00:00Z"}' "$(git rev-parse HEAD)" > '${binDir}/1.json'
`;

/** Every child of the batch is on origin/main with only its own commits, PRs retargeted. */
async function expectBothChildrenReRooted(): Promise<void> {
  await git(tmpDir, "fetch", "-q", "origin");
  expect(await git(tmpDir, "diff", "--name-status", "origin/main...oxfmt")).toBe("A\toxfmt.txt");
  expect(await git(tmpDir, "diff", "--name-status", "origin/main...ts")).toBe("A\tts.txt");
  expect(await git(tmpDir, "rev-list", "--count", "origin/main..ts")).toBe("1");
  // The tail rides on the re-rooted ts, with only its own commit above it.
  expect(await git(tmpDir, "merge-base", "--is-ancestor", "ts", "ts-tail").catch(() => "no")).toBe(
    "",
  );
  expect(await git(tmpDir, "diff", "--name-status", "ts...ts-tail")).toBe("A\tts-tail.txt");
  for (const branch of ["oxfmt", "ts", "ts-tail"]) {
    expect(await git(remoteDir, "rev-parse", `refs/heads/${branch}`)).toBe(
      await git(tmpDir, "rev-parse", branch),
    );
  }
  const calls = await Bun.file(`${binDir}/gh.log`).text();
  expect(calls).toContain("pr edit 2 --base main");
  expect(calls).toContain("pr edit 3 --base main");

  const meta = await readMetadata(tmpDir);
  expect(meta.stacks["deps"]!.branches).toEqual({
    oxfmt: expect.objectContaining({ parent: "main", pr: 2 }),
  });
  expect(meta.stacks["ts"]!.base).toBe("main");
  expect(meta.stacks["ts"]!.branches).toEqual({
    ts: expect.objectContaining({ parent: "main", pr: 3 }),
    "ts-tail": expect.objectContaining({ parent: "ts", pr: 4 }),
  });
}

describe("advancing past a merged branch with several children (#60)", () => {
  test("sync re-roots every child and gives each its own stack", async () => {
    await Bun.write(`${binDir}/merge-1.sh`, MERGE_BATCH());
    await $`sh ${binDir}/merge-1.sh`.quiet();
    await checkout(tmpDir, "oxfmt");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("re-rooting oxfmt, ts onto main");
    expect(res.out).not.toContain("Re-rooting batch");
    await expectBothChildrenReRooted();

    // Both stacks load again: the next command isn't refused.
    expect((await runCli(["delete", "oxfmt", "--keep-branch"])).exitCode).toBe(0);
    await checkout(tmpDir, "ts");
    const again = await runCli(["sync"]);
    expect(again.exitCode).toBe(0);
  });

  test("merge --base re-roots every child and restacks each one's tail", async () => {
    await writePr(1, {
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefName: "batch",
      headRefOid: await git(remoteDir, "rev-parse", "refs/heads/batch"),
      baseRefName: "main",
      mergeCommit: null,
    });
    await Bun.write(`${binDir}/merge-1.sh`, MERGE_BATCH());
    await checkout(tmpDir, "batch");

    const res = await runCli(["merge", "--base", "--skip-collapse-check"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("each becomes its own stack");
    await expectBothChildrenReRooted();
  });
});

describe("delete of a root with several children (#60)", () => {
  test("splits the children into one stack each, and the next delete works", async () => {
    const del = await runCli(["delete", "batch", "--keep-branch"]);
    expect(del.exitCode).toBe(0);
    expect(del.out).toContain("each becomes its own stack");
    expect(del.out).toContain("Split off ts");

    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks["deps"]!.branches)).toEqual(["oxfmt"]);
    expect(Object.keys(meta.stacks["ts"]!.branches)).toEqual(["ts", "ts-tail"]);

    expect((await runCli(["delete", "oxfmt", "--keep-branch"])).exitCode).toBe(0);
    expect((await runCli(["delete", "ts-tail", "--keep-branch"])).exitCode).toBe(0);
  });
});

describe("doctor repairs a stack that already has several roots (#60)", () => {
  beforeEach(async () => {
    // What gh-stack ≤0.19.6 left behind: batch dropped, both children on main.
    const broken = structuredClone(SWEEP);
    delete broken.branches["batch"];
    broken.branches["oxfmt"]!.parent = "main";
    broken.branches["ts"]!.parent = "main";
    await writeMetadata(tmpDir, { version: 2, current_stack: "deps", stacks: { deps: broken } });
  });

  test("commands refuse it and point at doctor's split", async () => {
    const res = await runCli(["delete", "oxfmt", "--keep-branch"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("exactly one root branch; found 2");
    expect(res.out).toContain("split it into one stack per root");
  });

  test("doctor splits it, and the stacks load again", async () => {
    const res = await runCli(["doctor"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Split deps, which had 2 root branches");
    expect(res.out).toContain("Metadata looks healthy.");
    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks["deps"]!.branches)).toEqual(["oxfmt"]);
    expect(Object.keys(meta.stacks["ts"]!.branches)).toEqual(["ts", "ts-tail"]);
    expect(await git(tmpDir, "config", "branch.ts-tail.ghstack-stack")).toBe("ts");

    expect((await runCli(["delete", "oxfmt", "--keep-branch"])).exitCode).toBe(0);
  });

  test("doctor reports a stack it can't repair instead of calling it healthy", async () => {
    const meta = await readMetadata(tmpDir);
    meta.stacks["deps"]!.branches["oxfmt"]!.parent = "ts-tail";
    meta.stacks["deps"]!.branches["ts"]!.parent = "oxfmt"; // a cycle, and no root
    await writeMetadata(tmpDir, meta);

    const res = await runCli(["doctor"]);

    expect(res.out).toContain("Stack deps is invalid");
    expect(res.out).not.toContain("Metadata looks healthy.");
  });
});
