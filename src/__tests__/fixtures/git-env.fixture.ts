// Fixture for git-env-isolation.test.ts, run in a nested `bun test` with
// GIT_DIR pointing at a victim repository. Not matched by normal test
// discovery (no .test. in the name).
import { test } from "bun:test";
import * as fs from "node:fs/promises";
import { $ } from "bun";
import { createTempRepo, setupRemote } from "../helpers.ts";

test("fixture: build a temp repo with a remote", async () => {
  const dir = await createTempRepo();
  const remote = await setupRemote(dir);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(remote, { recursive: true, force: true });
  // Also exercise a bare `git` with no -C, which relies on cwd.
  await $`git --version`.quiet();
});
