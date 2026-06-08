// Tests for `gh-stack learn` — the agent-skill command. Verifies the stdout
// dump, per-harness install paths, --global, and overwrite behavior. The skill
// text is compiled into the binary (src/lib/skill.ts), so these also guard that
// what ships stays in sync with the running version.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, createTempRepo } from "./helpers.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
});

afterEach(async () => {
  await cleanup(tmpDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;
const { version: VERSION } = await import("../../package.json");

async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: { ...process.env, NO_COLOR: "1", GH_STACK_NO_COLOR: "1", ...extraEnv },
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

describe("learn (stdout)", () => {
  test("prints the skill stamped with the current version", async () => {
    const { exitCode, stdout } = await runCli(["learn"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("name: using-gh-stack");
    expect(stdout).toContain("# Using gh-stack");
    expect(stdout).toContain(`gh-stack v${VERSION}`);
    // It documents the v3 metadata store, not the old v2 monolith.
    expect(stdout).toContain(".git/.gh-stack/");
    expect(stdout).not.toContain("gh-stack-metadata.json\n```"); // no stale v2 schema block
  });

  test("does not install anything in plain stdout mode", async () => {
    await runCli(["learn"]);
    expect(await Bun.file(join(tmpDir, ".claude/skills/using-gh-stack/SKILL.md")).exists()).toBe(
      false,
    );
  });

  test("prints the skill even outside a git repo", async () => {
    const nonRepo = await fs.mkdtemp(join(tmpdir(), "gh-stack-norepo-"));
    try {
      const proc = Bun.spawn(["bun", "run", cliPath, "learn"], {
        cwd: nonRepo,
        env: { ...process.env, NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("# Using gh-stack");
    } finally {
      await fs.rm(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("learn --skill (install)", () => {
  test.each([
    ["claude", ".claude"],
    ["codex", ".codex"],
    ["cursor", ".cursor"],
  ])("installs into the %s project path", async (harness, dir) => {
    const { exitCode } = await runCli(["learn", "--skill", "--harness", harness], {
      GH_STACK_YES: "1",
    });
    expect(exitCode).toBe(0);
    const target = join(tmpDir, dir, "skills/using-gh-stack/SKILL.md");
    expect(await Bun.file(target).exists()).toBe(true);
    expect(await Bun.file(target).text()).toContain("# Using gh-stack");
  });

  test("installs to the repo root even when run from a subdirectory", async () => {
    await fs.mkdir(join(tmpDir, "packages/app"), { recursive: true });
    const proc = Bun.spawn(["bun", "run", cliPath, "learn", "--skill", "--harness", "claude"], {
      cwd: join(tmpDir, "packages/app"),
      env: { ...process.env, NO_COLOR: "1", GH_STACK_YES: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    // Lands at the worktree root, not the nested cwd.
    expect(await Bun.file(join(tmpDir, ".claude/skills/using-gh-stack/SKILL.md")).exists()).toBe(
      true,
    );
    expect(
      await Bun.file(join(tmpDir, "packages/app/.claude/skills/using-gh-stack/SKILL.md")).exists(),
    ).toBe(false);
  });

  test("rejects an unknown harness", async () => {
    const { exitCode, stderr, stdout } = await runCli(["learn", "--skill", "--harness", "vim"], {
      GH_STACK_YES: "1",
    });
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("Unknown harness");
  });

  test("requires an explicit harness in non-interactive mode", async () => {
    const { exitCode, stdout, stderr } = await runCli(["learn", "--skill"], { GH_STACK_YES: "1" });
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("explicit harness");
  });

  test("overwrites an existing skill under --yes (no prompt)", async () => {
    const target = join(tmpDir, ".codex/skills/using-gh-stack/SKILL.md");
    await fs.mkdir(join(tmpDir, ".codex/skills/using-gh-stack"), { recursive: true });
    await Bun.write(target, "STALE CONTENT");

    const { exitCode } = await runCli(["learn", "--skill", "--harness", "codex"], {
      GH_STACK_YES: "1",
    });
    expect(exitCode).toBe(0);
    const written = await Bun.file(target).text();
    expect(written).not.toContain("STALE CONTENT");
    expect(written).toContain("# Using gh-stack");
  });
});
