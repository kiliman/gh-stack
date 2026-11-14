// #79: a stack branch carries a copy of a commit that reached main through
// another PR.
//
// Agent sessions cherry-pick a commit from another PR into their lanes (a
// shared test helper, a resolver fix). When that PR squash-merges, the next
// sync replays the copy onto a main that already has it. A copy taken before
// the original PR was amended differs from what landed, so git can't drop it
// as a duplicate and the rebase stops on an add/add or content conflict.
// gh-stack now recognizes such a copy (one landed commit touched all its files,
// and nearly all its added lines are on main), skips it, and says so. Any
// other conflict still stops.
//
// Setup: PR #7 ("feature", not in the stack) adds shared.txt in a draft and
// then a final commit, and squash-merges to main. The stack's branches carry
// a copy of the draft commit, re-tagged with their own ticket, as OC's lanes
// did.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import {
  cleanup,
  createBranch,
  createGhStub,
  createTempRepo,
  ghStubEnv,
  makeCommit,
  pushAllBranches,
  setupRemote,
  writeMetadata,
} from "./helpers.ts";
import { MIN_ADDED_LINES, landedCopy } from "../lib/landed-copies.ts";

setDefaultTimeout(60_000);

const cliPath = new URL("../index.ts", import.meta.url).pathname;

// Six significant lines; the final version rewrites one and adds one, so the
// draft has 5 of 6 added lines on main (83%), like the real copies (92-100%).
const DRAFT = [
  "export function greet(name) {",
  '  const greeting = "Hello, " + name;',
  "  console.log(greeting);",
  "  return greeting;",
  "}",
  "export function part(name) {",
  '  return "Bye, " + name;',
  "}",
  "",
].join("\n");
const FINAL = `${DRAFT.replace("console.log(greeting);", "logger.info(greeting);")}export const VERSION = 2;\n`;

let tmpDir: string;
let remoteDir: string;
let stubDir: string;
let draftSha: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  await createBranch(tmpDir, "feature", "main");
  draftSha = await makeCommit(tmpDir, "shared.txt", DRAFT, "feat: shared greet helper [ENT-1]");
  await makeCommit(tmpDir, "shared.txt", FINAL, "feat: log through the logger [ENT-1]");
  await git(tmpDir, "checkout", "-q", "main");
  remoteDir = await setupRemote(tmpDir);
  stubDir = await createGhStub();
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, stubDir, `${tmpDir}.worktree`);
});

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${dir} ${args}`.text()).trim();
}

/** Cherry-pick the draft commit onto the current branch under the branch's own ticket. */
async function copyDraft(subject: string): Promise<void> {
  await git(tmpDir, "cherry-pick", draftSha);
  await git(tmpDir, "commit", "-q", "--amend", "-m", subject);
}

/** PR #7 lands on main as one squash commit. */
async function squashFeatureIntoMain(): Promise<string> {
  await git(tmpDir, "checkout", "-q", "main");
  await git(tmpDir, "merge", "-q", "--squash", "feature");
  await git(tmpDir, "commit", "-q", "-m", "feat: shared greet helper [ENT-1] (#7)");
  await git(tmpDir, "push", "-q", "origin", "main");
  return git(tmpDir, "rev-parse", "HEAD");
}

async function stack(branches: Record<string, string>): Promise<void> {
  const names = Object.keys(branches);
  await writeMetadata(tmpDir, {
    version: 2,
    current_stack: "lanes",
    stacks: {
      lanes: {
        description: "Lanes",
        last_branch: names.at(-1)!,
        branches: Object.fromEntries(
          names.map((b) => [b, { parent: branches[b]!, description: b }]),
        ),
      },
    },
  });
}

async function runCli(args: string[], cwd = tmpDir) {
  const base = { ...process.env } as Record<string, string>;
  delete base.GH_STACK_NO_PUSH;
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd,
    env: {
      ...base,
      ...ghStubEnv(stubDir),
      NO_COLOR: "1",
      GH_STACK_NO_COLOR: "1",
      GH_STACK_YES: "1",
    },
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
  return { exitCode, out: stdout + stderr };
}

/** Subjects of the commits `branch` has on top of `base`, oldest first. */
async function ownCommits(base: string, branch: string): Promise<string[]> {
  const out = await git(tmpDir, "log", "--reverse", "--format=%s", `${base}..${branch}`);
  return out ? out.split("\n") : [];
}

describe("sync skips commits that already reached main through another PR (#79)", () => {
  test("a re-tagged older copy is skipped; the branch's own work stays", async () => {
    await createBranch(tmpDir, "lane", "main");
    await copyDraft("feat: shared greet helper [LANE-1]");
    await makeCommit(tmpDir, "lane.txt", "lane work\n", "lane: own work");
    await stack({ lane: "main" });
    await pushAllBranches(tmpDir);
    const squash = await squashFeatureIntoMain();
    await git(tmpDir, "checkout", "-q", "lane");

    const res = await runCli(["sync", "--no-push"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Skipped");
    expect(res.out).toContain("feat: shared greet helper [LANE-1]");
    expect(res.out).toContain(`Already on origin/main through ${squash.slice(0, 10)}`);
    expect(res.out).toContain("(5 of its 6 added lines are there)");
    expect(res.out).toContain("Kept origin/main's version of shared.txt");
    // The run log at the end says it too.
    expect(res.out).toMatch(
      /✓ rebased lane onto origin\/main \(skipped [0-9a-f]{10}: already on origin\/main\)/,
    );
    expect(await ownCommits("origin/main", "lane")).toEqual(["lane: own work"]);
    expect(await git(tmpDir, "show", "lane:shared.txt")).toBe(FINAL.trimEnd());
    expect(await git(tmpDir, "status", "--porcelain")).toBe("");
  });

  test("a copy in an upper branch is skipped while it's restacked onto its rebased parent", async () => {
    await createBranch(tmpDir, "lane", "main");
    await makeCommit(tmpDir, "lane.txt", "lane work\n", "lane: own work");
    await createBranch(tmpDir, "upper", "lane");
    await copyDraft("feat: shared greet helper [LANE-2]");
    await makeCommit(tmpDir, "upper.txt", "upper work\n", "upper: own work");
    await stack({ lane: "main", upper: "lane" });
    await pushAllBranches(tmpDir);
    await squashFeatureIntoMain();
    await git(tmpDir, "checkout", "-q", "upper");

    const res = await runCli(["sync", "--no-push"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Skipped");
    expect(res.out).toContain("Already on lane through");
    expect(await ownCommits("lane", "upper")).toEqual(["upper: own work"]);
    expect(await ownCommits("origin/main", "lane")).toEqual(["lane: own work"]);
  });

  test("a copy on a branch checked out in another worktree is skipped there", async () => {
    await createBranch(tmpDir, "lane", "main");
    await makeCommit(tmpDir, "lane.txt", "lane work\n", "lane: own work");
    await createBranch(tmpDir, "upper", "lane");
    await copyDraft("feat: shared greet helper [LANE-2]");
    await makeCommit(tmpDir, "upper.txt", "upper work\n", "upper: own work");
    await stack({ lane: "main", upper: "lane" });
    await pushAllBranches(tmpDir);
    await squashFeatureIntoMain();
    await git(tmpDir, "checkout", "-q", "lane");
    const worktree = `${tmpDir}.worktree`;
    await git(tmpDir, "worktree", "add", "-q", worktree, "upper");

    const res = await runCli(["sync", "--no-push"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Skipped");
    expect(await ownCommits("lane", "upper")).toEqual(["upper: own work"]);
    expect(await git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("upper");
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    expect(await Bun.file(`${worktree}/shared.txt`).text()).toBe(FINAL);
  });

  test("a conflicting commit of the branch's own is not skipped", async () => {
    await createBranch(tmpDir, "lane", "main");
    await makeCommit(
      tmpDir,
      "shared.txt",
      "export function wave(name) {\n  const wave = 'Hi ' + name;\n  window.alert(wave);\n  return wave;\n}\n",
      "lane: its own shared.txt",
    );
    await stack({ lane: "main" });
    await pushAllBranches(tmpDir);
    await squashFeatureIntoMain();
    await git(tmpDir, "checkout", "-q", "lane");

    const res = await runCli(["sync", "--no-push"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("Rebase Conflict");
    expect(res.out).not.toContain("Skipped");
    await git(tmpDir, "rebase", "--abort");
  });

  test("a copy that also changes a file the landed commit didn't touch is not skipped", async () => {
    await createBranch(tmpDir, "lane", "main");
    await git(tmpDir, "cherry-pick", "--no-commit", draftSha);
    await Bun.write(`${tmpDir}/notes.txt`, "lane notes\n");
    await git(tmpDir, "add", "notes.txt");
    await git(tmpDir, "commit", "-q", "-m", "feat: shared greet helper, plus notes [LANE-1]");
    await stack({ lane: "main" });
    await pushAllBranches(tmpDir);
    await squashFeatureIntoMain();
    await git(tmpDir, "checkout", "-q", "lane");

    const res = await runCli(["sync", "--no-push"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("Rebase Conflict");
    expect(res.out).not.toContain("Skipped");
    await git(tmpDir, "rebase", "--abort");
  });
});

describe("landedCopy", () => {
  test("a copy with too few significant added lines is never judged a copy", async () => {
    const onto = await squashFeatureIntoMain();
    await createBranch(tmpDir, "lane", "main~1");
    // Two significant lines, both on main: 100%, but not enough evidence.
    const sha = await makeCommit(
      tmpDir,
      "shared.txt",
      "export function greet(name) {\n  return greeting;\n}\n",
      "lane: two lines",
    );
    expect(MIN_ADDED_LINES).toBe(3);
    expect(await landedCopy(sha, onto, "main~1", tmpDir)).toBeNull();

    // The draft copy itself qualifies, through the squash.
    await git(tmpDir, "checkout", "-q", "main~1");
    await copyDraft("copy");
    const copy = await landedCopy(await git(tmpDir, "rev-parse", "HEAD"), onto, "main~1", tmpDir);
    expect(copy?.via.sha).toBe(onto);
    expect([copy?.present, copy?.added]).toEqual([5, 6]);
  });
});
