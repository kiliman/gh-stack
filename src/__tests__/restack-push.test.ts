// Tests for restack pushing every branch ref it touches, including the
// committed/base branch, and ending with all refs in sync (issue #12).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  checkout,
  cleanup,
  createLinearStack,
  createTempRepo,
  makeCommit,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";
import restack from "../commands/restack.ts";
import { setAutoYes } from "../lib/ui.ts";

let tmpDir: string;
let remoteDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  setAutoYes(true); // auto-confirm every rebase + push
});

afterEach(async () => {
  setAutoYes(false);
  process.chdir(originalCwd);
  await cleanup(tmpDir);
  if (remoteDir) await $`rm -rf ${remoteDir}`.quiet().nothrow();
});

async function sha(ref: string): Promise<string> {
  return (await $`git -C ${tmpDir} rev-parse ${ref}`.text()).trim();
}

async function inSync(branch: string): Promise<boolean> {
  return (await sha(branch)) === (await sha(`origin/${branch}`));
}

describe("restack pushes every touched ref (#12)", () => {
  test("pushes the committed root branch AND rebased children", async () => {
    await createLinearStack(tmpDir); // main → pr1 → pr2 → pr3 (base main)
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);

    // Commit a fix on the ROOT branch (parent = main) — restack won't rebase
    // it, but its ref is now stale on origin and must be pushed.
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");

    await restack([]);

    expect(await inSync("pr1")).toBe(true); // committed root pushed
    expect(await inSync("pr2")).toBe(true); // rebased child pushed
    expect(await inSync("pr3")).toBe(true); // rebased child pushed
  });

  test("pushes the committed mid-stack branch even when it needs no rebase", async () => {
    await createLinearStack(tmpDir);
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);

    // Commit on pr2 (mid-stack). pr2 is "already up to date" with its parent
    // but stale on origin; pr3 gets rebased.
    await checkout(tmpDir, "pr2");
    await makeCommit(tmpDir, "pr2-fix.txt", "fix\n", "fix on pr2");

    await restack([]);

    expect(await inSync("pr2")).toBe(true);
    expect(await inSync("pr3")).toBe(true);
  });

  test("idempotent: re-pushes a stale ref on a no-op restack", async () => {
    await createLinearStack(tmpDir);
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);

    await checkout(tmpDir, "pr2");
    await makeCommit(tmpDir, "pr2-fix.txt", "fix\n", "fix on pr2");
    await restack([]);
    expect(await inSync("pr3")).toBe(true);

    // Rewind origin/pr3 behind local to simulate a ref that never landed,
    // then re-run restack — it should detect the drift and re-push.
    await $`git -C ${remoteDir} update-ref refs/heads/pr3 ${await sha("pr3~1")}`.quiet();
    await $`git -C ${tmpDir} fetch -q origin`.quiet();
    expect(await inSync("pr3")).toBe(false);

    await checkout(tmpDir, "pr3");
    await restack([]);

    expect(await inSync("pr3")).toBe(true);
  });
});
