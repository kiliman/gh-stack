// Fixture for git-env-isolation.test.ts, run in a nested `bun test` with
// GH_STACK_* variables set, the way a push made by `GH_STACK_YES=1 gh-stack
// submit` hands them to the pre-push hook. Not matched by normal test
// discovery (no .test. in the name).
import { expect, test } from "bun:test";

test("fixture: no GH_STACK_* variable reaches the tests", () => {
  expect(Object.keys(process.env).filter((name) => name.startsWith("GH_STACK_"))).toEqual([]);
});
