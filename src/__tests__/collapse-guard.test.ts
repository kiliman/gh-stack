// #28: a collapsed stack must not silently lose its children's content.
//
// Secondary guard: restack/sync stop before rewriting a branch whose origin
// copy has commits the local branch never had (a collapse's squash commit),
// but not for the pre-rewrite versions a --no-push run leaves on origin.
//
// Primary guard: before the base PR is handed to main, `merge` checks each
// collapsed child's squash commit is still in what it was squashed into.
//
// A second clone stands in for GitHub: it makes the squash commits and pushes
// them, the way `gh pr merge --squash` would on the server.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  checkout,
  cleanup,
  createLinearStack,
  createTempRepo,
  makeCommit,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";
import { verifyCollapse, type CommitFile } from "../lib/collapse-guard.ts";
import type { PrMergeResult } from "../lib/github.ts";
import * as gitLib from "../lib/git.ts";

type MergeFacts = Pick<PrMergeResult, "state" | "baseRefName" | "headRefOid" | "mergeCommit">;

setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let otherDir: string;
let binDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  await createLinearStack(tmpDir); // main → pr1 → pr2 → pr3, PRs #1-#3
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  // GitHub serves reachable commits by sha (e.g. a merged PR's head); an
  // orphaned squash commit isn't fetchable.
  await $`git -C ${remoteDir} config uploadpack.allowReachableSHA1InWant true`.quiet();
  otherDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-github-"));
  await $`git clone -q ${remoteDir} ${otherDir}`.quiet();
  await $`git -C ${otherDir} config user.email gh@test`.quiet();
  await $`git -C ${otherDir} config user.name GitHub`.quiet();
  binDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-fakegh-"));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanup(tmpDir, remoteDir, otherDir, binDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[], env: Record<string, string> = { GH_STACK_YES: "1" }) {
  const base = { ...process.env } as Record<string, string>;
  delete base.GH_STACK_YES;
  delete base.GH_STACK_NO_PUSH;
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...base,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_LOG: `${binDir}/gh.log`,
      GH_PR_DIR: binDir,
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
  return { exitCode, out: stdout + stderr };
}

/** A fake `gh`: `pr view N --json …` prints $GH_PR_DIR/N.json; everything else succeeds silently. */
async function installGhStub(): Promise<void> {
  await Bun.write(
    `${binDir}/gh`,
    `#!/bin/sh
echo "$*" >> "$GH_LOG"
if [ "$1 $2" = "pr view" ]; then
  n=$(cat "$GH_PR_DIR/count-$3" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$GH_PR_DIR/count-$3"
  for spec in $(echo "$GH_FAIL_VIEW" | tr ',' ' '); do
    if [ "\${spec%%:*}" = "$3" ] && [ "$n" -ge "\${spec#*:}" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
  done
  if [ -f "$GH_PR_DIR/$3.json" ]; then cat "$GH_PR_DIR/$3.json"; fi
fi
if [ "$1 $2" = "repo view" ]; then echo acme/widgets; fi
if [ "$1" = "api" ]; then
  if [ "$2" = "-H" ]; then kind=patch; path="$4"; else kind=files; path="$2"; fi
  f="$GH_PR_DIR/$kind-\${path##*/}"
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  exit 1
fi
exit 0
`,
  );
  await fs.chmod(`${binDir}/gh`, 0o755);
}

async function writePr(n: number, data: Record<string, unknown>): Promise<void> {
  await Bun.write(`${binDir}/${n}.json`, JSON.stringify(data));
}

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${dir} ${args}`.text()).trim();
}

async function remoteSha(branch: string): Promise<string> {
  return (await git(remoteDir, "rev-parse", `refs/heads/${branch}`)).trim();
}

/** On "GitHub": squash `child` into `parent` and push. Returns the squash commit. */
async function squashOnGithub(child: string, parent: string, title: string): Promise<string> {
  await git(otherDir, "checkout", "-q", parent);
  await git(otherDir, "pull", "-q", "--ff-only", "origin", parent);
  await git(otherDir, "fetch", "-q", "origin", child);
  await git(otherDir, "merge", "--squash", `origin/${child}`);
  await git(otherDir, "commit", "-q", "-m", title);
  await git(otherDir, "push", "-q", "origin", parent);
  return git(otherDir, "rev-parse", "HEAD");
}

/**
 * Force-push `branch` from "GitHub" and drop the commits that orphans from the
 * remote. A local bare remote would otherwise still serve them by sha (protocol
 * v2 doesn't enforce reachability), unlike GitHub for an orphaned squash commit.
 */
async function forcePushOrphaning(branch: string): Promise<void> {
  await git(otherDir, "push", "-q", "-f", "origin", branch);
  await git(remoteDir, "reflog", "expire", "--expire=now", "--all");
  await git(remoteDir, "gc", "-q", "--prune=now");
}

/** The files a commit wrote, shaped like GitHub's commits API (path, status, blob). */
async function filesOf(dir: string, sha: string): Promise<CommitFile[]> {
  const out = (await $`git -C ${dir} diff-tree -r -z --no-commit-id --root ${sha}`.text()).split(
    "\0",
  );
  const files: CommitFile[] = [];
  for (let i = 0; i + 1 < out.length; i += 2) {
    const [, , , blob, status] = out[i]!.replace(/^:/, "").split(" ");
    const filename = out[i + 1]!;
    if (status === "D") files.push({ filename, status: "removed", sha: null });
    else if (status === "A") files.push({ filename, status: "added", sha: blob!, before: null });
    else files.push({ filename, status: "modified", sha: blob! });
  }
  return files;
}

/** main moves on origin, so sync has something to rebase onto. */
async function moveMainOnOrigin(): Promise<void> {
  await git(otherDir, "checkout", "-q", "main");
  await Bun.write(`${otherDir}/main-new.txt`, "new\n");
  await git(otherDir, "add", "main-new.txt");
  await git(otherDir, "commit", "-q", "-m", "main moves");
  await git(otherDir, "push", "-q", "origin", "main");
}

describe("secondary guard: restack/sync won't rewrite past commits only origin has", () => {
  test("sync after a collapse squash landed on the base branch stops, naming the commit", async () => {
    await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    await moveMainOnOrigin();
    // The user fetched (so --force-with-lease would pass) but never pulled pr1.
    await git(tmpDir, "fetch", "-q", "origin");
    const pr1Origin = await remoteSha("pr1");
    const pr1Local = await git(tmpDir, "rev-parse", "pr1");
    await checkout(tmpDir, "pr1");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Origin has commits that the local branches don't");
    expect(res.out).toContain("Squash of PR #2 (#2)");
    expect(res.out).toContain("git pull --ff-only origin pr1");
    expect(res.out).toContain("--overwrite-remote");
    // Nothing was rewritten, here or on origin.
    expect(await remoteSha("pr1")).toBe(pr1Origin);
    expect(await git(tmpDir, "rev-parse", "pr1")).toBe(pr1Local);
  });

  test("restack stops when a child's origin copy has a commit pushed from elsewhere", async () => {
    await git(otherDir, "checkout", "-q", "pr2");
    await Bun.write(`${otherDir}/collab.txt`, "theirs\n");
    await git(otherDir, "add", "collab.txt");
    await git(otherDir, "commit", "-q", "-m", "collaborator's commit");
    await git(otherDir, "push", "-q", "origin", "pr2");
    await git(tmpDir, "fetch", "-q", "origin");
    const pr2Origin = await remoteSha("pr2");
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("collaborator's commit");
    expect(res.out).toContain("git pull --ff-only origin pr2");
    expect(await remoteSha("pr2")).toBe(pr2Origin);
  });

  test("--overwrite-remote rewrites anyway", async () => {
    const squash = await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    await moveMainOnOrigin();
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr1");

    const res = await runCli(["sync", "--overwrite-remote"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("--overwrite-remote: continuing");
    const contains = await $`git -C ${remoteDir} merge-base --is-ancestor ${squash} refs/heads/pr1`
      .nothrow()
      .quiet();
    expect(contains.exitCode).not.toBe(0);
  });

  test("no false positive: origin holding the pre-rewrite versions a --no-push run left", async () => {
    // pr1 gains a pr2.txt that conflicts with pr2's own, so pr2's rebased
    // commit is NOT patch-equivalent to the one still on origin.
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr2.txt", "from pr1\n", "pr1: conflicting pr2.txt");
    expect((await runCli(["restack", "--no-push"])).exitCode).toBe(2);
    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await $`git -C ${tmpDir} add pr2.txt`.quiet();
    await $`git -C ${tmpDir} rebase --continue`.env({ ...process.env, GIT_EDITOR: "true" }).quiet();
    expect((await runCli(["restack", "--resume"])).exitCode).toBe(0);
    expect(await remoteSha("pr2")).not.toBe(await git(tmpDir, "rev-parse", "pr2"));

    await checkout(tmpDir, "pr1");
    const res = await runCli(["restack", "--push"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Origin has commits");
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await git(tmpDir, "rev-parse", b));
    }
  });
});

describe("review fixes (#50)", () => {
  test("sync after merge --approved + base landed: the merged bottoms aren't guarded, sync advances", async () => {
    // PR #2 was collapsed into pr1, then PR #1 squash-merged into main.
    await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    await git(otherDir, "checkout", "-q", "main");
    await git(otherDir, "merge", "--squash", "origin/pr1");
    await git(otherDir, "commit", "-q", "-m", "PR #1 (#1)");
    await git(otherDir, "push", "-q", "origin", "main");
    for (const [n, state] of [
      [1, "MERGED"],
      [2, "MERGED"],
      [3, "OPEN"],
    ] as const) {
      await writePr(n, { number: n, title: `PR ${n}`, state, url: `https://x/${n}` });
    }
    await installGhStub();
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr3");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Origin has commits");
    expect(await git(tmpDir, "rev-list", "--count", "origin/main..pr3")).toBe("1");
    expect(await remoteSha("pr3")).toBe(await git(tmpDir, "rev-parse", "pr3"));
  });

  test("main merged into a PR branch on GitHub (Update branch) isn't new content; restack pushes", async () => {
    await moveMainOnOrigin();
    await git(otherDir, "fetch", "-q", "origin");
    await git(otherDir, "checkout", "-q", "pr2");
    await git(otherDir, "pull", "-q", "--ff-only", "origin", "pr2");
    await git(otherDir, "merge", "-q", "--no-edit", "origin/main");
    await git(otherDir, "push", "-q", "origin", "pr2");
    // Fetched, never pulled: --force-if-includes alone would refuse this push.
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Origin has commits");
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await git(tmpDir, "rev-parse", b));
    }
  });

  test("--force-if-includes refuses to overwrite a fetched, never-integrated tip, in gh-stack terms", async () => {
    await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr1");
    await git(tmpDir, "commit", "-q", "--amend", "-m", "pr1: reworded");
    process.chdir(tmpDir);

    const result = await gitLib.forcePushWithLease("pr1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-integrated");
    const hint = gitLib.pushFailureHint("pr1", result).join("\n");
    expect(hint).toContain("fetched but never brought into local pr1");
    expect(hint).toContain("--overwrite-remote");
  });

  test("restack --resume --dry-run reports the guard instead of skipping it", async () => {
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr2.txt", "from pr1\n", "pr1: conflicting pr2.txt");
    expect((await runCli(["restack", "--no-push"])).exitCode).toBe(2);
    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await $`git -C ${tmpDir} add pr2.txt`.quiet();
    await $`git -C ${tmpDir} rebase --continue`.env({ ...process.env, GIT_EDITOR: "true" }).quiet();
    await git(otherDir, "checkout", "-q", "pr3");
    await Bun.write(`${otherDir}/collab.txt`, "theirs\n");
    await git(otherDir, "add", "collab.txt");
    await git(otherDir, "commit", "-q", "-m", "collaborator's commit");
    await git(otherDir, "push", "-q", "origin", "pr3");

    const res = await runCli(["restack", "--resume", "--dry-run"]);

    expect(res.out).toContain("collaborator's commit");
    expect(res.out).toContain("[DRY RUN] A real run would stop here.");
  });
});

describe("round 3: fail closed (#50)", () => {
  /** A squash commit collapsed into pr1, as GitHub would report it. */
  async function collapsePr2(): Promise<{ results: Map<number, MergeFacts>; s2: string }> {
    const pr2Head = await remoteSha("pr2");
    const s2 = await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    return {
      results: new Map([
        [2, { state: "MERGED", baseRefName: "pr1", headRefOid: pr2Head, mergeCommit: s2 }],
      ]),
      s2,
    };
  }
  const onlyPr2 = [{ branch: "pr2", pr: 2, parent: "pr1", parentPr: null }];

  async function verifyIn(dir: string, results: Map<number, MergeFacts>) {
    process.chdir(dir);
    return verifyCollapse({
      base: "pr1",
      trunkRef: "origin/main",
      children: onlyPr2,
      lookup: {
        prResult: async (pr) => results.get(pr) ?? null,
        commitPatch: async () => null,
        commitFiles: async () => null,
      },
    });
  }

  test("a local squash commit with no proof either way is unconfirmed, not missing", async () => {
    const { results } = await collapsePr2();
    await git(tmpDir, "fetch", "-q", "origin"); // the squash commit is local
    // pr1 rewritten so its files hold a third version: neither the squash's nor the one before.
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--hard", "HEAD~1");
    await Bun.write(`${otherDir}/pr2.txt`, "something else\n");
    await git(otherDir, "add", "pr2.txt");
    await git(otherDir, "commit", "-q", "-m", "pr1: unrelated pr2.txt");
    await forcePushOrphaning("pr1");

    const [v] = await verifyIn(tmpDir, results);
    expect(v!.status).toBe("unconfirmed");
  });

  test("a local squash commit whose files are all as they were before it is missing (proof)", async () => {
    const { results } = await collapsePr2();
    await git(tmpDir, "fetch", "-q", "origin");
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--hard", "HEAD~1");
    await forcePushOrphaning("pr1");

    const [v] = await verifyIn(tmpDir, results);
    expect(v!.status).toBe("missing");
  });

  test("a shallow clone never reports missing because of its boundary", async () => {
    const { results } = await collapsePr2();
    // pr1 moves on past the squash, changing one of its files: a full clone
    // proves the squash is an ancestor; a depth-1 clone can't see that far.
    await git(otherDir, "checkout", "-q", "pr1");
    await Bun.write(`${otherDir}/pr2.txt`, "edited after the collapse\n");
    await git(otherDir, "add", "pr2.txt");
    await git(otherDir, "commit", "-q", "-m", "pr1: follow-up");
    await git(otherDir, "push", "-q", "origin", "pr1");
    const shallowDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-shallow-"));
    try {
      await $`git clone -q --depth 1 --no-single-branch file://${remoteDir} ${shallowDir}`.quiet();

      const [v] = await verifyIn(shallowDir, results);
      expect(v!.status).toBe("unconfirmed");
      if (v!.status === "unconfirmed") expect(v!.reason).toContain("shallow");

      const [full] = await verifyIn(tmpDir, results);
      expect(full!.status).toBe("covered");
    } finally {
      await cleanup(shallowDir);
    }
  });

  test("non-ASCII paths compare correctly (-z): a squash folded into another commit still counts", async () => {
    await checkout(tmpDir, "pr2");
    await makeCommit(tmpDir, "naïve-ü.txt", "unicode\n", "pr2: non-ASCII path");
    await git(tmpDir, "push", "-q", "origin", "pr2");
    const { results } = await collapsePr2();
    await git(tmpDir, "fetch", "-q", "origin"); // the squash commit is local
    // pr1's own commit and the squash folded into one: no ancestry, no patch-id match.
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--soft", "HEAD~2");
    await git(otherDir, "commit", "-q", "-m", "pr1 + PR #2, folded");
    await forcePushOrphaning("pr1");

    const [v] = await verifyIn(tmpDir, results);
    expect(v!.status).toBe("covered");
  });

  test("a failed advance push is retried later, and the PR is retargeted then", async () => {
    // PR #1 merged into main on GitHub; pr2's first push is rejected once.
    await git(otherDir, "checkout", "-q", "main");
    await git(otherDir, "merge", "-q", "--squash", "origin/pr1");
    await git(otherDir, "commit", "-q", "-m", "PR #1 (#1)");
    await git(otherDir, "push", "-q", "origin", "main");
    const marker = `${remoteDir}/rejected-once`;
    await Bun.write(
      `${remoteDir}/hooks/pre-receive`,
      `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/pr2" ] && [ ! -f "${marker}" ]; then touch "${marker}"; echo "transient" >&2; exit 1; fi
done
exit 0
`,
    );
    await fs.chmod(`${remoteDir}/hooks/pre-receive`, 0o755);
    for (const [n, state] of [
      [1, "MERGED"],
      [2, "OPEN"],
      [3, "OPEN"],
    ] as const) {
      await writePr(n, { number: n, title: `PR ${n}`, state, url: `https://x/${n}` });
    }
    await installGhStub();
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr2");

    const res = await runCli(["sync"]);

    expect(res.out).toContain("Push of pr2 failed");
    expect(await remoteSha("pr2")).toBe(await git(tmpDir, "rev-parse", "pr2"));
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr edit 2 --base main");
  });

  test("the advance push honors the guard's verified tip (explicit lease)", async () => {
    // PR #1 merged; pr2 had main merged into it on GitHub ("Update branch"),
    // which this clone fetched but never pulled.
    await git(otherDir, "checkout", "-q", "main");
    await git(otherDir, "merge", "-q", "--squash", "origin/pr1");
    await git(otherDir, "commit", "-q", "-m", "PR #1 (#1)");
    await git(otherDir, "push", "-q", "origin", "main");
    await git(otherDir, "checkout", "-q", "pr2");
    await git(otherDir, "pull", "-q", "--ff-only", "origin", "pr2");
    await git(otherDir, "merge", "-q", "--no-edit", "origin/main");
    await git(otherDir, "push", "-q", "origin", "pr2");
    for (const [n, state] of [
      [1, "MERGED"],
      [2, "OPEN"],
      [3, "OPEN"],
    ] as const) {
      await writePr(n, { number: n, title: `PR ${n}`, state, url: `https://x/${n}` });
    }
    await installGhStub();
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr2");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Push of pr2 failed");
    expect(await remoteSha("pr2")).toBe(await git(tmpDir, "rev-parse", "pr2"));
  });

  test("a git rev-list failure in the remote guard fails closed", async () => {
    // A --no-push restack leaves origin's pr2/pr3 at their pre-rewrite versions.
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");
    expect((await runCli(["restack", "--no-push"])).exitCode).toBe(0);
    const pr2Origin = await remoteSha("pr2");
    const realGit = Bun.which("git")!;
    await Bun.write(
      `${binDir}/git`,
      `#!/bin/sh
if [ -n "$FAIL_REV_LIST" ] && [ "$1" = "rev-list" ]; then echo "fatal: forced failure" >&2; exit 128; fi
exec "${realGit}" "$@"
`,
    );
    await fs.chmod(`${binDir}/git`, 0o755);

    const res = await runCli(["restack", "--push"], { GH_STACK_YES: "1", FAIL_REV_LIST: "1" });

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("git rev-list failed");
    expect(await remoteSha("pr2")).toBe(pr2Origin);
  });
});

describe("primary guard: verifyCollapse", () => {
  /** Collapse pr3 → pr2 → pr1 on "GitHub"; returns the PR results gh would report. */
  async function collapse(): Promise<{
    results: Map<number, MergeFacts>;
    s2: string;
    s3: string;
  }> {
    const pr3Head = await remoteSha("pr3");
    const s3 = await squashOnGithub("pr3", "pr2", "Squash of PR #3 (#3)");
    const pr2Head = await remoteSha("pr2");
    const s2 = await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    const results = new Map<number, MergeFacts>([
      [3, { state: "MERGED", baseRefName: "pr2", headRefOid: pr3Head, mergeCommit: s3 }],
      [2, { state: "MERGED", baseRefName: "pr1", headRefOid: pr2Head, mergeCommit: s2 }],
    ]);
    return { results, s2, s3 };
  }

  const children = [
    { branch: "pr3", pr: 3, parent: "pr2", parentPr: 2 },
    { branch: "pr2", pr: 2, parent: "pr1", parentPr: null },
  ];

  async function verify(
    results: Map<number, MergeFacts>,
    patches = new Map<string, string>(),
    files = new Map<string, CommitFile[]>(),
  ) {
    process.chdir(tmpDir);
    return verifyCollapse({
      base: "pr1",
      trunkRef: "origin/main",
      children,
      lookup: {
        prResult: async (pr) => results.get(pr) ?? null,
        commitPatch: async (sha) => patches.get(sha) ?? null,
        commitFiles: async (sha) => files.get(sha) ?? null,
      },
    });
  }

  test("an intact collapse is covered", async () => {
    const { results } = await collapse();
    const verdicts = await verify(results);
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:covered"]);
  });

  test("#28: the base rewritten without the squash commit → PR #2 is missing", async () => {
    const { results, s2 } = await collapse();
    const patch = await git(otherDir, "format-patch", "-1", "--stdout", s2);
    const files = await filesOf(otherDir, s2);
    // A sync rewrote pr1 back to base-only and force-pushed it. The squash
    // commit is now orphaned on GitHub: not fetchable, but GitHub still has
    // its patch and file list, and neither is in pr1.
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--hard", "HEAD~1");
    await forcePushOrphaning("pr1");

    const verdicts = await verify(results, new Map([[s2, `${patch}\n`]]), new Map([[s2, files]]));
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:missing"]);
    const pr2 = verdicts[1]!;
    if (pr2.status === "missing") expect(pr2.fetchable).toBe(false);
  });

  test("unfetchable and GitHub returns nothing: unconfirmed, never claimed missing", async () => {
    const { results } = await collapse();
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--hard", "HEAD~1");
    await forcePushOrphaning("pr1");

    const verdicts = await verify(results);
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual([
      "3:covered",
      "2:unconfirmed",
    ]);
  });

  test("unfetchable, no patch, but the base tree holds every file it wrote: covered", async () => {
    const { results, s2 } = await collapse();
    const files = await filesOf(otherDir, s2);
    await moveMainOnOrigin();
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "rebase", "-q", "main");
    await forcePushOrphaning("pr1");

    const verdicts = await verify(results, new Map(), new Map([[s2, files]]));
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:covered"]);
  });

  test("a rebased copy of an unfetchable squash commit counts, via its patch from GitHub", async () => {
    const { results, s2 } = await collapse();
    const patch = await git(otherDir, "format-patch", "-1", "--stdout", s2);
    // pr1 (with the squash) rebased onto a moved main: the commit is rewritten
    // and the original is gone from the remote.
    await moveMainOnOrigin();
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "rebase", "-q", "main");
    await forcePushOrphaning("pr1");
    await git(tmpDir, "fetch", "-q", "origin", "main");

    const verdicts = await verify(results, new Map([[s2, `${patch}\n`]]));
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:covered"]);
  });

  test("a rebased copy of a squash commit we have locally counts too", async () => {
    const { results } = await collapse();
    await git(tmpDir, "fetch", "-q", "origin"); // the squash commit is now local
    await moveMainOnOrigin();
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "rebase", "-q", "main");
    await forcePushOrphaning("pr1");
    await git(tmpDir, "fetch", "-q", "origin", "main");

    const verdicts = await verify(results); // no patch from "GitHub"
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:covered"]);
  });

  test("an intermediate branch merged without its child's squash → that child is missing", async () => {
    const { results } = await collapse();
    // PR #2 merged a head from before PR #3 was squashed into it.
    const pr2Before = await git(otherDir, "rev-parse", "origin/pr2~1");
    results.set(2, { ...results.get(2)!, headRefOid: pr2Before });

    const verdicts = await verify(results);
    const pr3 = verdicts.find((v) => v.child.pr === 3)!;
    expect(pr3.status).toBe("missing");
    if (pr3.status === "missing") expect(pr3.containerLabel).toBe("PR #2's merged head");
  });

  test("when GitHub can't say, it's unverified rather than a guess", async () => {
    const { results } = await collapse();
    results.delete(3);
    const verdicts = await verify(results);
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:unverified", "2:covered"]);
  });
});

describe("primary guard: merge", () => {
  async function stackCollapsed(): Promise<string> {
    const pr3Head = await remoteSha("pr3");
    const s3 = await squashOnGithub("pr3", "pr2", "Squash of PR #3 (#3)");
    const pr2Head = await remoteSha("pr2");
    const s2 = await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    const merged = { state: "MERGED", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
    await writePr(3, {
      ...merged,
      headRefName: "pr3",
      headRefOid: pr3Head,
      baseRefName: "pr2",
      mergeCommit: { oid: s3 },
    });
    await writePr(2, {
      ...merged,
      headRefName: "pr2",
      headRefOid: pr2Head,
      baseRefName: "pr1",
      mergeCommit: { oid: s2 },
    });
    await writePr(1, {
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefName: "pr1",
      headRefOid: await remoteSha("pr1"),
      baseRefName: "main",
      mergeCommit: null,
    });
    await installGhStub();
    await checkout(tmpDir, "pr1");
    return s2;
  }

  /** On "GitHub": rewrite pr1 back to base-only, orphaning the squash commit. */
  async function rewriteBaseWithoutSquash(): Promise<void> {
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--hard", "HEAD~1");
    await forcePushOrphaning("pr1");
  }

  test("re-running merge after the base was rewritten stops before auto-merge, naming the PR", async () => {
    const s2 = await stackCollapsed();
    await Bun.write(
      `${binDir}/patch-${s2}`,
      await git(otherDir, "format-patch", "-1", "--stdout", s2),
    );
    await Bun.write(`${binDir}/files-${s2}`, JSON.stringify(await filesOf(otherDir, s2)));
    await rewriteBaseWithoutSquash();

    const res = await runCli(["merge"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("PR #2 (pr2)'s changes are missing from PR #1");
    expect(res.out).toContain("Nothing was merged to main");
    // The squash commit can't be fetched, so the fix leads with its patch.
    expect(res.out).toContain(
      `gh api -H "Accept: application/vnd.github.patch" repos/acme/widgets/commits/${s2} | git am`,
    );
    expect(res.out).not.toContain(`git fetch origin ${s2}`);
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).not.toContain("--auto");
  });

  test("when the content can't be checked, --yes stops as UNVERIFIED (not missing)", async () => {
    await stackCollapsed();
    await rewriteBaseWithoutSquash(); // and GitHub serves neither patch nor files

    const res = await runCli(["merge"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("UNVERIFIED, not known to be missing");
    expect(res.out).toContain("gh-stack merge --skip-collapse-check");
    expect(res.out).not.toContain("changes are missing from");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).not.toContain("--auto");
  });

  test("a GitHub failure during the check stops merge --yes (exit 2), never auto-merges", async () => {
    await stackCollapsed();
    // PR #2's 3rd `gh pr view` (the guard's, after the plan and the loop) fails.
    const res = await runCli(["merge"], { GH_STACK_YES: "1", GH_FAIL_VIEW: "2:3" });

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("Could not confirm PR #2 (pr2)'s changes are in PR #1");
    expect(res.out).toContain("couldn't read PR #2 from GitHub");
    expect(res.out).toContain("gh-stack merge --skip-collapse-check");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).not.toContain("--auto");
  });

  test("the hand-check steps list every child that couldn't be confirmed", async () => {
    await stackCollapsed();
    const res = await runCli(["merge"], { GH_STACK_YES: "1", GH_FAIL_VIEW: "2:3,3:3" });

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("gh pr diff 2 --name-only");
    expect(res.out).toContain("gh pr diff 3 --name-only");
  });

  test("merge --base checks a base that carries collapsed PRs, and won't merge it without them", async () => {
    await stackCollapsed();
    await rewriteBaseWithoutSquash();

    const res = await runCli(["merge", "--base"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("PR #2 (pr2)");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).not.toContain("pr merge 1");
  });

  test("an intact collapse goes on to enable auto-merge", async () => {
    await stackCollapsed();

    const res = await runCli(["merge"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("PR #1 holds every collapsed PR's changes");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr merge 1 --squash --auto");
  });
});
