import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkout, cleanup, createLinearStack, createTempRepo, readMetadata } from "./helpers.ts";

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
    expect(result.stdout).toContain("COMMANDS");
  });

  test("returns an error for unknown commands", async () => {
    const result = await runCli(["definitely-not-a-command"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command");
  });

  test("rejects destructive commands when stack metadata is invalid", async () => {
    const { meta } = await createLinearStack(tmpDir);
    meta.stacks["test-stack"]!.branches["pr3"]!.parent = "ghost-parent";
    await Bun.write(`${tmpDir}/.git/gh-stack-metadata.json`, JSON.stringify(meta, null, 2) + "\n");
    await checkout(tmpDir, "pr2");

    const result = await runCli(["restack", "--dry-run"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Invalid stack metadata");
    expect(result.stdout).toContain('unknown parent "ghost-parent"');
  });
});
