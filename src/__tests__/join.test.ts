// Tests for `gh-stack join` (#32): splice an existing branch into a stack.
//
// GitHub is replaced by a fake `gh` on PATH that logs its arguments and
// answers `pr list --head incoming` with PR #20, so PR adoption and base
// retargeting are observable without the network.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  checkout,
  cleanup,
  createBranch,
  createLinearStack,
  createTempRepo,
  makeCommit,
  pushAllBranches,
  readMetadata,
  setupRemote,
  writeMetadata,
} from "./helpers.ts";

// Each test builds repos and spawns the CLI; 5 s flakes under load.
setDefaultTimeout(30_000);

let tmpDir: string;
let remoteDir: string;
let binDir: string;
let ghLog: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  binDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-fakegh-"));
  ghLog = `${binDir}/gh.log`;
  await Bun.write(
    `${binDir}/gh`,
    `#!/bin/sh
echo "$*" >> "${ghLog}"
case "$*" in
  "pr list --head incoming "*) echo 20 ;;
esac
exit 0
`,
  );
  await fs.chmod(`${binDir}/gh`, 0o755);
});

afterEach(async () => {
  await cleanup(tmpDir, binDir);
  if (remoteDir) await cleanup(remoteDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[], env: Record<string, string> = { GH_STACK_YES: "1" }) {
  const baseEnv = { ...process.env };
  delete baseEnv.GH_STACK_YES;
  delete baseEnv.GH_STACK_NO_PUSH;
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...baseEnv,
      PATH: `${binDir}:${process.env.PATH}`,
      NO_COLOR: "1",
      GH_STACK_NO_COLOR: "1",
      ...env,
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
  return { exitCode, stdout, stderr, out: stdout + stderr };
}

async function git(...args: string[]): Promise<string> {
  return (await $`git -C ${tmpDir} ${args}`.text()).trim();
}

/** Files a branch's PR would show vs `base` (three-dot, as GitHub computes it). */
async function prFiles(base: string, head: string): Promise<string[]> {
  const out = await git("diff", "--name-only", `${base}...${head}`);
  return out.split("\n").filter(Boolean).toSorted();
}

async function commitCount(from: string, to: string): Promise<number> {
  return Number(await git("rev-list", "--count", `${from}..${to}`));
}

async function remoteSha(branch: string): Promise<string> {
  const out = await git("ls-remote", "origin", branch);
  return out ? out.split(/\s+/)[0]! : "";
}

async function ghCalls(): Promise<string[]> {
  try {
    return (await Bun.file(ghLog).text()).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Every ref, metadata file, and gh-stack branch config entry — for "nothing changed". */
async function repoState(): Promise<string> {
  const refs = await git("for-each-ref", "--format=%(refname) %(objectname)");
  const config = (await $`git -C ${tmpDir} config --get-regexp ghstack`.nothrow().text()).trim();
  const files: string[] = [];
  const root = `${tmpDir}/.git/.gh-stack`;
  for (const sub of ["active", "archived", "deleted", "snapshots"]) {
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(`${root}/${sub}`)).toSorted();
    } catch {
      // missing dir
    }
    for (const f of entries)
      files.push(`${sub}/${f}\n${await Bun.file(`${root}/${sub}/${f}`).text()}`);
  }
  return [refs, config, ...files].join("\n---\n");
}

/**
 * The #32 scenario: `incoming` forked from main, then main moved on (three
 * unrelated commits, as if other PRs merged), and the stack pr1 → pr2 was
 * branched from the newer main. `incoming` is now 3 commits behind main.
 */
async function behindMainScenario(stackName = "test-stack"): Promise<void> {
  await createBranch(tmpDir, "incoming", "main");
  await makeCommit(tmpDir, "incoming.txt", "incoming\n", "incoming: add file");

  await checkout(tmpDir, "main");
  for (const n of [1, 2, 3])
    await makeCommit(tmpDir, `main${n}.txt`, `m${n}\n`, `main: merged #${n}`);

  await createBranch(tmpDir, "pr1", "main");
  await makeCommit(tmpDir, "pr1.txt", "pr1\n", "pr1: add file");
  await createBranch(tmpDir, "pr2", "pr1");
  await makeCommit(tmpDir, "pr2.txt", "pr2\n", "pr2: add file");

  await writeMetadata(tmpDir, {
    version: 2,
    current_stack: stackName,
    stacks: {
      [stackName]: {
        description: "",
        last_branch: "pr2",
        branches: {
          pr1: { parent: "main", pr: 11 },
          pr2: { parent: "pr1", pr: 12 },
        },
      },
    },
  });
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  await checkout(tmpDir, "pr2");
}

describe("join <branch> (new bottom)", () => {
  test("syncs the incoming branch to main first, so children carry only their own commits", async () => {
    await behindMainScenario();

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(0);

    // incoming was synced onto main, replaying only its own commit.
    expect(await commitCount("main", "incoming")).toBe(1);
    expect(await commitCount("incoming", "main")).toBe(0);
    expect(await prFiles("main", "incoming")).toEqual(["incoming.txt"]);

    // The regression: pr1's diff vs its new parent is ONLY its own commit, not
    // the three main commits incoming was missing.
    expect(await commitCount("incoming", "pr1")).toBe(1);
    expect(await prFiles("incoming", "pr1")).toEqual(["pr1.txt"]);
    expect(await prFiles("pr1", "pr2")).toEqual(["pr2.txt"]);

    // Metadata: incoming is the new root, pr1 hangs off it, PR adopted.
    const meta = await readMetadata(tmpDir);
    const stack = meta.stacks["test-stack"]!;
    expect(stack.branches.incoming?.parent).toBe("main");
    expect(stack.branches.incoming?.pr).toBe(20);
    expect(stack.branches.pr1?.parent).toBe("incoming");
    expect(stack.branches.pr2?.parent).toBe("pr1");
    // A custom stack name is kept.
    expect(Object.keys(meta.stacks)).toEqual(["test-stack"]);

    // Pushed with lease, then PR bases retargeted.
    for (const b of ["incoming", "pr1", "pr2"]) {
      expect(await remoteSha(b)).toBe(await git("rev-parse", b));
    }
    const calls = await ghCalls();
    expect(calls).toContain("pr edit 20 --base main");
    expect(calls).toContain("pr edit 11 --base incoming");
    expect(stack.branches.pr1?.prBase).toBe("incoming");

    // A join snapshot was taken, covering the incoming branch.
    const snap = meta.snapshots?.find((s) => s.operation === "join");
    expect(snap?.branches.incoming).toBeDefined();
    expect(snap?.branches.pr1).toBeDefined();
  });

  test("renames a stack named after its old bottom and absorbs a one-branch stack", async () => {
    await behindMainScenario("pr1");
    // `submit` made incoming its own one-branch stack.
    const meta0 = await readMetadata(tmpDir);
    meta0.stacks.incoming = {
      description: "",
      last_branch: "incoming",
      branches: { incoming: { parent: "main", pr: 20, description: "Incoming fix" } },
    };
    await writeMetadata(tmpDir, meta0);

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(0);

    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks)).toEqual(["incoming"]);
    const stack = meta.stacks.incoming!;
    expect(Object.keys(stack.branches).toSorted()).toEqual(["incoming", "pr1", "pr2"]);
    expect(stack.branches.incoming).toMatchObject({
      parent: "main",
      pr: 20,
      description: "Incoming fix",
    });
    expect(stack.branches.pr1?.parent).toBe("incoming");
    expect(meta.current_stack).toBe("incoming");
    // Old file tombstoned, not archived (an archived copy could be restored
    // into a second live stack holding the same branches).
    expect(meta.archive).toBeUndefined();
    expect(await Bun.file(`${tmpDir}/.git/.gh-stack/deleted/pr1.json`).exists()).toBe(true);
    expect(await prFiles("incoming", "pr1")).toEqual(["pr1.txt"]);
  });
});

describe("join <branch> --above <branch>", () => {
  test("inserts mid-stack: incoming replays only its own commits onto pr1, pr2/pr3 restack", async () => {
    await createLinearStack(tmpDir); // pr1 → pr2 → pr3 on the initial commit
    // main moves on after the stack forked; incoming branches from the new main.
    await checkout(tmpDir, "main");
    await makeCommit(tmpDir, "main1.txt", "m1\n", "main: merged elsewhere");
    await createBranch(tmpDir, "incoming", "main");
    await makeCommit(tmpDir, "incoming.txt", "incoming\n", "incoming: add file");
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr3");
    const pr1Before = await git("rev-parse", "pr1");

    const res = await runCli(["join", "incoming", "--above", "pr1"]);
    expect(res.exitCode).toBe(0);

    expect(await git("rev-parse", "pr1")).toBe(pr1Before);
    // incoming sits on pr1 with just its own commit — not main1.txt, which
    // came from main between the stack's fork and incoming's.
    expect(await commitCount("pr1", "incoming")).toBe(1);
    expect(await prFiles("pr1", "incoming")).toEqual(["incoming.txt"]);
    expect(await prFiles("incoming", "pr2")).toEqual(["pr2.txt"]);
    expect(await prFiles("pr2", "pr3")).toEqual(["pr3.txt"]);

    const stack = (await readMetadata(tmpDir)).stacks["test-stack"]!;
    expect(stack.branches.incoming?.parent).toBe("pr1");
    expect(stack.branches.pr2?.parent).toBe("incoming");
    expect(stack.branches.pr3?.parent).toBe("pr2");
    expect(stack.last_branch).toBe("pr3");

    const calls = await ghCalls();
    expect(calls).toContain("pr edit 20 --base pr1");
    expect(calls).toContain("pr edit 2 --base incoming");
    expect(calls.some((c) => c.startsWith("pr edit 3 "))).toBe(false);
  });

  test("above the top branch makes incoming the new top", async () => {
    await createLinearStack(tmpDir);
    await createBranch(tmpDir, "incoming", "main");
    await makeCommit(tmpDir, "incoming.txt", "incoming\n", "incoming: add file");
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr1");

    const res = await runCli(["join", "incoming", "--above", "pr3", "--no-push"]);
    expect(res.exitCode).toBe(0);
    expect(await prFiles("pr3", "incoming")).toEqual(["incoming.txt"]);
    const stack = (await readMetadata(tmpDir)).stacks["test-stack"]!;
    expect(stack.last_branch).toBe("incoming");
    // --no-push: origin and PR bases untouched.
    expect(await remoteSha("incoming")).not.toBe(await git("rev-parse", "incoming"));
    expect((await ghCalls()).some((c) => c.startsWith("pr edit"))).toBe(false);
  });
});

describe("join --dry-run", () => {
  test("shows the resulting stack and projected changes, and changes nothing", async () => {
    await behindMainScenario();
    const before = await repoState();

    const res = await runCli(["join", "incoming", "--dry-run"]);
    expect(res.exitCode).toBe(0);
    expect(await repoState()).toBe(before);
    expect((await ghCalls()).some((c) => c.startsWith("pr edit"))).toBe(false);

    expect(res.out).toContain("Resulting stack:");
    expect(res.out).toMatch(/incoming #20 — parent main\n\s+1 commit\(s\), 1 file\(s\) changed/);
    expect(res.out).toContain("3 commit(s) behind origin/main");
    expect(res.out).toMatch(
      /pr1 #11 — parent main → incoming\n\s+1 commit\(s\), 1 file\(s\) changed/,
    );
    expect(res.out).toContain("pr2: restacked, diff vs parent unchanged");
    expect(res.out).toContain("#11 (pr1) → incoming");
  });
});

describe("join refusals", () => {
  test("refuses on a dirty working tree", async () => {
    await behindMainScenario();
    await Bun.write(`${tmpDir}/pr2.txt`, "uncommitted\n");
    const before = await repoState();

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Working tree is not clean");
    expect(await repoState()).toBe(before);
  });

  test("refuses a branch that belongs to another multi-branch stack", async () => {
    await behindMainScenario();
    await createBranch(tmpDir, "incoming-child", "incoming");
    await makeCommit(tmpDir, "ic.txt", "ic\n", "incoming-child");
    const meta = await readMetadata(tmpDir);
    meta.stacks.other = {
      description: "",
      last_branch: "incoming-child",
      branches: { incoming: { parent: "main" }, "incoming-child": { parent: "incoming" } },
    };
    await writeMetadata(tmpDir, meta);
    await checkout(tmpDir, "pr2");
    const before = await repoState();

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("belongs to stack other");
    expect(await repoState()).toBe(before);
  });

  test("a conflict syncing the incoming branch leaves the stack untouched", async () => {
    await behindMainScenario();
    // incoming edits a file main later changed too.
    await checkout(tmpDir, "incoming");
    await makeCommit(tmpDir, "main1.txt", "incoming's version\n", "incoming: touch main1");
    await $`git -C ${tmpDir} push -f origin incoming`.quiet();
    await checkout(tmpDir, "pr2");
    const metaBefore = await readMetadata(tmpDir);

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("The stack is unchanged");
    expect(res.out).toContain("gh-stack join incoming");

    const metaAfter = await readMetadata(tmpDir);
    expect(metaAfter.stacks).toEqual(metaBefore.stacks);
    await $`git -C ${tmpDir} rebase --abort`.quiet();
  });

  test("the re-run hint after a sync conflict keeps --above and --no-push", async () => {
    await createLinearStack(tmpDir);
    // incoming adds pr1.txt with other content: syncing it onto pr1 conflicts.
    await createBranch(tmpDir, "incoming", "main");
    await makeCommit(tmpDir, "pr1.txt", "incoming's pr1\n", "incoming: clash with pr1");
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr3");

    const res = await runCli(["join", "incoming", "--above", "pr1", "--no-push"]);
    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("gh-stack join incoming --above pr1 --no-push");
    await $`git -C ${tmpDir} rebase --abort`.quiet();
  });

  test("an unknown flag or extra argument is a usage error, never a bottom join", async () => {
    await behindMainScenario();
    const before = await repoState();

    const typo = await runCli(["join", "incoming", "--abvoe", "pr1"]);
    expect(typo.exitCode).toBe(1);
    expect(typo.out).toContain("Unknown option --abvoe");
    expect(typo.out).toContain("Usage: gh-stack join <branch>");

    const extra = await runCli(["join", "incoming", "pr1"]);
    expect(extra.exitCode).toBe(1);
    expect(extra.out).toContain("Unexpected argument pr1");

    expect(await repoState()).toBe(before);
  });
});

describe("join: incoming branch not on origin (#46 review)", () => {
  test("push mode refuses a local-only incoming branch before touching anything", async () => {
    await behindMainScenario();
    await $`git -C ${tmpDir} push -q origin --delete incoming`.quiet();
    const before = await repoState();

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("isn't on origin");
    expect(res.out).toContain("git push -u origin incoming");
    expect(res.out).toContain("gh-stack join incoming --no-push");
    expect(await repoState()).toBe(before);
  });

  test("--no-push joins a local-only incoming branch", async () => {
    await behindMainScenario();
    await $`git -C ${tmpDir} push -q origin --delete incoming`.quiet();

    const res = await runCli(["join", "incoming", "--no-push"]);
    expect(res.exitCode).toBe(0);
    expect(await prFiles("incoming", "pr1")).toEqual(["pr1.txt"]);
    expect(await remoteSha("incoming")).toBe("");
  });

  test("a rejected push of the incoming branch stops before any child moves", async () => {
    await behindMainScenario();
    const original = await git("rev-parse", "incoming");
    // Someone else moved origin/incoming; our tracking ref still has the old tip,
    // so the --force-with-lease push is rejected.
    await $`git -C ${tmpDir} push -q -f origin main:incoming`.quiet();
    await $`git -C ${tmpDir} update-ref refs/remotes/origin/incoming ${original}`.quiet();
    const kids = { pr1: await git("rev-parse", "pr1"), pr2: await git("rev-parse", "pr2") };
    const metaBefore = await readMetadata(tmpDir);

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("isn't on origin at its synced tip");
    expect(await git("rev-parse", "pr1")).toBe(kids.pr1);
    expect(await git("rev-parse", "pr2")).toBe(kids.pr2);
    expect((await readMetadata(tmpDir)).stacks).toEqual(metaBefore.stacks);
    expect((await ghCalls()).some((c) => c.startsWith("pr edit"))).toBe(false);
  });
});

/** incoming = a, b on main; pr1 is cut from that tip and adds p. Stack: pr1 alone. */
async function childOfIncoming(): Promise<string> {
  await createBranch(tmpDir, "incoming", "main");
  await makeCommit(tmpDir, "a.txt", "a\n", "incoming: a");
  const tip = await makeCommit(tmpDir, "b.txt", "b1\n", "incoming: b");
  await createBranch(tmpDir, "pr1", "incoming");
  await makeCommit(tmpDir, "p.txt", "p\n", "pr1: p");
  await writeMetadata(tmpDir, {
    version: 2,
    current_stack: "test-stack",
    stacks: {
      "test-stack": {
        description: "",
        last_branch: "pr1",
        branches: { pr1: { parent: "main", pr: 11 } },
      },
    },
  });
  return tip;
}

async function publishAndStandOnPr1(): Promise<void> {
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  await checkout(tmpDir, "pr1");
}

describe("join: child cut from an earlier tip of the incoming branch (#46 review)", () => {
  test("refuses when incoming was rewritten after the child was cut, with the exact fix", async () => {
    const oldTip = await childOfIncoming();
    // Rewrite incoming's b with different content: pr1 still carries old b.
    await checkout(tmpDir, "incoming");
    await Bun.write(`${tmpDir}/b.txt`, "b2\n");
    await $`git -C ${tmpDir} commit -q -a --amend -m ${"incoming: b (reworked)"}`.quiet();
    await publishAndStandOnPr1();
    const before = await repoState();

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("older version of incoming");
    expect(res.out).toContain("incoming: b");
    const fix = `git rebase --onto incoming ${oldTip.slice(0, 8)} pr1`;
    expect(res.out).toContain(fix);
    expect(await repoState()).toBe(before);

    // Following the hint makes the join go through cleanly.
    await $`git -C ${tmpDir} rebase -q --onto incoming ${oldTip} pr1`.quiet();
    const again = await runCli(["join", "incoming"]);
    expect(again.exitCode).toBe(0);
    expect(await prFiles("incoming", "pr1")).toEqual(["p.txt"]);
    expect(await git("show", "pr1:b.txt")).toBe("b2");
  });

  test("refuses a child carrying a copy of an incoming commit (patch-id)", async () => {
    await createBranch(tmpDir, "incoming", "main");
    const a = await makeCommit(tmpDir, "a.txt", "a\n", "incoming: a");
    await createBranch(tmpDir, "pr1", "main");
    // -x changes the message, so it's a new commit with the same patch (a plain
    // cherry-pick within the same second can recreate the identical commit).
    await $`git -C ${tmpDir} cherry-pick -x ${a}`.quiet();
    await makeCommit(tmpDir, "p.txt", "p\n", "pr1: p");
    await writeMetadata(tmpDir, {
      version: 2,
      current_stack: "test-stack",
      stacks: {
        "test-stack": {
          description: "",
          last_branch: "pr1",
          branches: { pr1: { parent: "main", pr: 11 } },
        },
      },
    });
    await publishAndStandOnPr1();
    const before = await repoState();

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("1 stale commit(s)");
    expect(res.out).toContain("incoming: a");
    expect(await repoState()).toBe(before);
  });

  test("a child cut from an earlier tip that incoming only appended to joins cleanly", async () => {
    await childOfIncoming();
    await checkout(tmpDir, "incoming");
    await makeCommit(tmpDir, "c.txt", "c\n", "incoming: c");
    await publishAndStandOnPr1();

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(0);
    expect(await commitCount("incoming", "pr1")).toBe(1);
    expect(await prFiles("incoming", "pr1")).toEqual(["p.txt"]);
  });
});

describe("join: rename collision (#46 review)", () => {
  test("keeps the old name when the new bottom's name belongs to an archived stack", async () => {
    await behindMainScenario("pr1");
    const meta0 = await readMetadata(tmpDir);
    meta0.archive = {
      incoming: { description: "old", last_branch: "x", branches: { x: { parent: "main" } } },
    };
    await writeMetadata(tmpDir, meta0);

    const res = await runCli(["join", "incoming"]);
    expect(res.exitCode).toBe(0);
    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks)).toEqual(["pr1"]);
    expect(meta.stacks.pr1?.branches.incoming?.parent).toBe("main");
    expect(meta.archive?.incoming?.description).toBe("old");
  });
});
