// submit --existing (#82): push the branches that already have PRs and open
// none, so a branch meant to stay local is never published, renumbered into the
// (N/M) titles, or listed in the stack section. Real CLI against a stub `gh`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import type { SubmitJson } from "../commands/submit.ts";
import { publishedBranches } from "../commands/update-prs.ts";
import type { Stack } from "../types.ts";
import {
  checkout,
  cleanup,
  createBranch,
  createGhStub,
  createTempRepo,
  ghStubEnv,
  getSha,
  makeCommit,
  readMetadata,
  setupRemote,
} from "./helpers.ts";

/** A stack from each branch's parent, with PRs on the branches named in `prs`. */
const stack = (prs: Record<string, number>, parents: Record<string, string>): Stack => ({
  description: "",
  last_branch: "",
  branches: Object.fromEntries(
    Object.entries(parents).map(([b, parent]) => [b, { parent, pr: prs[b] }]),
  ),
});

describe("publishedBranches", () => {
  test("leaves out a PR-less tail, keeps a PR-less branch that a PR sits on", () => {
    const s = stack({ a: 1, c: 3 }, { a: "main", b: "a", c: "b", d: "c", e: "d" });
    expect(publishedBranches(s, ["a", "b", "c", "d", "e"])).toEqual(["a", "b", "c"]);
  });

  test("a PR on a sibling line keeps only that line's bases", () => {
    // main → a → {b → c, x}: only c (on the b line) has a PR.
    const s = stack({ c: 3 }, { a: "main", b: "a", c: "b", x: "a" });
    expect(publishedBranches(s, ["a", "b", "c", "x"])).toEqual(["a", "b", "c"]);
  });
});

// ── End to end ──

const cliPath = new URL("../index.ts", import.meta.url).pathname;

let tmpDir: string;
let remoteDir: string;
let stubDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = await setupRemote(tmpDir);
  stubDir = await createGhStub();
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, stubDir);
});

async function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", cliPath, cmd, ...args], {
    cwd: tmpDir,
    env: { ...process.env, ...ghStubEnv(stubDir), GH_STACK_NO_COLOR: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, out: stdout + stderr, exitCode };
}

const submit = (args: string[], env: Record<string, string> = {}) => run("submit", args, env);

/** The stub's call log since the last reset (empty when gh was never called). */
async function ghCalls(): Promise<string> {
  const f = Bun.file(`${stubDir}/calls.log`);
  return (await f.exists()) ? await f.text() : "";
}

async function resetGhCalls(): Promise<void> {
  await $`rm -f ${stubDir}/calls.log`.quiet();
}

/** Branch names on origin. */
async function remoteBranches(): Promise<string[]> {
  const out = await $`git -C ${tmpDir} ls-remote --heads origin`.text();
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("refs/heads/")[1]!)
    .toSorted();
}

/**
 * main → a → b with PRs #101 and #102 ("Add things (1/2)", "(2/2)"), then c on
 * top of b: tracked with `add` (no push, no PR), meant to stay local.
 */
async function stackWithLocalTop(): Promise<void> {
  await createBranch(tmpDir, "a", "main");
  await makeCommit(tmpDir, "a.txt", "a\n", "a: add a");
  await createBranch(tmpDir, "b", "a");
  await makeCommit(tmpDir, "b.txt", "b\n", "b: add b");
  expect((await submit(["-t", "Add things"])).exitCode).toBe(0);
  await createBranch(tmpDir, "c", "b");
  await makeCommit(tmpDir, "c.txt", "c\n", "c: wip");
  expect((await run("add", [])).exitCode).toBe(0);
  await resetGhCalls();
}

describe("submit --existing", () => {
  test("pushes the PR branches across the whole stack and leaves the local top alone", async () => {
    await stackWithLocalTop();
    // b gets a new commit (as after a `sync --no-push`); push from the bottom.
    await checkout(tmpDir, "b");
    await makeCommit(tmpDir, "b2.txt", "b2\n", "b: more");
    await checkout(tmpDir, "a");

    const { stdout, stderr, exitCode } = await submit(["--existing", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as SubmitJson;
    expect(result.branches.map((b) => [b.branch, b.pr, b.action, b.pushed])).toEqual([
      ["a", 101, "unchanged", false],
      ["b", 102, "updated", true],
      ["c", null, "skipped", false],
    ]);
    expect(stderr).toContain("c has no PR, left local (--existing)");
    expect(stderr).toContain("left 1 without a PR local");
    expect(await remoteBranches()).toEqual(["a", "b", "main"]);
    expect(await getSha(tmpDir, "origin/b")).toBe(await getSha(tmpDir, "b"));

    // No PR opened, no title renumbered to /3, no description rewritten to
    // list c: the published PRs look exactly as before.
    const calls = await ghCalls();
    expect(calls).not.toContain("pr create");
    expect(calls).not.toContain("pr edit");
  }, 60_000);

  test("a plain submit doesn't count a local branch above it either", async () => {
    await stackWithLocalTop();
    await checkout(tmpDir, "b");
    await makeCommit(tmpDir, "b2.txt", "b2\n", "b: more");

    expect((await submit(["--json"])).exitCode).toBe(0);
    const calls = await ghCalls();
    expect(calls).not.toContain("pr create");
    expect(calls).not.toContain("/3)");
  }, 60_000);

  test("update-prs leaves the local top out of the PRs but still names it", async () => {
    await stackWithLocalTop();

    const { out, exitCode } = await run("update-prs", []);

    expect(exitCode).toBe(0);
    expect(out).toContain("Skipped 1 branch(es) with no open PR: c");
    expect(await ghCalls()).not.toContain("/3)");
  }, 60_000);

  test("stops before any push when a PR sits on a branch with no PR", async () => {
    // main → a (#101) → b (no PR) → c (#77, opened outside gh-stack).
    await createBranch(tmpDir, "a", "main");
    await makeCommit(tmpDir, "a.txt", "a\n", "a: add a");
    expect((await submit(["-t", "Add a"])).exitCode).toBe(0);
    await createBranch(tmpDir, "b", "a");
    await makeCommit(tmpDir, "b.txt", "b\n", "b: add b");
    await createBranch(tmpDir, "c", "b");
    await makeCommit(tmpDir, "c.txt", "c\n", "c: add c");
    expect((await run("add", [])).exitCode).toBe(0);
    await checkout(tmpDir, "a");
    await makeCommit(tmpDir, "a2.txt", "a2\n", "a: more");
    const aOnOrigin = await getSha(tmpDir, "origin/a");
    await resetGhCalls();

    const { stdout, exitCode } = await submit(["--existing", "--json"], {
      GH_EXISTING_PR: "c=77",
    });

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout) as SubmitJson;
    expect(result.error?.message).toBe(
      "b has no PR, but c's PR #77 sits on it, so --existing can't push the stack without it. Run `gh-stack submit` from b to give it a PR, then `gh-stack submit --existing`.",
    );
    expect(result.branches).toEqual([]);
    expect(await remoteBranches()).toEqual(["a", "main"]);
    expect(await getSha(tmpDir, "origin/a")).toBe(aOnOrigin);
    expect(await ghCalls()).not.toContain("pr create");
    // The PR it found is kept for next time.
    const stack = Object.values((await readMetadata(tmpDir)).stacks)[0]!;
    expect(stack.branches.c!.pr).toBe(77);
  }, 60_000);

  test("-t on a branch with no PR is refused before any push", async () => {
    await stackWithLocalTop();
    await checkout(tmpDir, "b");
    await makeCommit(tmpDir, "b2.txt", "b2\n", "b: more");
    const bOnOrigin = await getSha(tmpDir, "origin/b");
    await checkout(tmpDir, "c");

    const { stdout, exitCode } = await submit(["--existing", "--json", "-t", "New"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout) as SubmitJson;
    expect(result.error?.message).toContain("c has no PR, and --existing creates none");
    expect(await getSha(tmpDir, "origin/b")).toBe(bOnOrigin);
    expect(await remoteBranches()).toEqual(["a", "b", "main"]);
  }, 60_000);

  test("--dry-run plans the pushes, skips the local top, and counts a PR found by lookup", async () => {
    await stackWithLocalTop();

    const plain = await submit(["--existing", "--dry-run"]);
    expect(plain.exitCode).toBe(0);
    expect(plain.out).toContain("c has no PR, left local (--existing)");
    expect(plain.out).toContain(
      "would push 2, create 0, update 2 PR(s), leave 1 without a PR local",
    );

    const found = await submit(["--existing", "--dry-run"], { GH_EXISTING_PR: "c=77" });
    expect(found.exitCode).toBe(0);
    expect(found.out).toContain("exists PR #77 for c");
    expect(found.out).not.toContain("left local");
    expect(await ghCalls()).not.toContain("pr create");
    expect(await remoteBranches()).toEqual(["a", "b", "main"]);
  }, 60_000);

  test("refuses --restack and an untracked branch, with no gh call", async () => {
    await createBranch(tmpDir, "loose", "main");
    await makeCommit(tmpDir, "l.txt", "l\n", "loose: add");

    const untracked = await submit(["--existing", "--json"]);
    expect(untracked.exitCode).toBe(1);
    expect((JSON.parse(untracked.stdout) as SubmitJson).error?.message).toContain(
      "loose isn't in a stack, so --existing has no tracked PRs to push",
    );

    const restack = await submit(["--existing", "--restack"]);
    expect(restack.exitCode).toBe(1);
    expect(restack.out).toContain("--existing can't be combined with --restack");

    expect(await ghCalls()).toBe("");
    expect(await remoteBranches()).toEqual(["main"]);
  }, 60_000);
});
