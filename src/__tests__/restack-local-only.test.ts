// #24: restack/sync must NOT publish an unsubmitted local-only branch under
// --yes. They rebase it locally (keeping the stack consistent) but leave
// pushing/PR-creation to `submit`. A branch that already has a remote/PR is
// still force-pushed to stay in sync.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  checkout,
  cleanup,
  createLinearStack,
  createTempRepo,
  makeCommit,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";

let tmpDir: string;
let remoteDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
});

afterEach(async () => {
  await cleanup(tmpDir);
  if (remoteDir) await $`rm -rf ${remoteDir}`.quiet().nothrow();
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: { ...process.env, NO_COLOR: "1", GH_STACK_NO_COLOR: "1", GH_STACK_YES: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function remoteSha(branch: string): Promise<string> {
  const out = (await $`git -C ${tmpDir} ls-remote origin ${branch}`.text()).trim();
  return out ? out.split(/\s+/)[0]! : "";
}

describe("restack --yes with a local-only tip (#24)", () => {
  test("rebases the WIP tip but does not push it; still syncs the PR'd branches", async () => {
    await createLinearStack(tmpDir); // pr1 → pr2 → pr3, each with a PR in metadata
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir); // pr1/pr2/pr3 now on origin

    // A local WIP tip on top of pr3 — tracked via `add`, never submitted.
    await checkout(tmpDir, "pr3");
    await $`git -C ${tmpDir} checkout -q -b wip`;
    await makeCommit(tmpDir, "wip.txt", "wip\n", "wip commit");
    expect((await runCli(["add"])).exitCode).toBe(0); // tracked, no PR, no remote

    // Force a rebase cascade: new commit on pr1 invalidates pr2/pr3/wip ancestry.
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");

    const res = await runCli(["restack"]);

    // Success — the local-only tip must not turn a clean run into a failure.
    expect(res.exitCode).toBe(0);
    const out = res.stdout + res.stderr;
    expect(out).toContain("Skipping push");
    expect(out).toContain("wip");

    // wip was NOT published.
    expect(await remoteSha("wip")).toBe("");

    // …but the branches that DO have PRs were force-pushed back into sync.
    const pr2Local = (await $`git -C ${tmpDir} rev-parse pr2`.text()).trim();
    const pr3Local = (await $`git -C ${tmpDir} rev-parse pr3`.text()).trim();
    expect(await remoteSha("pr2")).toBe(pr2Local);
    expect(await remoteSha("pr3")).toBe(pr3Local);

    // And the WIP tip really was rebased locally (sits on top of the new pr3).
    const isAncestor = await $`git -C ${tmpDir} merge-base --is-ancestor pr3 wip`.nothrow().quiet();
    expect(isAncestor.exitCode).toBe(0);
  });
});
