// Tests for `gh-stack add` — registering an existing local branch into a stack
// without pushing or opening a PR. Resolves the catch-22 where a local WIP tip
// couldn't be sync'd/restacked because the only way into a stack was `submit`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkout, cleanup, createLinearStack, createTempRepo, makeCommit } from "./helpers.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
});

afterEach(async () => {
  await cleanup(tmpDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: { ...process.env, NO_COLOR: "1", GH_STACK_NO_COLOR: "1" },
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

describe("gh-stack add", () => {
  test("tracks an untracked tip into the stack it sits on (parent detected)", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");
    // Create a local WIP branch on top of pr3, never submitted.
    const proc = Bun.spawn(["git", "-C", tmpDir, "checkout", "-q", "-b", "wip"]);
    await proc.exited;
    await makeCommit(tmpDir, "wip.txt", "wip\n", "wip commit");

    // Before: wip is not in any stack.
    const before = JSON.parse((await runCli(["stacks", "--json"])).stdout);
    const branchesBefore = before.stacks.flatMap((s: any) => s.branches.map((b: any) => b.branch));
    expect(branchesBefore).not.toContain("wip");

    // Add it.
    const res = await runCli(["add"]);
    expect(res.exitCode).toBe(0);

    // After: wip is tracked with parent pr3.
    const after = JSON.parse((await runCli(["stacks", "--json"])).stdout);
    const allBranches = after.stacks.flatMap((s: any) => s.branches);
    const wip = allBranches.find((b: any) => b.branch === "wip");
    expect(wip).toBeDefined();
    expect(wip.parent).toBe("pr3");
    expect(wip.pr).toBeNull(); // no PR — nothing was published
  });

  test("is idempotent — adding an already-tracked branch reports and changes nothing", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr2");

    const res = await runCli(["add"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout + res.stderr).toContain("already tracked");

    const after = JSON.parse((await runCli(["stacks", "--json"])).stdout);
    const names = after.stacks.flatMap((s: any) => s.branches.map((b: any) => b.branch));
    expect(names.filter((n: string) => n === "pr2")).toHaveLength(1);
  });

  test("can target a branch by name without checking it out", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");
    const proc = Bun.spawn(["git", "-C", tmpDir, "checkout", "-q", "-b", "wip"]);
    await proc.exited;
    await makeCommit(tmpDir, "wip.txt", "wip\n", "wip commit");
    await checkout(tmpDir, "main"); // stand somewhere else

    const res = await runCli(["add", "wip"]);
    expect(res.exitCode).toBe(0);

    const after = JSON.parse((await runCli(["stacks", "--json"])).stdout);
    const wip = after.stacks.flatMap((s: any) => s.branches).find((b: any) => b.branch === "wip");
    expect(wip?.parent).toBe("pr3");
  });

  test("refuses a branch that doesn't exist locally", async () => {
    await createLinearStack(tmpDir);
    const res = await runCli(["add", "ghost-branch"]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout + res.stderr).toContain("doesn't exist locally");
  });

  test("sync points an untracked branch at `gh-stack add`", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");
    const proc = Bun.spawn(["git", "-C", tmpDir, "checkout", "-q", "-b", "wip"]);
    await proc.exited;
    await makeCommit(tmpDir, "wip.txt", "wip\n", "wip commit");

    const res = await runCli(["sync"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout + res.stderr).toContain("gh-stack add");
  });
});
