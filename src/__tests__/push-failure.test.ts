// A push refused by a local pre-push hook used to report only git's last line,
// "error: failed to push some refs", and drop the hook's own output, which
// says why. gh-stack shows the end of git's output, the lines above it that
// look like the failure (a hook can fail early and then print pages of
// warnings, #80), and saves all of it to .git/.gh-stack/push-failure.log.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import * as gitLib from "../lib/git.ts";
import {
  checkout,
  cleanup,
  createBranch,
  createTempRepo,
  makeCommit,
  setupRemote,
} from "./helpers.ts";

let tmpDir: string;
let remoteDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = await setupRemote(tmpDir);
  await createBranch(tmpDir, "pr1");
  await checkout(tmpDir, "pr1");
  await makeCommit(tmpDir, "pr1.txt", "pr1\n", "pr1: change");
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanup(tmpDir, remoteDir);
});

/** Install a pre-push hook that runs `body` (sh) and refuses the push. */
async function installFailingHook(body: string): Promise<void> {
  const hooksDir = path.join(tmpDir, "test-hooks");
  await fs.mkdir(hooksDir);
  const hook = path.join(hooksDir, "pre-push");
  await Bun.write(hook, `#!/bin/sh\n${body}\nexit 1\n`);
  await fs.chmod(hook, 0o755);
  await $`git -C ${tmpDir} config core.hooksPath ${hooksDir}`.quiet();
}

/** sh that prints `n` numbered lines with the given prefix. */
function printLines(n: number, prefix: string): string {
  return `i=1\nwhile [ $i -le ${n} ]; do echo "${prefix} $i"; i=$((i+1)); done`;
}

/** A refused push with this output, as forcePushWithLease reports it. */
function rejected(lines: string[]): gitLib.PushResult {
  return {
    ok: false,
    reason: "rejected",
    output: `${lines.join("\n")}\n`,
    logFile: "/repo/.git/.gh-stack/push-failure.log",
  };
}

/** n numbered Biome-style warning lines (not failures). */
function warnings(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `  ! Unexpected any. Specify a different type. (${i + 1})`,
  );
}

describe("push refused by a pre-push hook", () => {
  test("the hint shows the end of the hook's output and points at the full log", async () => {
    await installFailingHook(
      `${printLines(50, "hook line")}\necho "(fail) suite > the broken test"`,
    );

    const result = await gitLib.forcePushWithLease("pr1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rejected");
    const hint = gitLib.pushFailureHint("pr1", result);
    const text = hint.join("\n");
    expect(text).toContain("(fail) suite > the broken test");
    expect(text).toContain("failed to push some refs");
    expect(text).toContain("hook line 50");
    expect(text).not.toContain("hook line 1\n");
    expect(text).toMatch(/Full output \(\d+ lines\): .*\.gh-stack\/push-failure\.log/);

    const saved = await Bun.file(result.logFile!).text();
    expect(saved).toContain("hook line 1\n");
    expect(saved).toContain("(fail) suite > the broken test");
  });

  test("short output is shown whole, and still points at the log", async () => {
    await installFailingHook(
      `${printLines(2, "hook line")}\necho "(fail) suite > the broken test"`,
    );

    const result = await gitLib.forcePushWithLease("pr1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = gitLib.pushFailureHint("pr1", result).join("\n");
    expect(text).toContain("hook line 1");
    expect(text).toContain("(fail) suite > the broken test");
    expect(text).not.toContain("look like the failure");
    expect(text).toMatch(/Full output \(\d+ lines\): .*push-failure\.log/);
  });

  test("a check that fails early, then pages of warnings: the failing lines come first (#80)", async () => {
    // swarm's hook: a check fails with ❌, later checks keep going and print
    // Biome warnings, then husky reports the script failed.
    await installFailingHook(
      [
        'echo "📝 Checking dream-components exports are up to date..."',
        'echo "❌ dream-components exports are out of date."',
        'echo "   The regenerated index files are now in your working tree."',
        printLines(60, "  ! Unexpected any. Specify a different type."),
        'echo "Found 60 warnings."',
        'echo "✅ Biome check passed"',
        'echo "husky - pre-push script failed (code 1)"',
      ].join("\n"),
    );

    const result = await gitLib.forcePushWithLease("pr1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const hint = gitLib.pushFailureHint("pr1", result);
    expect(hint[0]).toBe("git push failed. These lines above the end look like the failure:");
    expect(hint.slice(1, 4)).toEqual([
      "  📝 Checking dream-components exports are up to date...",
      "  ❌ dream-components exports are out of date.",
      "     The regenerated index files are now in your working tree.",
    ]);
    const tailAt = hint.indexOf("The end of its output:");
    expect(tailAt).toBeGreaterThan(3);
    expect(hint.slice(tailAt).join("\n")).toContain("husky - pre-push script failed (code 1)");
    expect(hint.at(-1)).toMatch(/^Full output \(\d+ lines\): .*push-failure\.log$/);
    expect(gitLib.pushFailureLine(result)).toBe("❌ dream-components exports are out of date");
  });
});

describe("pushFailureHint: finding the failure", () => {
  test("a failure inside the end isn't repeated above it", () => {
    const result = rejected([
      ...warnings(30),
      "❌ Rubocop found issues on your changed lines. Fix them before committing.",
      "husky - pre-push script failed (code 1)",
      "error: failed to push some refs to 'origin'",
    ]);

    const hint = gitLib.pushFailureHint("pr1", result);
    expect(hint[0]).toBe(
      "git push failed. The end of its output (a pre-push hook prints here too):",
    );
    expect(hint.filter((l) => l.includes("❌"))).toHaveLength(1);
    expect(gitLib.pushFailureLine(result)).toBe(
      "❌ Rubocop found issues on your changed lines. Fix them before committing",
    );
  });

  test("passing counts and git's own trailer lines are not failures", () => {
    // "failed" and "error" are failure words, but not with a zero count.
    const result = rejected([
      "Tests: 0 failed, 12 passed",
      " 0 fail",
      "No error found",
      "Found 0 errors.",
      "husky - pre-push script failed (code 1)",
      "error: failed to push some refs to 'origin'",
      ...warnings(30),
    ]);

    expect(gitLib.pushFailureHint("pr1", result)[0]).toContain("The end of its output");
  });

  test("markers from common tools are found above the end", () => {
    for (const marker of [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  × Formatter would have printed the following content:",
      "FAIL src/thing.test.ts",
      "(fail) suite > broken",
      "3 failed",
      "Found 2 errors.",
      "✖ 4 problems (4 errors, 0 warnings)",
      "Process exited with code 2",
      " ! [remote rejected] pr1 -> pr1 (pre-receive hook declined)",
    ]) {
      const hint = gitLib.pushFailureHint("pr1", rejected(["start", marker, ...warnings(30)]));
      const found = hint.includes(`  ${marker}`) && !!hint[0]?.includes("look like");
      expect({ marker, found }).toEqual({ marker, found: true });
    }
  });

  test("a runner's 'command failed' from a tolerated step doesn't hide the check that failed", () => {
    // An optional step fails (and the hook carries on), then a real check fails.
    const result = rejected([
      "📝 Optional: checking bundle budget...",
      "[ELIFECYCLE] Command failed with exit code 1.",
      "📝 Checking Ruby files with rubocop...",
      "❌ Rubocop found issues on your changed lines.",
      "husky - pre-push script failed (code 1)",
    ]);

    expect(gitLib.pushFailureLine(result)).toBe("❌ Rubocop found issues on your changed lines");
  });

  test("no marker at all: the line is the runner's 'script failed', and the end is shown", () => {
    // swarm's Blossom check prints its findings with no failure symbol.
    const result = rejected([
      "📝 Checking new Blossom color tokens...",
      "New legacy Blossom color tokens:",
      "  client/src/EditModal.tsx:121: `primary` is a legacy Blossom color.",
      "husky - pre-push script failed (code 1)",
      "error: failed to push some refs to 'origin'",
    ]);

    expect(gitLib.pushFailureLine(result)).toBe("husky - pre-push script failed (code 1)");
    expect(gitLib.pushFailureHint("pr1", result).join("\n")).toContain(
      "New legacy Blossom color tokens:",
    );
  });

  test("separate failures are shown with context, gaps marked, and capped", () => {
    const lines = ["start"];
    for (let i = 1; i <= 20; i++)
      lines.push(`ctx ${i}a`, `(fail) test ${i}`, `ctx ${i}b`, ...warnings(5));
    const hint = gitLib.pushFailureHint("pr1", rejected([...lines, ...warnings(30)]));

    const excerpt = hint.slice(1, hint.indexOf("The end of its output:"));
    expect(excerpt.slice(0, 6)).toEqual([
      "  start",
      "  ctx 1a",
      "  (fail) test 1",
      "  ctx 1b",
      "    ! Unexpected any. Specify a different type. (1)",
      "  …",
    ]);
    expect(excerpt.filter((l) => l !== "  …").length).toBe(24);
    expect(excerpt.join("\n")).not.toContain("(fail) test 20");
  });

  test("a lease refusal has no failure line", () => {
    expect(
      gitLib.pushFailureLine({ ok: false, reason: "stale-lease", output: "stale info\n" }),
    ).toBeUndefined();
    expect(gitLib.pushFailureLine({ ok: true })).toBeUndefined();
  });
});
