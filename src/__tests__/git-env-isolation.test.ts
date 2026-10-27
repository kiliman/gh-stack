// Regression: tests must never touch the enclosing git repository.
//
// The pre-push hook runs `bun test`, and git exports GIT_DIR to hooks (an
// absolute path in a linked worktree). Before the preload in bunfig.toml
// scrubbed it, the helpers' `git branch -M main`, `git config user.*` and
// `git init --bare` ran against the real repo: the pushed branch was renamed
// over local main, and core.bare was set to true.
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
});
