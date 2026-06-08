// Tests for the post-restack sync verification (#23): it must judge "in sync"
// against the REAL remote (git ls-remote), not the local remote-tracking ref,
// which a force-push can leave stale even though the push landed. The #12 guard
// — catching a genuinely un-pushed ref — must still hold.
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
import { findStaleRefs } from "../commands/restack.ts";

let tmpDir: string;
let remoteDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanup(tmpDir);
  if (remoteDir) await $`rm -rf ${remoteDir}`.quiet().nothrow();
});

describe("findStaleRefs trusts the real remote, not the tracking ref (#23)", () => {
  test("a stale local tracking ref is NOT reported when the push actually landed", async () => {
    await createLinearStack(tmpDir); // main → pr1 → pr2 → pr3
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);

    // Simulate the #23 condition: the push landed on origin, but the local
    // remote-tracking ref was left pointing at an OLD sha (what a force-push
    // can do in some environments). Rewind refs/remotes/origin/pr2 to pr2's
    // parent so `rev-parse origin/pr2` lies, while ls-remote still sees truth.
    const oldSha = (await $`git rev-parse pr1`.text()).trim();
    await $`git update-ref refs/remotes/origin/pr2 ${oldSha}`;

    // Sanity: the stale tracking ref disagrees with both local and the remote.
    const trackingSha = (await $`git rev-parse origin/pr2`.text()).trim();
    const localSha = (await $`git rev-parse pr2`.text()).trim();
    expect(trackingSha).toBe(oldSha);
    expect(trackingSha).not.toBe(localSha);

    const stale = await findStaleRefs(["pr1", "pr2", "pr3"]);
    expect(stale).toEqual([]); // ls-remote sees pr2 in sync → no false positive
  });

  test("a genuinely un-pushed ref is still reported (no #12 regression)", async () => {
    await createLinearStack(tmpDir);
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);

    // New commit on pr2 that is NOT pushed → origin really is behind.
    await checkout(tmpDir, "pr2");
    await makeCommit(tmpDir, "pr2-extra.txt", "x\n", "unpushed work on pr2");
    const localSha = (await $`git rev-parse pr2`.text()).trim();

    const stale = await findStaleRefs(["pr1", "pr2", "pr3"]);
    expect(stale.map((s) => s.branch)).toEqual(["pr2"]);
    expect(stale[0]!.local).toBe(localSha);
  });

  test("a branch missing from origin is reported as (missing)", async () => {
    await createLinearStack(tmpDir);
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);

    // Delete pr3 from the remote entirely.
    await $`git push origin --delete pr3`.quiet().nothrow();

    const stale = await findStaleRefs(["pr1", "pr2", "pr3"]);
    expect(stale.map((s) => s.branch)).toEqual(["pr3"]);
    expect(stale[0]!.remote).toBe("(missing)");
  });
});
