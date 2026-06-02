// Tests for `gh-stack stacks` — the network-free topology dump that external
// tools consume instead of parsing the .git/.gh-stack/ store directly.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkout, cleanup, createLinearStack, createTempRepo } from "./helpers.ts";

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

describe("stacks --json", () => {
  test("emits ordered topology with PR numbers and base", async () => {
    await createLinearStack(tmpDir); // main → pr1 → pr2 → pr3, leaves us on main

    const { exitCode, stdout } = await runCli(["stacks", "--json"]);
    expect(exitCode).toBe(0);

    const data = JSON.parse(stdout);
    expect(data.stacks).toHaveLength(1);

    const stack = data.stacks[0];
    expect(stack.name).toBe("test-stack");
    expect(stack.base).toBe("main");
    expect(stack.branches.map((b: any) => b.branch)).toEqual(["pr1", "pr2", "pr3"]);
    expect(stack.branches.map((b: any) => b.pr)).toEqual([1, 2, 3]);
    expect(stack.branches[0].parent).toBe("main");
    expect(stack.branches[2].parent).toBe("pr2");
  });

  test("is_current and current_branch reflect the checked-out branch", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr2");

    const { stdout } = await runCli(["stacks", "--json"]);
    const data = JSON.parse(stdout);

    expect(data.current_branch).toBe("pr2");
    expect(data.current_stack).toBe("test-stack");
    expect(data.stacks[0].is_current).toBe(true);
  });

  test("--current narrows to the current branch's stack", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr1");

    const { stdout } = await runCli(["stacks", "--json", "--current"]);
    const data = JSON.parse(stdout);

    expect(data.stacks).toHaveLength(1);
    expect(data.stacks[0].name).toBe("test-stack");
  });

  test("emits a valid empty result when there is no metadata", async () => {
    const { exitCode, stdout } = await runCli(["stacks", "--json"]);
    expect(exitCode).toBe(0);

    const data = JSON.parse(stdout);
    expect(data.stacks).toEqual([]);
    expect(data.current_stack).toBeNull();
  });

  test("does not mutate metadata (read-only)", async () => {
    await createLinearStack(tmpDir);
    const before = await Bun.file(
      `${tmpDir}/.git/.gh-stack/active/${encodeURIComponent("test-stack")}.json`,
    ).text();

    await runCli(["stacks", "--json"]);

    const after = await Bun.file(
      `${tmpDir}/.git/.gh-stack/active/${encodeURIComponent("test-stack")}.json`,
    ).text();
    expect(after).toBe(before);
  });
});

describe("stacks (human)", () => {
  test("lists the stack name and branch numbers", async () => {
    await createLinearStack(tmpDir);

    const { exitCode, stdout } = await runCli(["stacks"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("test-stack");
    expect(stdout).toContain("1. pr1");
    expect(stdout).toContain("3. pr3");
  });
});
