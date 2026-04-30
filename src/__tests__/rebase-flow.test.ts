// Integration tests for rebase/sync flows using real temp git repos.
// These test the core tag-based rebase logic that prevents conflict re-surfacing.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import {
  createTempRepo,
  createLinearStack,
  createBranchingStack,
  makeCommit,
  checkout,
  getSha,
  isAncestor,
  setupRemote,
  pushAllBranches,
  cleanup,
} from "./helpers.ts";
import * as git from "../lib/git.ts";
import { saveRestackState, loadRestackState, clearRestackState } from "../lib/metadata.ts";
import { takeSnapshot, getLastSnapshot, findPreRewriteSha } from "../lib/snapshot.ts";
import undo from "../commands/undo.ts";
import { setAutoYes } from "../lib/ui.ts";

let tmpDir: string;
let remoteDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = await setupRemote(tmpDir);
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  setAutoYes(false);
  process.chdir(originalCwd);
  await cleanup(tmpDir, remoteDir);
});

// ────────────────────────────────────────────────────────
// Tag-based rebase accuracy
// ────────────────────────────────────────────────────────

describe("tag-based rebase: core correctness", () => {
  test("tags capture correct divergence points before rebase", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr2");

    // Get merge-base of pr2 and pr1 BEFORE any rebasing
    const mbBefore = (await $`git merge-base pr2 pr1`.text()).trim();

    // Create tag for pr2's base
    const tagName = git.tempBaseTagName("pr2");
    await git.createTag(tagName, mbBefore);

    // Now simulate rebasing pr1 (which changes its history)
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-update.txt", "updated\n", "pr1: update");

    // After pr1 changed, merge-base of pr2 and pr1 might be different
    await checkout(tmpDir, "pr2");

    // The tag still points to the original merge-base
    const tagSha = await git.revParse(tagName);
    expect(tagSha).toBe(mbBefore);

    // In this case they might be the same (pr1 only added a commit),
    // but the tag is our stable reference regardless
    expect(tagSha).toBeTruthy();
  });

  test("rebase --onto with tag moves only branch's own commits", async () => {
    await createLinearStack(tmpDir);

    // Add a new commit to pr1 (simulating review changes)
    await checkout(tmpDir, "pr1");
    const pr1UpdateSha = await makeCommit(
      tmpDir,
      "pr1-review-fix.txt",
      "review fix\n",
      "pr1: fix from review",
    );

    // Before rebasing pr2, tag the merge-base while history is intact
    await checkout(tmpDir, "pr2");
    const mb = (await $`git merge-base pr2 pr1`.text()).trim();
    await git.createTag(git.tempBaseTagName("pr2"), mb);

    // Now rebase pr2 onto pr1 using the tag
    const success = await git.rebaseOnto("pr1", git.tempBaseTagName("pr2"), "pr2");
    expect(success).toBe(true);

    // Verify: pr1 is now an ancestor of pr2
    expect(await isAncestor(tmpDir, "pr1", "pr2")).toBe(true);

    // Verify: pr2 has the pr1 review fix commit in its history
    const pr2HasFix = await isAncestor(tmpDir, pr1UpdateSha, "pr2");
    expect(pr2HasFix).toBe(true);

    // Verify: pr2 still has its own commit (pr2.txt should exist)
    await checkout(tmpDir, "pr2");
    const pr2FileExists = await Bun.file(`${tmpDir}/pr2.txt`).exists();
    expect(pr2FileExists).toBe(true);
  });

  test("tag-based rebase prevents replaying parent commits", async () => {
    await createLinearStack(tmpDir);

    // Count commits unique to pr2 (between pr1 and pr2)
    await checkout(tmpDir, "pr2");
    const commitsBefore = parseInt((await $`git rev-list --count pr1..pr2`.text()).trim(), 10);
    expect(commitsBefore).toBe(1); // Just pr2's own commit

    // Tag pr2's divergence point
    const mb = (await $`git merge-base pr2 pr1`.text()).trim();
    await git.createTag(git.tempBaseTagName("pr2"), mb);

    // Update pr1 with a new commit
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-new.txt", "new\n", "pr1: new commit");

    // Rebase pr2 using tag
    const success = await git.rebaseOnto("pr1", git.tempBaseTagName("pr2"), "pr2");
    expect(success).toBe(true);

    // Count pr2's unique commits after rebase — should still be 1
    const commitsAfter = parseInt((await $`git rev-list --count pr1..pr2`.text()).trim(), 10);
    expect(commitsAfter).toBe(1);
  });
});

// ────────────────────────────────────────────────────────
// Full chain rebase (simulating restack)
// ────────────────────────────────────────────────────────

describe("full chain rebase flow", () => {
  test("restacking 3-branch linear stack after pr1 update", async () => {
    await createLinearStack(tmpDir);

    // Update pr1 with review feedback
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "pr1: review fix");

    // Tag ALL branches before starting (like sync does)
    const branches = ["pr2", "pr3"];
    for (const branch of branches) {
      const parent = branch === "pr2" ? "pr1" : "pr2";
      const mb = (await $`git merge-base ${branch} ${parent}`.text()).trim();
      await git.createTag(git.tempBaseTagName(branch), mb);
    }

    // Rebase pr2 onto updated pr1
    const ok1 = await git.rebaseOnto("pr1", git.tempBaseTagName("pr2"), "pr2");
    expect(ok1).toBe(true);
    expect(await isAncestor(tmpDir, "pr1", "pr2")).toBe(true);

    // Rebase pr3 onto updated pr2
    const ok2 = await git.rebaseOnto("pr2", git.tempBaseTagName("pr3"), "pr3");
    expect(ok2).toBe(true);
    expect(await isAncestor(tmpDir, "pr2", "pr3")).toBe(true);

    // Verify full chain: pr1 → pr2 → pr3
    expect(await isAncestor(tmpDir, "pr1", "pr3")).toBe(true);

    // Each branch still has its unique files
    await checkout(tmpDir, "pr3");
    expect(await Bun.file(`${tmpDir}/pr1.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/pr1-fix.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/pr2.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/pr3.txt`).exists()).toBe(true);
  });

  test("already up-to-date branches are skipped", async () => {
    await createLinearStack(tmpDir);

    // Without any changes, pr2 is already based on pr1
    await checkout(tmpDir, "pr2");
    expect(await isAncestor(tmpDir, "pr1", "pr2")).toBe(true);

    // pr3 is already based on pr2
    expect(await isAncestor(tmpDir, "pr2", "pr3")).toBe(true);
  });

  test("branching stack: rebasing one subtree doesn't affect sibling", async () => {
    await createBranchingStack(tmpDir);

    // Update pr1
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "pr1: fix");

    // Save pr2a's SHA before rebasing
    const pr2aShaBefore = await getSha(tmpDir, "pr2a");

    // Tag pr2b and pr3
    const mb2b = (await $`git merge-base pr2b pr1`.text()).trim();
    await git.createTag(git.tempBaseTagName("pr2b"), mb2b);
    const mb3 = (await $`git merge-base pr3 pr2b`.text()).trim();
    await git.createTag(git.tempBaseTagName("pr3"), mb3);

    // Rebase only pr2b subtree (pr2b and pr3)
    await git.rebaseOnto("pr1", git.tempBaseTagName("pr2b"), "pr2b");
    await git.rebaseOnto("pr2b", git.tempBaseTagName("pr3"), "pr3");

    // pr2b and pr3 should now be on updated pr1
    expect(await isAncestor(tmpDir, "pr1", "pr2b")).toBe(true);
    expect(await isAncestor(tmpDir, "pr2b", "pr3")).toBe(true);

    // pr2a should be UNCHANGED (not rebased)
    const pr2aShaAfter = await getSha(tmpDir, "pr2a");
    expect(pr2aShaAfter).toBe(pr2aShaBefore);
  });
});

// ────────────────────────────────────────────────────────
// Sync flow: base rebase + child restack
// ────────────────────────────────────────────────────────

describe("sync flow: rebase base onto main then restack", () => {
  test("full sync: main update propagates through entire stack", async () => {
    await createLinearStack(tmpDir);

    // Push all branches so we have origin refs
    await pushAllBranches(tmpDir);

    // Add a commit to main (simulating merged PRs from other devs)
    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "main-update.txt", "new feature\n", "main: someone else's PR");
    await $`git -C ${tmpDir} push origin main`.quiet();

    // Fetch so origin/main is updated
    await $`git -C ${tmpDir} fetch origin`.quiet();

    // Tag ALL branches before any rebasing (this is the key fix!)
    const ordered = ["pr1", "pr2", "pr3"];
    for (const branch of ordered) {
      const parent = branch === "pr1" ? "origin/main" : ordered[ordered.indexOf(branch) - 1]!;
      const mb = (await $`git merge-base ${branch} ${parent}`.text()).trim();
      await git.createTag(git.tempBaseTagName(branch), mb);
    }

    // Step 1: Rebase pr1 onto origin/main
    await checkout(tmpDir, "pr1");
    const ok1 = await git.rebase("origin/main");
    expect(ok1).toBe(true);
    expect(await isAncestor(tmpDir, "origin/main", "pr1")).toBe(true);

    // Step 2: Restack pr2 onto updated pr1 (using tag)
    const ok2 = await git.rebaseOnto("pr1", git.tempBaseTagName("pr2"), "pr2");
    expect(ok2).toBe(true);
    expect(await isAncestor(tmpDir, "pr1", "pr2")).toBe(true);

    // Step 3: Restack pr3 onto updated pr2 (using tag)
    const ok3 = await git.rebaseOnto("pr2", git.tempBaseTagName("pr3"), "pr3");
    expect(ok3).toBe(true);
    expect(await isAncestor(tmpDir, "pr2", "pr3")).toBe(true);

    // Full chain intact
    expect(await isAncestor(tmpDir, "origin/main", "pr3")).toBe(true);

    // Verify main-update.txt propagated to all branches
    await checkout(tmpDir, "pr3");
    expect(await Bun.file(`${tmpDir}/main-update.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/pr1.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/pr2.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/pr3.txt`).exists()).toBe(true);
  });

  test("sync when base already up-to-date skips to children", async () => {
    await createLinearStack(tmpDir);
    await pushAllBranches(tmpDir);

    // No changes to main — pr1 is already up to date
    await $`git -C ${tmpDir} fetch origin`.quiet();

    await checkout(tmpDir, "pr1");
    expect(await isAncestor(tmpDir, "origin/main", "pr1")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────
// Tags created BEFORE rebase survive parent history changes
// ────────────────────────────────────────────────────────

describe("tag stability across rebases", () => {
  test("pr2 tag survives pr1 rebase and gives correct onto base", async () => {
    await createLinearStack(tmpDir);
    await pushAllBranches(tmpDir);

    // Advance main
    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "main-new.txt", "new\n", "main: advance");
    await $`git -C ${tmpDir} push origin main`.quiet();
    await $`git -C ${tmpDir} fetch origin`.quiet();

    // Tag ALL before any rebasing
    const mbPr1 = (await $`git merge-base pr1 origin/main`.text()).trim();
    await git.createTag(git.tempBaseTagName("pr1"), mbPr1);

    const mbPr2 = (await $`git merge-base pr2 pr1`.text()).trim();
    await git.createTag(git.tempBaseTagName("pr2"), mbPr2);

    const mbPr3 = (await $`git merge-base pr3 pr2`.text()).trim();
    await git.createTag(git.tempBaseTagName("pr3"), mbPr3);

    // Rebase pr1 onto origin/main — this changes pr1's history!
    await checkout(tmpDir, "pr1");
    await git.rebase("origin/main");

    // The tag should still point to the OLD merge-base
    const tagSha = await git.revParse(git.tempBaseTagName("pr2"));
    expect(tagSha).toBe(mbPr2);

    // Now rebase pr2 using the tag (not the wrong new merge-base)
    const ok = await git.rebaseOnto("pr1", git.tempBaseTagName("pr2"), "pr2");
    expect(ok).toBe(true);

    // Verify only pr2's commits moved
    const pr2CommitCount = parseInt((await $`git rev-list --count pr1..pr2`.text()).trim(), 10);
    expect(pr2CommitCount).toBe(1);

    // And the chain is correct
    expect(await isAncestor(tmpDir, "pr1", "pr2")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────
// Resume state management
// ────────────────────────────────────────────────────────

describe("restack state (resume support)", () => {
  test("save and load restack state", async () => {
    await createLinearStack(tmpDir);

    await saveRestackState({
      current_index: 1,
      stack_name: "test-stack",
      chain: ["pr1", "pr2", "pr3"],
    });

    const state = await loadRestackState();
    expect(state).not.toBeNull();
    expect(state!.current_index).toBe(1);
    expect(state!.stack_name).toBe("test-stack");
    expect(state!.chain).toEqual(["pr1", "pr2", "pr3"]);
  });

  test("clear restack state removes file", async () => {
    await createLinearStack(tmpDir);

    await saveRestackState({
      current_index: 0,
      stack_name: "test-stack",
      chain: ["pr1"],
    });

    await clearRestackState();

    const state = await loadRestackState();
    expect(state).toBeNull();
  });

  test("load returns null when no state file exists", async () => {
    await createLinearStack(tmpDir);

    const state = await loadRestackState();
    expect(state).toBeNull();
  });
});

// ────────────────────────────────────────────────────────
// Snapshot system
// ────────────────────────────────────────────────────────

describe("snapshot system", () => {
  test("snapshot captures all branch SHAs", async () => {
    const { meta, shas } = await createLinearStack(tmpDir);

    const updated = await takeSnapshot(meta, "test-stack", "restack");
    const snapshot = getLastSnapshot(updated);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.operation).toBe("restack");
    expect(snapshot!.branches["pr1"]).toBe(shas.pr1);
    expect(snapshot!.branches["pr2"]).toBe(shas.pr2);
    expect(snapshot!.branches["pr3"]).toBe(shas.pr3);
  });

  test("snapshot timestamp is ISO 8601", async () => {
    const { meta } = await createLinearStack(tmpDir);

    const updated = await takeSnapshot(meta, "test-stack", "sync");
    const snapshot = getLastSnapshot(updated);

    expect(snapshot).not.toBeNull();
    // Should be parseable as a date
    const date = new Date(snapshot!.timestamp);
    expect(date.getTime()).not.toBeNaN();
  });

  test("multiple snapshots are kept (up to limit)", async () => {
    const { meta } = await createLinearStack(tmpDir);

    let current = meta;
    for (let i = 0; i < 5; i++) {
      current = await takeSnapshot(current, "test-stack", `op-${i}`);
    }

    expect(current.snapshots!.length).toBe(5);
    expect(current.snapshots![0]!.operation).toBe("op-0");
    expect(current.snapshots![4]!.operation).toBe("op-4");
  });

  test("undo restores branch refs after a partial restack", async () => {
    const { meta, shas } = await createLinearStack(tmpDir);

    // Simulate review changes on the base branch before restack begins.
    await checkout(tmpDir, "pr1");
    const pr1UpdatedSha = await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "pr1: review fix");

    const metaAfterSnapshot = await takeSnapshot(meta, "test-stack", "restack");
    const snapshot = getLastSnapshot(metaAfterSnapshot);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.branches["pr1"]).toBe(pr1UpdatedSha);
    expect(snapshot!.branches["pr2"]).toBe(shas.pr2);
    expect(snapshot!.branches["pr3"]).toBe(shas.pr3);

    // Simulate the first child successfully rebasing before a later failure.
    await checkout(tmpDir, "pr2");
    const mb = (await $`git merge-base pr2 pr1`.text()).trim();
    await git.createTag(git.tempBaseTagName("pr2"), mb);
    const rebased = await git.rebaseOnto("pr1", git.tempBaseTagName("pr2"), "pr2");
    expect(rebased).toBe(true);

    const pr2RebasedSha = await getSha(tmpDir, "pr2");
    expect(pr2RebasedSha).not.toBe(shas.pr2);

    setAutoYes(true);
    await undo([]);

    expect(await getSha(tmpDir, "pr1")).toBe(pr1UpdatedSha);
    expect(await getSha(tmpDir, "pr2")).toBe(shas.pr2!);
    expect(await getSha(tmpDir, "pr3")).toBe(shas.pr3!);
  });
});

// ────────────────────────────────────────────────────────
// Conflict detection (without actually breaking)
// ────────────────────────────────────────────────────────

describe("conflict handling", () => {
  test("rebase returns false when conflicts exist", async () => {
    await createTempRepo(); // fresh repo already created in beforeEach

    // Create branches that will conflict on the same file
    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "shared.txt", "main version\n", "main: add shared");

    await $`git -C ${tmpDir} checkout -b conflict-branch HEAD~1`.quiet();
    await makeCommit(tmpDir, "shared.txt", "branch version\n", "branch: add shared");

    // This rebase should conflict
    const success = await git.rebase("main");
    expect(success).toBe(false);

    // Abort the rebase to clean up
    await $`git -C ${tmpDir} rebase --abort`.quiet();
  });

  test("rebaseOnto returns false when conflicts exist", async () => {
    // Create a scenario where rebase --onto will conflict
    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "conflict-file.txt", "main version\n", "main: add conflict file");

    // Create branch from before the main commit
    await $`git -C ${tmpDir} checkout -b old-base HEAD~1`.quiet();
    await $`git -C ${tmpDir} checkout -b conflict-branch`.quiet();
    await makeCommit(tmpDir, "conflict-file.txt", "branch version\n", "branch: add conflict file");

    const oldBaseSha = await getSha(tmpDir, "old-base");
    const success = await git.rebaseOnto("main", oldBaseSha, "conflict-branch");
    expect(success).toBe(false);

    // Clean up
    await $`git -C ${tmpDir} rebase --abort`.quiet();
  });
});

// ────────────────────────────────────────────────────────
// Deep stacks (5+ branches)
// ────────────────────────────────────────────────────────

describe("deep stacks", () => {
  test("5-branch linear stack rebases correctly", async () => {
    // Build: main → b1 → b2 → b3 → b4 → b5
    const shas: Record<string, string> = {};
    shas.main = await getSha(tmpDir, "main");

    for (let i = 1; i <= 5; i++) {
      const parent = i === 1 ? "main" : `b${i - 1}`;
      await checkout(tmpDir, parent);
      await $`git -C ${tmpDir} checkout -b b${i}`.quiet();
      shas[`b${i}`] = await makeCommit(tmpDir, `b${i}.txt`, `b${i} content\n`, `b${i}: add file`);
    }

    // Update b1 with review changes
    await checkout(tmpDir, "b1");
    await makeCommit(tmpDir, "b1-fix.txt", "fix\n", "b1: fix");

    // Tag all branches before rebasing
    for (let i = 2; i <= 5; i++) {
      const branch = `b${i}`;
      const parent = `b${i - 1}`;
      const mb = (await $`git merge-base ${branch} ${parent}`.text()).trim();
      await git.createTag(git.tempBaseTagName(branch), mb);
    }

    // Rebase chain: b2 → b3 → b4 → b5
    for (let i = 2; i <= 5; i++) {
      const branch = `b${i}`;
      const parent = `b${i - 1}`;
      const ok = await git.rebaseOnto(parent, git.tempBaseTagName(branch), branch);
      expect(ok).toBe(true);
    }

    // Verify full chain
    for (let i = 1; i <= 4; i++) {
      expect(await isAncestor(tmpDir, `b${i}`, `b${i + 1}`)).toBe(true);
    }

    // All files present at tip
    await checkout(tmpDir, "b5");
    for (let i = 1; i <= 5; i++) {
      expect(await Bun.file(`${tmpDir}/b${i}.txt`).exists()).toBe(true);
    }
    expect(await Bun.file(`${tmpDir}/b1-fix.txt`).exists()).toBe(true);
  });
});

// ────────────────────────────────────────────────────────
// Remote/push scenarios
// ────────────────────────────────────────────────────────

describe("remote branch detection", () => {
  test("remoteBranchExists returns true for pushed branches", async () => {
    await createLinearStack(tmpDir);
    await pushAllBranches(tmpDir);

    expect(await git.remoteBranchExists("pr1")).toBe(true);
    expect(await git.remoteBranchExists("pr2")).toBe(true);
    expect(await git.remoteBranchExists("nonexistent")).toBe(false);
  });

  test("force push with lease succeeds after rebase", async () => {
    await createLinearStack(tmpDir);
    await pushAllBranches(tmpDir);

    // Rebase pr1 with a new commit (changes history)
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-new.txt", "new\n", "pr1: new");

    // Force push should succeed (no one else pushed)
    const ok = await git.forcePushWithLease("pr1");
    expect(ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────
// Safety checks
// ────────────────────────────────────────────────────────

describe("safety checks", () => {
  test("isCleanWorkingTree detects staged changes", async () => {
    await Bun.write(`${tmpDir}/dirty.txt`, "dirty\n");
    await $`git -C ${tmpDir} add dirty.txt`.quiet();

    expect(await git.isCleanWorkingTree()).toBe(false);
  });

  test("isCleanWorkingTree detects unstaged changes", async () => {
    await Bun.write(`${tmpDir}/README.md`, "modified\n");

    expect(await git.isCleanWorkingTree()).toBe(false);
  });

  test("isCleanWorkingTree is true on clean tree", async () => {
    expect(await git.isCleanWorkingTree()).toBe(true);
  });

  test("isRebaseInProgress is false normally", async () => {
    expect(await git.isRebaseInProgress()).toBe(false);
  });
});

// ────────────────────────────────────────────────────────
// Tag cleanup
// ────────────────────────────────────────────────────────

describe("tag cleanup", () => {
  test("deleteTagsMatching removes only matching tags", async () => {
    const sha = await getSha(tmpDir, "HEAD");

    await git.createTag(git.tempBaseTagName("pr1"), sha);
    await git.createTag(git.tempBaseTagName("pr2"), sha);
    await git.createTag("keep-this-tag", sha);

    await git.deleteTagsMatching(git.STACK_SYNC_TAG_GLOB);

    expect(await git.tagExists(git.tempBaseTagName("pr1"))).toBe(false);
    expect(await git.tagExists(git.tempBaseTagName("pr2"))).toBe(false);
    expect(await git.tagExists("keep-this-tag")).toBe(true);
  });

  test("deleteTagsMatching is safe when no tags exist", async () => {
    // Should not throw
    await git.deleteTagsMatching(git.STACK_SYNC_TAG_GLOB);
  });
});

// ────────────────────────────────────────────────────────
// Snapshot-based pre-rewrite SHA recovery (issue #2)
//
// Reproduces the bug where, after a parent's history is rewritten,
// `merge-base(child, parent)` falls all the way back to original-main —
// causing restack to replay the parent's old commits onto the child.
//
// findPreRewriteSha() should recover the orphaned old-parent tip from
// a pre-rewrite snapshot, giving restack the correct rebase base.
// ────────────────────────────────────────────────────────

describe("findPreRewriteSha", () => {
  test("returns null when no snapshots exist", async () => {
    const { meta } = await createLinearStack(tmpDir);

    const result = await findPreRewriteSha(meta, "pr1");
    expect(result).toBeNull();
  });

  test("returns null when branch was only appended to (history not rewritten)", async () => {
    const { meta } = await createLinearStack(tmpDir);

    // Snapshot the current state
    const updated = await takeSnapshot(meta, "test-stack", "restack");

    // Append a commit to pr1 (does NOT rewrite history)
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-extra.txt", "extra\n", "pr1: extra");

    // Snapshot's recorded SHA is still an ancestor of pr1's current tip
    // → not "rewritten" → falls back to merge-base (caller's responsibility)
    const result = await findPreRewriteSha(updated, "pr1");
    expect(result).toBeNull();
  });

  test("returns the orphaned tip after a rebase rewrites the branch", async () => {
    const { meta, shas } = await createLinearStack(tmpDir);
    await pushAllBranches(tmpDir);

    // Advance origin/main
    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "main-new.txt", "new\n", "main: advance");
    await $`git -C ${tmpDir} push origin main`.quiet();
    await $`git -C ${tmpDir} fetch origin`.quiet();

    // Take pre-sync snapshot — captures pr1's pre-rebase tip
    const preSync = await takeSnapshot(meta, "test-stack", "sync");
    expect(preSync.snapshots![0]!.branches["pr1"]).toBe(shas.pr1);

    // Rebase pr1 onto origin/main (rewrites history)
    await checkout(tmpDir, "pr1");
    await git.rebase("origin/main");

    const newPr1 = await getSha(tmpDir, "pr1");
    expect(newPr1).not.toBe(shas.pr1);

    // The snapshot's recorded SHA (old pr1 tip) is no longer an ancestor
    // of the new pr1 tip — they're siblings on a fork. findPreRewriteSha
    // detects this and returns the orphaned tip.
    const result = await findPreRewriteSha(preSync, "pr1");
    expect(result).toBe(shas.pr1!);
  });

  test("walks newest→oldest, prefers most recent rewrite", async () => {
    const { meta, shas } = await createLinearStack(tmpDir);
    await pushAllBranches(tmpDir);

    // First sync cycle — snapshot, then rewrite pr1
    let m = await takeSnapshot(meta, "test-stack", "sync");
    const firstPr1 = shas.pr1;

    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "main-1.txt", "1\n", "main: 1");
    await $`git -C ${tmpDir} push origin main`.quiet();
    await $`git -C ${tmpDir} fetch origin`.quiet();

    await checkout(tmpDir, "pr1");
    await git.rebase("origin/main");
    const secondPr1 = await getSha(tmpDir, "pr1");

    // Second sync cycle — snapshot the new pr1 tip, then rewrite again
    m = await takeSnapshot(m, "test-stack", "sync");

    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "main-2.txt", "2\n", "main: 2");
    await $`git -C ${tmpDir} push origin main`.quiet();
    await $`git -C ${tmpDir} fetch origin`.quiet();

    await checkout(tmpDir, "pr1");
    await git.rebase("origin/main");

    // Two snapshots exist:
    //   [0] pre-first-sync: pr1 = firstPr1
    //   [1] pre-second-sync: pr1 = secondPr1  ← most recent orphaned tip
    // findPreRewriteSha should return secondPr1, not firstPr1.
    const result = await findPreRewriteSha(m, "pr1");
    expect(result).toBe(secondPr1);
    expect(result).not.toBe(firstPr1);
  });
});

// ────────────────────────────────────────────────────────
// Issue #2 repro: ghost-conflict prevention end-to-end
//
// Without the snapshot-based base lookup, this scenario would replay
// pr1's old commits on top of pr2 (since merge-base falls back to
// original-main). The fix is verified by counting pr2's unique commits
// after restack — it should still be exactly 1.
// ────────────────────────────────────────────────────────

describe("issue #2 repro: sync → restack with rebased base", () => {
  test("restack after sync replays only child's unique commits, not parent's old history", async () => {
    const { meta, shas } = await createLinearStack(tmpDir);
    await pushAllBranches(tmpDir);

    // Advance main with a commit that pr1 didn't have
    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "main-new.txt", "new\n", "main: advance");
    await $`git -C ${tmpDir} push origin main`.quiet();
    await $`git -C ${tmpDir} fetch origin`.quiet();

    // Sync's job: snapshot BEFORE rebasing — captures pr1, pr2, pr3 old tips
    const preSync = await takeSnapshot(meta, "test-stack", "sync");

    // Sync rebases pr1 onto origin/main (rewrites pr1's history)
    await checkout(tmpDir, "pr1");
    const ok1 = await git.rebase("origin/main");
    expect(ok1).toBe(true);
    const newPr1 = await getSha(tmpDir, "pr1");
    expect(newPr1).not.toBe(shas.pr1);

    // Now simulate restack of pr2 onto rebased pr1.
    //
    // The buggy path (merge-base): would return original-main (or close)
    // because new-pr1 doesn't share commits with unrebased pr2 anymore.
    // The fix (findPreRewriteSha): returns the old pr1 tip from snapshot.

    const buggyBase = await git.mergeBase("pr2", "pr1");
    const correctBase = await findPreRewriteSha(preSync, "pr1");

    // Sanity: the two strategies disagree — that's the whole point of the fix
    expect(correctBase).toBe(shas.pr1!);
    expect(buggyBase).not.toBe(correctBase);

    // Use the correct base to restack pr2
    const ok2 = await git.rebaseOnto("pr1", correctBase!, "pr2");
    expect(ok2).toBe(true);

    // pr2 should have EXACTLY 1 unique commit above pr1 — its own.
    // If the bug were present, this would be > 1 (pr1's old commits replayed).
    const pr2Unique = parseInt(
      (await $`git -C ${tmpDir} rev-list --count pr1..pr2`.text()).trim(),
      10,
    );
    expect(pr2Unique).toBe(1);

    // And the chain is correct end-to-end
    expect(await isAncestor(tmpDir, "origin/main", "pr2")).toBe(true);
    expect(await isAncestor(tmpDir, "pr1", "pr2")).toBe(true);

    // pr2 has main's new commit AND pr1's content AND its own
    await checkout(tmpDir, "pr2");
    expect(await Bun.file(`${tmpDir}/main-new.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/pr1.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpDir}/pr2.txt`).exists()).toBe(true);
  });

  test("3-PR stack: pre-sync snapshot drives correct base for every child", async () => {
    const { meta, shas } = await createLinearStack(tmpDir);
    await pushAllBranches(tmpDir);

    // Advance main
    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "main-new.txt", "new\n", "main: advance");
    await $`git -C ${tmpDir} push origin main`.quiet();
    await $`git -C ${tmpDir} fetch origin`.quiet();

    // Pre-sync snapshot — single source of truth for all old tips
    const preSync = await takeSnapshot(meta, "test-stack", "sync");

    // Rebase pr1 onto origin/main
    await checkout(tmpDir, "pr1");
    expect(await git.rebase("origin/main")).toBe(true);

    // Restack pr2: use snapshot's pre-rewrite tip of pr1
    const pr2Base = await findPreRewriteSha(preSync, "pr1");
    expect(pr2Base).toBe(shas.pr1!);
    expect(await git.rebaseOnto("pr1", pr2Base!, "pr2")).toBe(true);

    // Restack pr3: pr2's tip is now rewritten, but the snapshot still has
    // pr2's pre-restack tip recorded — that's the rebase base for pr3.
    const pr3Base = await findPreRewriteSha(preSync, "pr2");
    expect(pr3Base).toBe(shas.pr2!);
    expect(await git.rebaseOnto("pr2", pr3Base!, "pr3")).toBe(true);

    // Each child has exactly 1 unique commit — none of the parent's old history replayed
    const pr2Unique = parseInt(
      (await $`git -C ${tmpDir} rev-list --count pr1..pr2`.text()).trim(),
      10,
    );
    const pr3Unique = parseInt(
      (await $`git -C ${tmpDir} rev-list --count pr2..pr3`.text()).trim(),
      10,
    );
    expect(pr2Unique).toBe(1);
    expect(pr3Unique).toBe(1);

    // Full chain
    expect(await isAncestor(tmpDir, "origin/main", "pr3")).toBe(true);
    expect(await isAncestor(tmpDir, "pr1", "pr3")).toBe(true);
    expect(await isAncestor(tmpDir, "pr2", "pr3")).toBe(true);
  });
});
