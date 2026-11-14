// Lock contention mid-restack (#69). Another process taking index.lock right
// after a push used to crash the next checkout with a ShellError, or turn a
// rebase that never started into a "Rebase Conflict". Now a brief lock is
// waited out, and one that never frees is reported as a lock with the
// resume command.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import {
  checkout,
  cleanup,
  createGhStub,
  createLinearStack,
  createTempRepo,
  makeCommit,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";

// Builds repos and spawns the CLI; the lock that never frees costs ~5 s of retries.
setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let stubDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = "";
  stubDir = await createGhStub();
});

afterEach(async () => {
  await cleanup(tmpDir, stubDir);
  if (remoteDir) await cleanup(remoteDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

/** Run the CLI; `onStderr` sees all stderr so far each time more arrives. */
async function runCli(args: string[], onStderr?: (stderrSoFar: string) => void) {
  const base = { ...process.env } as Record<string, string>;
  delete base.GH_STACK_NO_PUSH;
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...base,
      PATH: `${stubDir}:${process.env.PATH}`,
      GH_LOG: `${stubDir}/calls.log`,
      NO_COLOR: "1",
      GH_STACK_NO_COLOR: "1",
      GH_STACK_YES: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const readStderr = async () => {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) {
      text += decoder.decode(chunk, { stream: true });
      onStderr?.(text);
    }
    return text;
  };
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    readStderr(),
    proc.exited,
  ]);
  return { exitCode, out: stdout + stderr };
}

async function isAncestor(a: string, b: string): Promise<boolean> {
  const { exitCode } = await $`git -C ${tmpDir} merge-base --is-ancestor ${a} ${b}`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

/** main → pr1 → pr2 → pr3, all on origin, then a new commit on pr1. */
async function stackNeedingRestack(): Promise<void> {
  await createLinearStack(tmpDir);
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  await checkout(tmpDir, "pr1");
  await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");
}

/**
 * When pr1's push arrives, the remote's hook takes the *local* repo's
 * index.lock, as a background `git status` would, and keeps it. (The hook
 * can't release it later itself: git waits for any job the hook leaves
 * running, so the lock would be gone before the push even returned.)
 */
async function lockIndexWhenPr1IsPushed(): Promise<string> {
  const lock = `${tmpDir}/.git/index.lock`;
  const hook = `${remoteDir}/hooks/pre-receive`;
  await Bun.write(
    hook,
    `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/pr1" ]; then touch "${lock}"; fi
done
exit 0
`,
  );
  await fs.chmod(hook, 0o755);
  return lock;
}

describe("restack with index.lock briefly held (#69)", () => {
  test("waits out a lock taken right after a push, and finishes the chain", async () => {
    await stackNeedingRestack();
    const lock = await lockIndexWhenPr1IsPushed();

    // Free the lock once gh-stack says it's waiting on it (#86). Removing it a
    // fixed time after it appeared raced under load: when gh-stack's next
    // locking step came later than that, it never had to wait.
    let freed = false;
    const { exitCode, out } = await runCli(["restack"], (stderr) => {
      if (freed || !stderr.includes("index.lock; waiting for it to finish")) return;
      freed = true;
      void fs.rm(lock, { force: true });
    });

    expect(out).toContain("index.lock; waiting for it to finish");
    expect(out).not.toContain("Rebase Conflict");
    expect(exitCode).toBe(0);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
  });

  test("a lock that never frees: reported as a lock with the resume command, then resumes", async () => {
    await stackNeedingRestack();
    const lock = await lockIndexWhenPr1IsPushed();

    const stopped = await runCli(["restack"]);

    expect(stopped.exitCode).toBe(1);
    expect(stopped.out).toContain("another git process holds");
    expect(stopped.out).toContain("index.lock, and still did after waiting 5.1s");
    expect(stopped.out).toContain("gh-stack restack --resume");
    expect(stopped.out).not.toContain("Rebase Conflict");
    expect(stopped.out).not.toContain("ShellError");
    // The hook's `touch` left a lock file that nobody has open (#71).
    expect(stopped.out).toContain("No process has it open, so it's stale");
    expect(await isAncestor("pr1", "pr2")).toBe(false); // stopped before pr2

    await fs.rm(lock);
    await fs.rm(`${remoteDir}/hooks/pre-receive`);
    const resumed = await runCli(["restack", "--resume"]);

    expect(resumed.exitCode).toBe(0);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
  });
});
