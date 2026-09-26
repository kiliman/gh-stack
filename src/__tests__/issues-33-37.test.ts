// Tests for #33 (non-TTY prompts fail fast), #34 (live viz check), #36
// (restack --no-push), and #37 (add --parent for a zero-commit branch).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  checkout,
  cleanup,
  createLinearStack,
  createTempRepo,
  makeCommit,
  pushAllBranches,
  readMetadata,
  setupRemote,
} from "./helpers.ts";
import { bodyHasViz } from "../commands/update-prs.ts";

let tmpDir: string;
let remoteDir: string | undefined;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = undefined;
});

afterEach(async () => {
  await cleanup(tmpDir);
  if (remoteDir) await cleanup(remoteDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[], env: Record<string, string> = { GH_STACK_YES: "1" }) {
  const baseEnv = { ...process.env };
  delete baseEnv.GH_STACK_YES;
  delete baseEnv.GH_STACK_NO_PUSH;
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: { ...baseEnv, NO_COLOR: "1", GH_STACK_NO_COLOR: "1", ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr, out: stdout + stderr };
}

async function remoteSha(branch: string): Promise<string> {
  const out = (await $`git -C ${tmpDir} ls-remote origin ${branch}`.text()).trim();
  return out ? out.split(/\s+/)[0]! : "";
}

async function localSha(ref: string): Promise<string> {
  return (await $`git -C ${tmpDir} rev-parse ${ref}`.text()).trim();
}

/** pr1 → pr2 → pr3 on origin, then a new commit on pr1 so pr2/pr3 need a rebase. */
async function stackNeedingRestack(): Promise<{ pr2: string; pr3: string }> {
  await createLinearStack(tmpDir);
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  const before = { pr2: await remoteSha("pr2"), pr3: await remoteSha("pr3") };
  await checkout(tmpDir, "pr1");
  await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");
  return before;
}

describe("restack --no-push (#36)", () => {
  test("rebases locally, pushes nothing, lists refs ahead of origin, exits 0", async () => {
    const before = await stackNeedingRestack();
    const pr1Remote = await remoteSha("pr1");

    const res = await runCli(["restack", "--no-push"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Not pushed (--no-push)");
    // Rebased locally…
    const ok = await $`git -C ${tmpDir} merge-base --is-ancestor pr1 pr3`.nothrow().quiet();
    expect(ok.exitCode).toBe(0);
    // …but origin is untouched, including the base branch that got the commit.
    expect(await remoteSha("pr1")).toBe(pr1Remote);
    expect(await remoteSha("pr2")).toBe(before.pr2);
    expect(await remoteSha("pr3")).toBe(before.pr3);
    expect(await localSha("pr3")).not.toBe(before.pr3);
  });

  test("GH_STACK_NO_PUSH=1 does the same under GH_STACK_YES=1", async () => {
    const before = await stackNeedingRestack();

    const res = await runCli(["restack"], { GH_STACK_YES: "1", GH_STACK_NO_PUSH: "1" });

    expect(res.exitCode).toBe(0);
    expect(await remoteSha("pr2")).toBe(before.pr2);
    expect(await remoteSha("pr3")).toBe(before.pr3);
  });

  test("without it, --yes still pushes (unchanged default)", async () => {
    const before = await stackNeedingRestack();

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(await remoteSha("pr3")).not.toBe(before.pr3);
    expect(await remoteSha("pr3")).toBe(await localSha("pr3"));
  });
});

describe("prompts with a non-TTY stdin (#33)", () => {
  test("exit non-zero with a hint instead of blocking", async () => {
    await stackNeedingRestack();

    // No GH_STACK_YES: restack reaches its rebase confirmation.
    const res = await runCli(["restack"], {});

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("refusing to prompt");
    expect(res.stderr).toContain("GH_STACK_YES=1");
  }, 30_000);
});

describe("bodyHasViz (#34)", () => {
  const viz = "### 📚 Stacked on\n\n<pre>\n⚫ main\n┃\n┗━ #1 A 👈\n</pre>";

  test("finds the block in a body gh-stack wrote", () => {
    expect(bodyHasViz(`Summary\n\n${viz}`, viz)).toBe(true);
  });

  test("tolerates CRLF line endings from the GitHub web editor", () => {
    expect(bodyHasViz(`Summary\r\n\r\n${viz.replace(/\n/g, "\r\n")}`, viz)).toBe(true);
  });

  test("misses a body whose block was removed or is stale", () => {
    expect(bodyHasViz("Summary with screenshots", viz)).toBe(false);
    expect(bodyHasViz(`Summary\n\n${viz.replace("#1 A", "#1 Old title")}`, viz)).toBe(false);
  });
});

describe("zero-commit branch placement (#37)", () => {
  /** main → parent (1 commit); child created at main, then rebased onto parent. */
  async function colocatedChild(): Promise<void> {
    await $`git -C ${tmpDir} checkout -q -b parent`;
    await makeCommit(tmpDir, "p.txt", "p\n", "parent work");
    await $`git -C ${tmpDir} checkout -q -b child main`;
    await $`git -C ${tmpDir} rebase -q parent`.quiet();
  }

  async function stackOf(branch: string) {
    const meta = await readMetadata(tmpDir);
    for (const [name, stack] of Object.entries(meta.stacks)) {
      if (stack.branches[branch]) return { name, stack, meta };
    }
    return null;
  }

  test("init warns that the branch shares its tip, and suggests add --parent", async () => {
    await colocatedChild();

    const res = await runCli(["init"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("has no commits of its own");
    expect(res.out).toContain("gh-stack add child --parent parent");
  });

  test("add --parent re-homes a mistaken one-branch init, tracking the parent too", async () => {
    await colocatedChild();
    expect((await runCli(["init"])).exitCode).toBe(0);

    const res = await runCli(["add", "--parent", "parent"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Re-homed");
    const found = await stackOf("child");
    expect(found!.stack.branches.child!.parent).toBe("parent");
    expect(found!.stack.branches.parent!.parent).toBe("main");
    // The throwaway one-branch stack is gone — child is tracked exactly once.
    const owners = Object.values(found!.meta.stacks).filter((s) => s.branches.child);
    expect(owners).toHaveLength(1);
  });

  test("add --parent onto an already-tracked parent joins its stack", async () => {
    await colocatedChild();
    await checkout(tmpDir, "parent");
    expect((await runCli(["init"])).exitCode).toBe(0);
    await checkout(tmpDir, "child");

    const res = await runCli(["add", "--parent", "parent"]);

    expect(res.exitCode).toBe(0);
    const found = await stackOf("child");
    expect(found!.name).toBe("parent");
    expect(found!.stack.branches.child!.parent).toBe("parent");
  });

  test("add --parent refuses to move a branch that has a PR", async () => {
    await colocatedChild();
    expect((await runCli(["init"])).exitCode).toBe(0);
    const found = await stackOf("child");
    found!.stack.branches.child!.pr = 42;
    const { writeMetadata } = await import("./helpers.ts");
    await writeMetadata(tmpDir, found!.meta);

    const res = await runCli(["add", "--parent", "parent"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("PR #42");
    expect((await stackOf("child"))!.stack.branches.child!.parent).toBe("main");
  });

  test("add --parent refuses a parent the branch isn't based on", async () => {
    await colocatedChild();
    await $`git -C ${tmpDir} checkout -q -b other main`;
    await makeCommit(tmpDir, "o.txt", "o\n", "other work");
    await checkout(tmpDir, "child");

    const res = await runCli(["add", "--parent", "other"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("isn't based on");
  });
});
