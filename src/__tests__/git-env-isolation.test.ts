// Regression: tests must never touch the enclosing git repository.
//
// The pre-push hook runs `bun test`, and git exports GIT_DIR to hooks (an
// absolute path in a linked worktree). Before this was guarded, the helpers'
// `git branch -M main`, `git config user.*` and `git init --bare` ran against
// the real repo: the pushed branch was renamed over local main, and core.bare
// was set to true. Two layers guard it: the hook clears the variables, and the
// bunfig preload scrubs them for the suite (including bare Bun.spawn calls).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "../..");

async function snapshot(gitDir: string) {
  const git = (args: string[]) => $`git --git-dir=${gitDir} ${args}`.nothrow().text();
  return {
    head: (await git(["symbolic-ref", "HEAD"])).trim(),
    refs: (await git(["for-each-ref", "--format=%(refname) %(objectname)"])).trim(),
    config: await fs.readFile(path.join(gitDir, "config"), "utf8"),
  };
}

describe("git env isolation", () => {
  test("GIT_DIR from a hook does not leak into the test helpers", async () => {
    const victim = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-victim-"));
    try {
      await $`git init -q -b keepme ${victim}`.quiet();
      await $`git -C ${victim} -c user.email=v@v -c user.name=V commit -q --allow-empty -m victim`.quiet();
      const gitDir = path.join(victim, ".git");
      const before = await snapshot(gitDir);

      const proc = Bun.spawn(["bun", "test", "./src/__tests__/fixtures/git-env.fixture.ts"], {
        cwd: repoRoot,
        env: { ...process.env, GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(gitDir, "index") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output =
        (await new Response(proc.stderr).text()) + (await new Response(proc.stdout).text());
      const exitCode = await proc.exited;

      expect(await snapshot(gitDir)).toEqual(before);
      expect(output).toContain("1 pass");
      expect(exitCode).toBe(0);
    } finally {
      await fs.rm(victim, { recursive: true, force: true });
    }
  }, 60_000);

  // A push made by `GH_STACK_YES=1 gh-stack submit` runs the hook with
  // GH_STACK_YES set, and tests of interactive behavior failed under it, so
  // git refused the push.
  test("GH_STACK_* variables from a hook do not reach the tests", async () => {
    const proc = Bun.spawn(["bun", "test", "./src/__tests__/fixtures/gh-stack-env.fixture.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GH_STACK_YES: "1",
        GH_STACK_PLAIN: "1",
        GH_STACK_NO_COLOR: "1",
        GH_STACK_DRAFT: "1",
        GH_STACK_NO_PUSH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      (await new Response(proc.stderr).text()) + (await new Response(proc.stdout).text());

    expect(output).toContain("1 pass");
    expect(await proc.exited).toBe(0);
  }, 60_000);

  // gh-stack shows only the end of a failed push's output, and Bun doesn't
  // repeat its failures at the end, so the hook lists them last.
  test("pre-push lists the failing tests at the end of its output", async () => {
    const stubDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-stub-"));
    try {
      await Bun.write(
        path.join(stubDir, "bun"),
        [
          "#!/bin/sh",
          'echo "(pass) suite > fine"',
          'echo "(fail) suite > first broken test"',
          'echo "lots of other output"',
          'echo "(fail) other > second broken test"',
          'echo " 1 pass"',
          'echo " 2 fail"',
          "exit 1",
          "",
        ].join("\n"),
      );
      await fs.chmod(path.join(stubDir, "bun"), 0o755);

      const proc = Bun.spawn(["sh", "-e", path.join(repoRoot, ".husky/pre-push")], {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();

      expect(await proc.exited).toBe(1);
      expect(output.trimEnd()).toEndWith(
        [
          "Failing tests:",
          "(fail) suite > first broken test",
          "(fail) other > second broken test",
        ].join("\n"),
      );
    } finally {
      await fs.rm(stubDir, { recursive: true, force: true });
    }
  });

  // The hook itself, run the way husky runs it (`sh -e`), with a stub `bun`
  // that reports what it inherited and fails.
  test("pre-push clears GIT_DIR and prints a failing check's output", async () => {
    const stubDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-stub-"));
    try {
      await Bun.write(
        path.join(stubDir, "bun"),
        '#!/bin/sh\necho "stub saw GIT_DIR=${GIT_DIR:-unset} GIT_INDEX_FILE=${GIT_INDEX_FILE:-unset}"\nexit 1\n',
      );
      await fs.chmod(path.join(stubDir, "bun"), 0o755);

      const proc = Bun.spawn(["sh", "-e", path.join(repoRoot, ".husky/pre-push")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH}`,
          GIT_DIR: "/nonexistent/leaked-git-dir",
          GIT_INDEX_FILE: "/nonexistent/leaked-index",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output =
        (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());

      expect(await proc.exited).toBe(1);
      expect(output).toContain("stub saw GIT_DIR=unset GIT_INDEX_FILE=unset");
    } finally {
      await fs.rm(stubDir, { recursive: true, force: true });
    }
  });
});
