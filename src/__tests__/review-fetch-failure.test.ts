// #66: a failed `gh pr view` was read as "not approved" (merge --approved) or
// "not merged" (sync), so a transient gh failure silently changed the plan.
// Now a failure is retried, and one that persists stops the command.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  checkout,
  cleanup,
  createGhStub,
  createLinearStack,
  createTempRepo,
  getSha,
  ghStubEnv,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";
import { planMerges, type BranchReview } from "../lib/advance.ts";

setDefaultTimeout(60_000);

const cliPath = new URL("../index.ts", import.meta.url).pathname;
const KEYRING_ERROR =
  "X Failed to switch account for github.com to kiliman\nfailed to move active token in keyring: exit status 45\n";

let tmpDir: string;
let remoteDir: string;
let stubDir: string;
let viewDir: string;

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...process.env,
      ...ghStubEnv(stubDir),
      GH_PR_VIEW_DIR: viewDir,
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

/** Make `gh pr view <n>` answer with this PR state. */
async function pr(n: number, state: string, reviewDecision: string): Promise<void> {
  const json = {
    number: n,
    title: `PR ${n} (${n}/3)`,
    state,
    reviewDecision,
    isDraft: false,
    url: `https://github.com/acme/widgets/pull/${n}`,
    updatedAt: "2026-11-13T00:00:00Z",
    statusCheckRollup: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefName: `pr${n}`,
    headRefOid: "0".repeat(40),
    baseRefName: n === 1 ? "main" : `pr${n - 1}`,
    mergeCommit: null,
    mergedAt: null,
  };
  await Bun.write(`${viewDir}/${n}.json`, JSON.stringify(json));
}

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = await setupRemote(tmpDir);
  stubDir = await createGhStub();
  viewDir = `${stubDir}/views`;
  await fs.mkdir(viewDir);
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, stubDir);
});

describe("planMerges with an unreadable PR", () => {
  const r = (
    branch: string,
    n: number,
    reviewDecision: string | null,
    fetchError?: string,
  ): BranchReview => ({
    branch,
    pr: n,
    prState: fetchError ? null : "OPEN",
    reviewDecision,
    ...(fetchError ? { fetchError } : {}),
  });

  test("stops at the unreadable PR with its error, marked as a fetch failure", () => {
    const plan = planMerges(
      [r("a", 1, "APPROVED"), r("b", 2, null, "couldn't read PR #2"), r("c", 3, "APPROVED")],
      { approveAndMerge: true },
    );
    expect(plan.steps).toEqual([{ branch: "a", pr: 1, action: "merge" }]);
    expect(plan.stop).toEqual({ branch: "b", reason: "couldn't read PR #2", fetchFailed: true });
  });

  test("sync mode also stops there, rather than read it as unmerged", () => {
    const plan = planMerges([r("a", 1, null, "couldn't read PR #1")], { approveAndMerge: false });
    expect(plan.stop?.fetchFailed).toBe(true);
  });
});

describe("merge --approved", () => {
  beforeEach(async () => {
    await createLinearStack(tmpDir);
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr3");
    await pr(1, "OPEN", "APPROVED");
    await pr(2, "OPEN", "APPROVED");
    await pr(3, "OPEN", "REVIEW_REQUIRED");
  });

  test("a review state that can't be read stops it, and changes nothing", async () => {
    await Bun.write(`${viewDir}/2.fail`, KEYRING_ERROR);
    const before = await getSha(tmpDir, "pr1");

    const { exitCode, out } = await runCli(["merge", "--approved"]);

    expect(exitCode).toBe(1);
    expect(out).toContain("Couldn't read the review state");
    expect(out).toContain("pr2: couldn't read PR #2 from GitHub");
    expect(out).toContain("failed to move active token in keyring");
    expect(out).not.toContain("unapproved");
    expect(await getSha(tmpDir, "pr1")).toBe(before);
  });

  test("a failure that clears on retry plans the full approved range", async () => {
    await Bun.write(`${viewDir}/2.flaky`, KEYRING_ERROR);

    const { exitCode, out } = await runCli(["merge", "--approved", "--dry-run"]);

    expect(exitCode).toBe(0);
    expect(out).toContain("collapsing the 2 approved branch(es)");
    expect(await Bun.file(`${viewDir}/2.flaky`).exists()).toBe(false); // it did fail once
  });
});

describe("sync", () => {
  test("a bottom PR whose state can't be read stops sync instead of restacking it", async () => {
    await createLinearStack(tmpDir);
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr2");
    await Bun.write(`${viewDir}/1.fail`, KEYRING_ERROR);
    const before = { pr2: await getSha(tmpDir, "pr2"), pr3: await getSha(tmpDir, "pr3") };

    const { exitCode, out } = await runCli(["sync"]);

    expect(exitCode).toBe(1);
    expect(out).toContain("couldn't read PR #1 from GitHub");
    expect(out).toContain("rather than guess");
    expect(await getSha(tmpDir, "pr2")).toBe(before.pr2);
    expect(await getSha(tmpDir, "pr3")).toBe(before.pr3);
  });
});
