// Fixture for git-env-isolation.test.ts, run in a nested `bun test` with
// GIT_DIR pointing at a victim repository. Not matched by normal test
// discovery (no .test. in the name). Exercises every way the suite spawns git:
// Bun's `$`, and bare Bun.spawn/spawnSync with no `env` option, which inherit
// the process's startup environment rather than process.env.
import { test } from "bun:test";
import * as fs from "node:fs/promises";
import { $ } from "bun";
import { createTempRepo, setupRemote } from "../helpers.ts";

test("fixture: build a temp repo with a remote", async () => {
  const dir = await createTempRepo();
  const remote = await setupRemote(dir);

  const proc = Bun.spawn(["git", "-C", dir, "checkout", "-q", "-b", "fixture-spawn"]);
  if ((await proc.exited) !== 0) throw new Error("bare Bun.spawn git failed");
  const sync = Bun.spawnSync(["git", "-C", dir, "checkout", "-q", "-b", "fixture-spawn-sync"]);
  if (sync.exitCode !== 0) throw new Error("bare Bun.spawnSync git failed");
  await $`git -C ${dir} checkout -q -b fixture-shell`.quiet();

  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(remote, { recursive: true, force: true });
});
