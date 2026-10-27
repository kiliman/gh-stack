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

  // ── Symlinked skill dirs (#38) ──
  // Some setups manage ~/.claude/skills as per-skill symlinks into a
  // version-controlled skills repo. Bun.write follows symlinks, so without an
  // lstat guard the install would silently overwrite the file in that repo.
  describe("symlinked skill dir", () => {
    let home: string;
    let skillsRepo: string;
    let realSkill: string;
    let linkedDir: string;

    beforeEach(async () => {
      home = await fs.mkdtemp(join(tmpdir(), "gh-stack-home-"));
      skillsRepo = await fs.mkdtemp(join(tmpdir(), "gh-stack-skills-repo-"));
      await fs.mkdir(join(skillsRepo, "using-gh-stack"));
      realSkill = join(skillsRepo, "using-gh-stack/SKILL.md");
      await Bun.write(realSkill, "MY HAND-MAINTAINED SKILL");
      await fs.mkdir(join(home, ".claude/skills"), { recursive: true });
      linkedDir = join(home, ".claude/skills/using-gh-stack");
      await fs.symlink(join(skillsRepo, "using-gh-stack"), linkedDir);
    });

    afterEach(async () => {
      await cleanup(home, skillsRepo);
    });

    test("refuses to write through it, even under GH_STACK_YES", async () => {
      const { exitCode, stdout, stderr } = await runCli(
        ["learn", "--skill", "--global", "--harness", "claude"],
        { HOME: home, GH_STACK_YES: "1" },
      );
      expect(exitCode).toBe(1);
      const out = stdout + stderr;
      expect(out).toContain("~/.claude/skills/using-gh-stack is a symlink to");
      expect(out).toContain(await fs.realpath(join(skillsRepo, "using-gh-stack")));
      expect(out).toContain("not writing through it");
      // The file in the skills repo is untouched, and the link is still a link.
      expect(await Bun.file(realSkill).text()).toBe("MY HAND-MAINTAINED SKILL");
      expect((await fs.lstat(linkedDir)).isSymbolicLink()).toBe(true);
    });

    test("--yes on the command line does not write through it either", async () => {
      const { exitCode } = await runCli(
        ["learn", "--skill", "-g", "--harness", "claude", "--yes"],
        {
          HOME: home,
        },
      );
      expect(exitCode).toBe(1);
      expect(await Bun.file(realSkill).text()).toBe("MY HAND-MAINTAINED SKILL");
    });

    test("--force writes through it", async () => {
      const { exitCode, stdout, stderr } = await runCli(
        ["learn", "--skill", "-g", "--harness", "claude", "--force"],
        { HOME: home, GH_STACK_YES: "1" },
      );
      expect(exitCode).toBe(0);
      expect(stdout + stderr).toContain("writing through it");
      expect(await Bun.file(realSkill).text()).toContain("# Using gh-stack");
      expect((await fs.lstat(linkedDir)).isSymbolicLink()).toBe(true);
    });

    test("--harness all installs the other harnesses and refuses the symlinked one", async () => {
      const { exitCode, stdout, stderr } = await runCli(
        ["learn", "--skill", "-g", "--harness", "all"],
        { HOME: home, GH_STACK_YES: "1" },
      );
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain("--harness claude --force");
      expect(await Bun.file(realSkill).text()).toBe("MY HAND-MAINTAINED SKILL");
      for (const dir of [".codex", ".cursor"]) {
        const target = join(home, dir, "skills/using-gh-stack/SKILL.md");
        expect(await Bun.file(target).text()).toContain("# Using gh-stack");
      }
    });
  });

  test("refuses a symlinked SKILL.md inside a real skill dir", async () => {
    const elsewhere = await fs.mkdtemp(join(tmpdir(), "gh-stack-elsewhere-"));
    try {
      const realFile = join(elsewhere, "SKILL.md");
      await Bun.write(realFile, "KEEP ME");
      await fs.mkdir(join(tmpDir, ".claude/skills/using-gh-stack"), { recursive: true });
      await fs.symlink(realFile, join(tmpDir, ".claude/skills/using-gh-stack/SKILL.md"));

      const { exitCode, stdout, stderr } = await runCli(
        ["learn", "--skill", "--harness", "claude"],
        { GH_STACK_YES: "1" },
      );
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain("SKILL.md is a symlink to");
      expect(await Bun.file(realFile).text()).toBe("KEEP ME");
    } finally {
      await cleanup(elsewhere);
    }
  });

  // ── Multiple harnesses (#38) ──
  test("--harness all installs for every harness", async () => {
    const { exitCode } = await runCli(["learn", "--skill", "--harness", "all"], {
      GH_STACK_YES: "1",
    });
    expect(exitCode).toBe(0);
    for (const dir of [".claude", ".codex", ".cursor"]) {
      expect(await Bun.file(join(tmpDir, dir, "skills/using-gh-stack/SKILL.md")).exists()).toBe(
        true,
      );
    }
  });

  test("a comma list installs only the named harnesses", async () => {
    const { exitCode } = await runCli(["learn", "--skill", "--harness", "claude,codex"], {
      GH_STACK_YES: "1",
    });
    expect(exitCode).toBe(0);
    const installed: Record<string, boolean> = {};
    for (const dir of [".claude", ".codex", ".cursor"]) {
      installed[dir] = await Bun.file(join(tmpDir, dir, "skills/using-gh-stack/SKILL.md")).exists();
    }
    expect(installed).toEqual({ ".claude": true, ".codex": true, ".cursor": false });
  });

  test.each([["claude,vim"], ["all,vim"]])(
    "an unknown name in %s rejects the whole run",
    async (list) => {
      const { exitCode, stdout, stderr } = await runCli(["learn", "--skill", "--harness", list], {
        GH_STACK_YES: "1",
      });
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain('Unknown harness "vim"');
      expect(await Bun.file(join(tmpDir, ".claude/skills/using-gh-stack/SKILL.md")).exists()).toBe(
        false,
      );
    },
  );
});
