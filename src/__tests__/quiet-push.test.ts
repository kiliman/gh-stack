// #82: every restack push printed a "⚠ Branch is out of sync with remote" box,
// though overwriting origin's pre-rebase copy is what a restack is for. The
// noise sent sessions piping gh-stack into tail. A push over a version of the
// branch the repo had is one line now; the box is left for an origin tip
// nothing vouches for.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import {
  checkout,
  cleanup,
  createGhStub,
  createLinearStack,
  createTempRepo,
  makeCommit,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";
import { wasLocalTip } from "../lib/remote-guard.ts";
import type { StackMetadata } from "../types.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let stubDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  stubDir = await createGhStub();
  await createLinearStack(tmpDir);
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
});

afterEach(async () => {
  await cleanup(tmpDir, stubDir, remoteDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      GH_LOG: `${stubDir}/calls.log`,
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

async function sha(ref: string): Promise<string> {
  return (await $`git -C ${tmpDir} rev-parse ${ref}`.text()).trim();
}

async function remoteSha(branch: string): Promise<string> {
  return (await $`git -C ${remoteDir} rev-parse refs/heads/${branch}`.text()).trim();
}

describe("restack pushes (#82)", () => {
  test("pushing over origin's pre-rebase copy is one line, not a warning box", async () => {
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");
    const before = { pr2: await sha("pr2"), pr3: await sha("pr3") };

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    for (const b of ["pr2", "pr3"] as const) {
      expect(res.out).toContain(
        `Force-push ${b}? origin ${before[b].slice(0, 8)} → ${(await sha(b)).slice(0, 8)}`,
      );
      expect(res.out).toContain(`Pushed ${b}`);
      expect(await remoteSha(b)).toBe(await sha(b));
    }
    expect(res.out).not.toContain("Push Rebased Branch?");
    expect(res.out).not.toContain("never had");
  });
});

describe("wasLocalTip", () => {
  const originalCwd = process.cwd();
  const noSnapshots: StackMetadata = { version: 2, current_stack: null, stacks: {} };

  beforeEach(() => process.chdir(tmpDir));
  afterEach(() => process.chdir(originalCwd));

  test("a tip in the branch's reflog counts; a commit it never pointed at doesn't", async () => {
    const old = await sha("pr2");
    await checkout(tmpDir, "pr2");
    await makeCommit(tmpDir, "more.txt", "more\n", "more on pr2");

    expect(await wasLocalTip(noSnapshots, "pr2", old)).toBe(true);
    expect(await wasLocalTip(noSnapshots, "pr2", await sha("pr3"))).toBe(false);
  });

  test("a tip a snapshot recorded counts without a reflog", async () => {
    const pr1 = await sha("pr1");
    await $`git -C ${tmpDir} reflog expire --expire=now --all`.quiet();
    const meta: StackMetadata = {
      ...noSnapshots,
      snapshots: [{ timestamp: "", stack: "s", operation: "restack", branches: { pr2: pr1 } }],
    };

    expect(await wasLocalTip(noSnapshots, "pr2", pr1)).toBe(false);
    expect(await wasLocalTip(meta, "pr2", pr1)).toBe(true);
  });
});
