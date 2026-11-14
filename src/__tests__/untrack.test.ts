// #82: sessions read `delete --help` again and again before trusting
// `--keep-branch`, and one session's notes said never to use delete at all.
// `untrack` is the same metadata-only removal under a name that says so.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import {
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
import type { Stack } from "../types.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let stubDir: string;
let remoteDir: string;

const cliPath = new URL("../index.ts", import.meta.url).pathname;

/** No GH_STACK_YES: with stdin not a TTY, any prompt refuses and stops the command. */
async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: { ...process.env, ...ghStubEnv(stubDir), NO_COLOR: "1", GH_STACK_NO_COLOR: "1" },
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

async function refExists(dir: string, ref: string): Promise<boolean> {
  const r = await $`git -C ${dir} rev-parse --verify --quiet ${ref}`.nothrow().quiet();
  return r.exitCode === 0;
}

/** main → parent → mid → child, stack "deps", PRs #141/#142/#143. */
const DEPS: Stack = {
  description: "",
  last_branch: "child",
  base: "main",
  branches: {
    parent: { parent: "main", pr: 141 },
    mid: { parent: "parent", pr: 142 },
    child: { parent: "mid", pr: 143 },
  },
};

beforeEach(async () => {
  tmpDir = await createTempRepo();
  stubDir = await createGhStub();
  await createBranch(tmpDir, "parent", "main");
  await makeCommit(tmpDir, "parent.txt", "parent\n", "parent: commit");
  await createBranch(tmpDir, "mid", "parent");
  await makeCommit(tmpDir, "mid.txt", "mid\n", "mid: commit");
  await createBranch(tmpDir, "child", "mid");
  await makeCommit(tmpDir, "child.txt", "child\n", "child: commit");
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  await writeMetadata(tmpDir, { version: 2, current_stack: "deps", stacks: { deps: DEPS } });
  expect((await runCli(["doctor"])).exitCode).toBe(0);
});

afterEach(async () => {
  await cleanup(tmpDir, stubDir, remoteDir);
});

describe("gh-stack untrack", () => {
  test("removes the branch from the stack only, without asking", async () => {
    const res = await runCli(["untrack", "mid"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Untracked mid from stack deps");
    expect(res.out).toContain("gh-stack add mid");
    expect(res.out).not.toContain("Delet");
    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks["deps"]!.branches).toSorted()).toEqual(["child", "parent"]);
    expect(meta.stacks["deps"]!.branches["child"]!.parent).toBe("parent");
    // Git and origin keep the branch; it keeps its PR number for a later add.
    expect(await refExists(tmpDir, "refs/heads/mid")).toBe(true);
    expect(await refExists(remoteDir, "refs/heads/mid")).toBe(true);
    expect(await config("branch.mid.ghstack-pr")).toBe("142");
    expect(await config("branch.mid.ghstack-stack")).toBeNull();
  });

  test("untrack --help describes untrack, and delete --help points to it", async () => {
    const help = await runCli(["untrack", "--help"]);
    expect(help.out).toContain("gh-stack untrack [<branch>]");
    expect(help.out).not.toContain("--no-remote");

    const del = await runCli(["delete", "--help"]);
    expect(del.out).toContain("gh-stack untrack <branch>");
  });

  test("delete still asks, so without --yes it changes nothing", async () => {
    const res = await runCli(["delete", "mid"]);

    expect(res.out).toContain("refusing to prompt");
    expect(Object.keys((await readMetadata(tmpDir)).stacks["deps"]!.branches)).toContain("mid");
    expect(await refExists(tmpDir, "refs/heads/mid")).toBe(true);
  });
});
