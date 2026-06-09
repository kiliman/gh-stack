// Regression tests for #-dirty-checkout: switching branches with conflicting
// local changes must surface a clean "commit or stash" message and exit 1 —
// NOT leak a raw Bun ShellError stack trace (the bug reported on `ghs co
// --stack`). Covers the low-level git.tryCheckout helper and the user-facing
// nav command end-to-end.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { checkout, cleanup, createLinearStack, createTempRepo } from "./helpers.ts";
import * as git from "../lib/git.ts";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanup(tmpDir);
});

describe("git.tryCheckout", () => {
  test("returns ok:false with git's stderr when local changes would be overwritten", async () => {
    await createLinearStack(tmpDir, { conflicting: true }); // pr1 edits shared.txt
    process.chdir(tmpDir);
    await checkout(tmpDir, "pr1");
    // Local edit to a file whose content differs on main → switching conflicts.
    await Bun.write(`${tmpDir}/shared.txt`, "uncommitted local edit\n");

    const res = await git.tryCheckout("main");
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("would be overwritten by checkout");
    expect(res.stderr).toContain("shared.txt");
  });

  test("returns ok:true and carries non-conflicting WIP across the switch", async () => {
    await createLinearStack(tmpDir); // linear, no shared-file conflicts
    process.chdir(tmpDir);
    await checkout(tmpDir, "pr1");
    await Bun.write(`${tmpDir}/wip-note.txt`, "unrelated WIP\n"); // untracked, no conflict

    const res = await git.tryCheckout("pr2");
    expect(res.ok).toBe(true);
    expect((await $`git -C ${tmpDir} branch --show-current`.text()).trim()).toBe("pr2");
    expect(await Bun.file(`${tmpDir}/wip-note.txt`).exists()).toBe(true); // carried across
  });
});

describe("nav command refuses a conflicting switch cleanly (no ShellError leak)", () => {
  const cliPath = new URL("../index.ts", import.meta.url).pathname;

  test("`top` shows a clean message and exits 1 when an untracked file would be clobbered", async () => {
    await createLinearStack(tmpDir); // main → pr1 → pr2 → pr3 (pr3.txt only on pr3)
    await checkout(tmpDir, "pr1");
    // Untracked pr3.txt on pr1 collides with the committed pr3.txt on pr3.
    await Bun.write(`${tmpDir}/pr3.txt`, "local junk that would be overwritten\n");

    const proc = Bun.spawn(["bun", "run", cliPath, "top"], {
      cwd: tmpDir,
      env: { ...process.env, NO_COLOR: "1", GH_STACK_NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const out = stdout + stderr;

    expect(exitCode).toBe(1);
    expect(out).toContain("would be overwritten");
    expect(out).toContain("git stash");
    // The whole point: no raw exception leaked.
    expect(out).not.toContain("ShellError");
    expect(out).not.toContain("ShellPromise");
  });
});
