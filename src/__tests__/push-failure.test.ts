// A push refused by a local pre-push hook used to report only git's last line,
// "error: failed to push some refs", and drop the hook's own output, which
// says why. gh-stack now shows the end of git's output and saves all of it to
// .git/.gh-stack/push-failure.log.
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

/** Install a pre-push hook that prints `lines` lines and refuses the push. */
async function installFailingHook(lines: number): Promise<void> {
  const hooksDir = path.join(tmpDir, "test-hooks");
  await fs.mkdir(hooksDir);
  const hook = path.join(hooksDir, "pre-push");
  await Bun.write(
    hook,
    `#!/bin/sh\ni=1\nwhile [ $i -le ${lines} ]; do echo "hook line $i"; i=$((i+1)); done\necho "(fail) suite > the broken test"\nexit 1\n`,
  );
  await fs.chmod(hook, 0o755);
  await $`git -C ${tmpDir} config core.hooksPath ${hooksDir}`.quiet();
}

describe("push refused by a pre-push hook", () => {
  test("the hint shows the end of the hook's output and points at the full log", async () => {
    await installFailingHook(50);

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

  test("short output is shown whole, with no pointer to the log", async () => {
    await installFailingHook(2);

    const result = await gitLib.forcePushWithLease("pr1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = gitLib.pushFailureHint("pr1", result).join("\n");
    expect(text).toContain("hook line 1");
    expect(text).toContain("(fail) suite > the broken test");
    expect(text).not.toContain("Full output");
  });
});
