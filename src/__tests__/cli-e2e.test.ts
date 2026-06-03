import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkout,
  cleanup,
  createBranch,
  createLinearStack,
  createTempRepo,
  makeCommit,
  readMetadata,
  writeMetadata,
} from "./helpers.ts";

const cliPath = new URL("../index.ts", import.meta.url).pathname;

let tmpDir: string;
let originalCwd: string;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanup(tmpDir);
});

async function runCli(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...process.env,
      NO_COLOR: "1",
      GH_STACK_NO_COLOR: "1",
    },
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

describe("CLI entrypoint", () => {
  test("supports leading global flags before the command", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr1");

    const result = await runCli(["--yes", "sync", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sync dry run complete");

    const meta = await readMetadata(tmpDir);
    expect(meta.snapshots).toBeUndefined();
  });

  test("prints global help with --help and no command", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(result.stdout).toContain("CORE WORKFLOW");
  });

  test("returns an error for unknown commands", async () => {
    const result = await runCli(["definitely-not-a-command"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command");
  });

  // `log` (the default command) guidance when the branch isn't tracked.
  test("log points an untracked branch stacked on another at `submit`, with the chain", async () => {
    await createLinearStack(tmpDir); // a v3 store exists; this branch is separate
    await createBranch(tmpDir, "feat-a", "main");
    await makeCommit(tmpDir, "a.txt", "a\n", "feat-a: work");
    await createBranch(tmpDir, "feat-b", "feat-a");
    await makeCommit(tmpDir, "b.txt", "b\n", "feat-b: work");
    await checkout(tmpDir, "feat-b");

    const result = await runCli(["log"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("isn't tracked in a stack yet");
    expect(result.stdout).toContain("stacked on 1 other local branch");
    expect(result.stdout).toContain("feat-a");
    expect(result.stdout).toContain("gh-stack submit");
  });

  test("log points an untracked branch off main at `submit`", async () => {
    await createLinearStack(tmpDir);
    await createBranch(tmpDir, "solo", "main");
    await makeCommit(tmpDir, "s.txt", "s\n", "solo: work");
    await checkout(tmpDir, "solo");

    const result = await runCli(["log"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("isn't tracked in a stack yet");
    expect(result.stdout).toContain("based directly on main");
    expect(result.stdout).toContain("gh-stack submit");
  });

  test("log on main suggests init, not submit", async () => {
    await createLinearStack(tmpDir); // leaves HEAD on main
    const result = await runCli(["log"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not a stack branch");
    expect(result.stdout).toContain("gh-stack init");
    expect(result.stdout).not.toContain("gh-stack submit");
  });

  test("rejects destructive commands when stack metadata is invalid", async () => {
    const { meta } = await createLinearStack(tmpDir);
    meta.stacks["test-stack"]!.branches["pr3"]!.parent = "ghost-parent";
    await writeMetadata(tmpDir, meta);
    await checkout(tmpDir, "pr2");

    const result = await runCli(["restack", "--dry-run"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Invalid stack metadata");
    expect(result.stdout).toContain('unknown parent "ghost-parent"');
  });
});
