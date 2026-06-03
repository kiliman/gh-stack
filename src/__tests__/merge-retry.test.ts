// Tests for the transient-merge-error classifier that drives merge's retry
// loop (#19). The retry loop itself shells out to `gh` and is covered by live
// use; here we pin the classifier that decides retry-vs-abort.
import { describe, expect, test } from "bun:test";
import { isTransientMergeError } from "../commands/merge.ts";

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
