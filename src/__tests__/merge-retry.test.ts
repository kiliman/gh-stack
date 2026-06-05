// Tests for the transient-merge-error classifier that drives merge's retry
// loop (#19). The retry loop itself shells out to `gh` and is covered by live
// use; here we pin the classifier that decides retry-vs-abort.
import { describe, expect, test } from "bun:test";
import { isTransientMergeError, classifyMergeState } from "../commands/merge.ts";

describe("isTransientMergeError", () => {
  test("matches GitHub's async-recompute signatures", () => {
    // The exact stderr OC hit on the 19-PR stack.
    expect(
      isTransientMergeError(
        "GraphQL: Head branch is out of date. Review and try the merge again. (mergePullRequest)",
      ),
    ).toBe(true);
    expect(isTransientMergeError("Base branch was modified. Review and try the merge again.")).toBe(
      true,
    );
  });

  test("is case-insensitive", () => {
    expect(isTransientMergeError("HEAD BRANCH IS OUT OF DATE")).toBe(true);
  });

  test("does NOT match genuine failures", () => {
    expect(
      isTransientMergeError(
        "Pull request is not mergeable: the merge commit cannot be cleanly created",
      ),
    ).toBe(false);
    expect(isTransientMergeError("GraphQL: Required status check 'ci' is expected.")).toBe(false);
    expect(isTransientMergeError("merge conflict in src/foo.ts")).toBe(false);
    expect(isTransientMergeError("")).toBe(false);
  });
});

describe("classifyMergeState", () => {
  test("a conflicting base PR is a hard 'conflict' — never handed to auto-merge", () => {
    // The reported bug: GitHub says "This branch has conflicts that must be
    // resolved", so auto-merge could never fire — merge must STOP, not archive.
    expect(
      classifyMergeState({ state: "OPEN", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
    ).toBe("conflict");
    // DIRTY status alone (mergeable still computing) is enough to call it.
    expect(
      classifyMergeState({ state: "OPEN", mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" }),
    ).toBe("conflict");
  });

  test("blocked-on-pending-checks is distinct from a conflict (fine for --auto)", () => {
    expect(
      classifyMergeState({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
    ).toBe("blocked");
  });

  test("still-computing mergeability is 'pending' (keep polling)", () => {
    expect(
      classifyMergeState({ state: "OPEN", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    ).toBe("pending");
  });

  test("clean and mergeable variants are 'ready'", () => {
    for (const mergeStateStatus of ["CLEAN", "HAS_HOOKS", "UNSTABLE", "BEHIND"]) {
      expect(classifyMergeState({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus })).toBe(
        "ready",
      );
    }
  });

  test("merged and closed are terminal", () => {
    expect(
      classifyMergeState({ state: "MERGED", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    ).toBe("merged");
    expect(
      classifyMergeState({ state: "CLOSED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
    ).toBe("closed");
  });
});
