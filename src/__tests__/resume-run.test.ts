// Interrupted runs (#15, #29): every restack/sync keeps a saved state with an
// action log until its last push, `restack --resume` continues it (or reports
// that it finished), a bare `restack`/`sync` resumes a pending run instead of
// starting a different one, and a branch is never pushed onto a parent whose
// push didn't land.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import {
  addConflictingMainCommit,
  checkout,
  cleanup,
  createGhStub,
  createLinearStack,
  createTempRepo,
  makeCommit,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";
import { RUN_STATE_VERSION, type RestackState } from "../types.ts";

// Each test builds repos and spawns the CLI several times; 5 s flakes under load.
setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let stubDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = "";
  stubDir = await createGhStub();
});

afterEach(async () => {
  await cleanup(tmpDir, stubDir);
  if (remoteDir) await cleanup(remoteDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

function cliEnv(env: Record<string, string>): Record<string, string> {
  const base = { ...process.env } as Record<string, string>;
  delete base.GH_STACK_YES;
  delete base.GH_STACK_NO_PUSH;
  return {
    ...base,
    PATH: `${stubDir}:${process.env.PATH}`,
    GH_LOG: `${stubDir}/calls.log`,
    NO_COLOR: "1",
    GH_STACK_NO_COLOR: "1",
    ...env,
  };
}

function spawnCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: cliEnv(env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.end();
  return proc;
}

async function runCli(args: string[], env: Record<string, string> = { GH_STACK_YES: "1" }) {
  const proc = spawnCli(args, env);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, out: stdout + stderr };
}

async function sha(ref: string): Promise<string> {
  return (await $`git -C ${tmpDir} rev-parse ${ref}`.text()).trim();
}

async function remoteSha(branch: string): Promise<string> {
  const out = (await $`git -C ${tmpDir} ls-remote origin refs/heads/${branch}`.text()).trim();
  return out ? out.split(/\s+/)[0]! : "";
}

async function isAncestor(a: string, b: string): Promise<boolean> {
  const { exitCode } = await $`git -C ${tmpDir} merge-base --is-ancestor ${a} ${b}`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

async function savedState(): Promise<RestackState | null> {
  const file = Bun.file(`${tmpDir}/.git/.gh-stack/restack-state.json`);
  return (await file.exists()) ? file.json() : null;
}

/** Install a pre-receive hook on the bare remote; `null` removes it. */
async function setPreReceive(script: string | null): Promise<void> {
  const hook = `${remoteDir}/hooks/pre-receive`;
  if (script === null) {
    await fs.rm(hook, { force: true });
    return;
  }
  await Bun.write(hook, script);
  await fs.chmod(hook, 0o755);
}

function rejectRef(branch: string): string {
  return `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/${branch}" ]; then echo "rejected by test hook" >&2; exit 1; fi
done
exit 0
`;
}

/** main → pr1 → pr2 → pr3, all on origin, then a new commit on pr1. */
async function stackNeedingRestack(): Promise<void> {
  await createLinearStack(tmpDir);
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  await checkout(tmpDir, "pr1");
  await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");
}

/**
 * main → pr1 → pr2 → pr3 on origin, where main gains a commit that conflicts
 * with pr1. `sync` stops on pr1; the conflict is resolved and the rebase
 * continued, leaving the sync interrupted with pr2/pr3 still to restack.
 */
async function syncStoppedOnConflictThenContinued(): Promise<void> {
  await createLinearStack(tmpDir, { conflicting: true });
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  await addConflictingMainCommit(tmpDir);
  await $`git -C ${tmpDir} push -q origin main`.quiet();
  await checkout(tmpDir, "pr1");

  const first = await runCli(["sync"]);
  expect(first.exitCode).toBe(2);
  expect(first.out).toContain("gh-stack restack --resume");

  await Bun.write(`${tmpDir}/shared.txt`, "resolved\n");
  await $`git -C ${tmpDir} add shared.txt`.quiet();
  await $`git -C ${tmpDir} rebase --continue`.env({ ...process.env, GIT_EDITOR: "true" }).quiet();
}

describe("a bare restack/sync with an interrupted run pending (#29)", () => {
  test("bare restack under GH_STACK_YES resumes the interrupted sync, not a fresh restack", async () => {
    await syncStoppedOnConflictThenContinued();
    const pr2Before = await sha("pr2");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain(
      "An interrupted sync was detected (stopped at pr1: rebasing onto origin/main)",
    );
    expect(res.out).toContain("Resuming the interrupted sync");
    // A fresh restack from pr1 would skip it as the base branch.
    expect(res.out).not.toContain("Skipping base branch");
    expect(await sha("pr2")).not.toBe(pr2Before);
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await sha(b));
    }
    expect(await isAncestor("origin/main", "pr1")).toBe(true);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    expect((await savedState())?.finished_at).toBeTruthy();
  });

  test("a bare sync resumes it too", async () => {
    await syncStoppedOnConflictThenContinued();

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Resuming the interrupted sync");
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await sha(b));
    }
  });

  test("without --yes and no TTY it asks (and so exits) instead of starting fresh", async () => {
    await syncStoppedOnConflictThenContinued();
    const pr2Before = await sha("pr2");

    const res = await runCli(["restack"], {});

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("refusing to prompt");
    expect(res.out).toContain("An interrupted sync was detected");
    expect(await sha("pr2")).toBe(pr2Before);
    expect((await savedState())?.finished_at).toBeNull();
  });

  test("--fresh discards the interrupted run and restacks from the current branch", async () => {
    await syncStoppedOnConflictThenContinued();

    const res = await runCli(["restack", "--fresh"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("--fresh: discarding the interrupted sync");
    expect(res.out).toContain("Skipping base branch");
    const state = await savedState();
    expect(state?.command).toBe("restack");
    expect(state?.finished_at).toBeTruthy();
  });

  test("while the conflict is unresolved, a bare restack names the resume path", async () => {
    await createLinearStack(tmpDir, { conflicting: true });
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);
    await addConflictingMainCommit(tmpDir);
    await $`git -C ${tmpDir} push -q origin main`.quiet();
    await checkout(tmpDir, "pr1");
    expect((await runCli(["sync"])).exitCode).toBe(2);

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain(
      "An interrupted sync stopped on a conflict rebasing pr1 onto origin/main",
    );
    expect(res.out).toContain("gh-stack restack --resume");
  });

  async function syncStoppedOnConflictThenAborted(): Promise<void> {
    await createLinearStack(tmpDir, { conflicting: true });
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);
    await addConflictingMainCommit(tmpDir);
    await $`git -C ${tmpDir} push -q origin main`.quiet();
    await checkout(tmpDir, "pr1");
    expect((await runCli(["sync"])).exitCode).toBe(2);
    await $`git -C ${tmpDir} rebase --abort`.quiet();
  }

  test("after git rebase --abort, --resume runs that rebase again; the run is kept", async () => {
    await syncStoppedOnConflictThenAborted();

    const resume = await runCli(["restack", "--resume"]);
    expect(resume.exitCode).toBe(2); // the same conflict, met again
    expect(resume.out).toContain("didn't happen (interrupted before it started, or aborted)");
    const state = await savedState();
    expect(state?.finished_at).toBeNull();
    expect(state?.rebase?.branch).toBe("pr1");
  });

  test("after git rebase --abort, a bare restack resumes too; only --fresh discards", async () => {
    await syncStoppedOnConflictThenAborted();

    const res = await runCli(["restack"]);
    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("Resuming the interrupted sync");
    await $`git -C ${tmpDir} rebase --abort`.quiet();

    const fresh = await runCli(["restack", "--fresh"]);
    expect(fresh.exitCode).toBe(0);
    expect(fresh.out).toContain("--fresh: discarding the interrupted sync");
    expect((await savedState())?.command).toBe("restack");
  });

  test("an abort keeps earlier branches' failed and held pushes; nothing is lost", async () => {
    // pr1's push is rejected (pr2 is held), then pr3's rebase conflicts.
    await createLinearStack(tmpDir);
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr3.txt", "from pr1\n", "pr1: conflicting pr3.txt");
    await setPreReceive(rejectRef("pr1"));
    expect((await runCli(["restack"])).exitCode).toBe(2);
    await $`git -C ${tmpDir} rebase --abort`.quiet();

    const again = await runCli(["restack", "--resume"]);
    expect(again.exitCode).toBe(2);
    const actions = (await savedState())!.log.map((e) => `${e.action} ${e.branch}`);
    expect(actions).toContain("push-failed pr1");
    expect(actions).toContain("push-held pr2");

    // Resolve it and let origin accept pushes again: everything lands.
    await setPreReceive(null);
    await Bun.write(`${tmpDir}/pr3.txt`, "resolved\n");
    await $`git -C ${tmpDir} add pr3.txt`.quiet();
    await $`git -C ${tmpDir} rebase --continue`.env({ ...process.env, GIT_EDITOR: "true" }).quiet();
    const done = await runCli(["restack", "--resume"]);
    expect(done.exitCode).toBe(0);
    for (const b of ["pr1", "pr2", "pr3"]) expect(await remoteSha(b)).toBe(await sha(b));
  });

  test("undo discards the run it rolled back, so nothing offers to resume it", async () => {
    await syncStoppedOnConflictThenContinued();

    const res = await runCli(["undo"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Discarded the interrupted sync's saved state");
    expect(await savedState()).toBeNull();
  });

  test("merge refuses while a run is pending", async () => {
    await syncStoppedOnConflictThenContinued();

    const res = await runCli(["merge"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Finish it before running merge");
    expect(res.out).toContain("gh-stack restack --resume");
  });
});

describe("a failed parent push holds its children back (#29)", () => {
  test("the base branch's push is rejected: pr2/pr3 are rebased but not pushed; --resume finishes", async () => {
    await stackNeedingRestack();
    const before = { pr2: await remoteSha("pr2"), pr3: await remoteSha("pr3") };
    await setPreReceive(rejectRef("pr1"));

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Push of pr1 failed");
    expect(res.out).toContain("Not pushing pr2: its parent pr1 isn't on origin");
    // Rebased locally, untouched on origin.
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await remoteSha("pr2")).toBe(before.pr2);
    expect(await remoteSha("pr3")).toBe(before.pr3);
    const state = await savedState();
    expect(state?.finished_at).toBeNull();
    expect(state?.log.map((e) => `${e.action} ${e.branch}`)).toEqual([
      "push-failed pr1",
      "rebased pr2",
      "push-held pr2",
      "rebased pr3",
      "push-held pr3",
    ]);

    await setPreReceive(null);
    const resumed = await runCli(["restack", "--resume"]);

    expect(resumed.exitCode).toBe(0);
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await sha(b));
    }
    expect((await savedState())?.finished_at).toBeTruthy();
  });

  test("a rebased child's push is rejected: its own child is held", async () => {
    await stackNeedingRestack();
    const pr3Before = await remoteSha("pr3");
    await setPreReceive(rejectRef("pr2"));

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(1);
    expect(await remoteSha("pr1")).toBe(await sha("pr1"));
    expect(res.out).toContain("Not pushing pr3: its parent pr2 isn't on origin");
    expect(await remoteSha("pr3")).toBe(pr3Before);
  });
});

describe("the action log survives until the pushes are done (#15)", () => {
  test("killed during the push phase: --resume finishes the pushes, then reports the finished run", async () => {
    await stackNeedingRestack();
    const pidFile = `${tmpDir}/.git/test-cli.pid`;
    // Pushing pr3 kills gh-stack mid-push (like the host wrapper's SIGTERM in
    // #15), after every rebase is done, and rejects the push.
    await setPreReceive(`#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/pr3" ]; then
    i=0
    while [ ! -s "${pidFile}" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
    kill -TERM "$(cat "${pidFile}")"
    exit 1
  fi
done
exit 0
`);

    const proc = spawnCli(["restack"], { GH_STACK_YES: "1" });
    await Bun.write(pidFile, String(proc.pid));
    const code = await proc.exited;
    expect(code).not.toBe(0);
    // Let the orphaned `git push` finish (the hook rejects it).
    for (let i = 0; i < 50 && (await savedState())?.log.length === 0; i++) await Bun.sleep(100);

    const state = await savedState();
    expect(state).not.toBeNull();
    expect(state!.finished_at).toBeNull();
    expect(state!.chain[state!.current_index]).toBe("pr3");
    expect(await remoteSha("pr3")).not.toBe(await sha("pr3"));

    await setPreReceive(null);
    const resumed = await runCli(["restack", "--resume"]);

    expect(resumed.exitCode).toBe(0);
    expect(resumed.out).not.toContain("No saved state");
    expect(resumed.out).toContain("Done before the interruption:");
    expect(resumed.out).toContain("✓ rebased pr3 onto pr2");
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await sha(b));
    }

    // Everything's done now: a second --resume reports it and succeeds.
    const again = await runCli(["restack", "--resume"]);
    expect(again.exitCode).toBe(0);
    expect(again.out).toContain("Nothing left to resume");
    expect(again.out).toContain("✓ pushed pr3");
  });

  test("--resume after a run that finished prints its log and exits 0", async () => {
    await stackNeedingRestack();
    expect((await runCli(["restack"])).exitCode).toBe(0);

    const res = await runCli(["restack", "--resume"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Nothing left to resume");
    expect(res.out).toContain("✓ rebased pr2 onto pr1");
    expect(res.out).toContain("✓ pushed pr2");
  });

  test("--resume with no saved state at all says so and how to recover", async () => {
    await createLinearStack(tmpDir);

    const res = await runCli(["restack", "--resume"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Nothing to resume: there's no saved run state");
    expect(res.out).toContain("gh-stack restack");
  });

  test("a resumed local-only run stays local-only (#47 regression guard)", async () => {
    await createLinearStack(tmpDir);
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr2.txt", "from pr1\n", "pr1: conflicting pr2.txt");
    expect((await runCli(["restack", "--no-push"])).exitCode).toBe(2);
    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await $`git -C ${tmpDir} add pr2.txt`.quiet();
    await $`git -C ${tmpDir} rebase --continue`.env({ ...process.env, GIT_EDITOR: "true" }).quiet();
    const pr2Remote = await remoteSha("pr2");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Resuming the interrupted restack");
    expect(await remoteSha("pr2")).toBe(pr2Remote);
  });
});

/** Write a saved run directly, for states that are hard to reach by interrupting a real run. */
async function writeState(state: Partial<RestackState>): Promise<void> {
  const full: RestackState = {
    version: RUN_STATE_VERSION,
    command: "restack",
    stack_name: "test-stack",
    chain: ["pr1", "pr2", "pr3"],
    push_only: ["pr1"],
    current_index: 1,
    rebase: null,
    declined: [],
    push: true,
    started_at: new Date().toISOString(),
    finished_at: null,
    log: [],
    ...state,
  };
  await Bun.write(
    `${tmpDir}/.git/.gh-stack/restack-state.json`,
    JSON.stringify(full, null, 2) + "\n",
  );
}

describe("review fixes (#49)", () => {
  test("--resume --dry-run writes nothing; the real resume still restacks pr2..pr3", async () => {
    await syncStoppedOnConflictThenContinued();
    const path = `${tmpDir}/.git/.gh-stack/restack-state.json`;
    const before = await Bun.file(path).text();

    const dry = await runCli(["restack", "--resume", "--dry-run"]);
    expect(dry.exitCode).toBe(0);
    expect(await Bun.file(path).text()).toBe(before);

    const res = await runCli(["restack", "--resume"]);
    expect(res.exitCode).toBe(0);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    for (const b of ["pr1", "pr2", "pr3"]) expect(await remoteSha(b)).toBe(await sha(b));
  });

  test("a stale remote-tracking ref can't wedge the run: in-sync is judged from origin itself", async () => {
    await stackNeedingRestack();
    expect((await runCli(["restack"])).exitCode).toBe(0);
    // origin/pr3 really is at local pr3, but the tracking ref lags (#23).
    await $`git -C ${tmpDir} update-ref refs/remotes/origin/pr3 ${await sha("pr3~1")}`.quiet();
    await checkout(tmpDir, "pr2");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Push of pr3 failed");
    expect((await savedState())?.finished_at).toBeTruthy();
  });

  test("a declined rebase isn't pushed on resume: it and its children are restacked first", async () => {
    await stackNeedingRestack(); // pr1 has a new commit
    await checkout(tmpDir, "pr2");
    await makeCommit(tmpDir, "pr2-local.txt", "local\n", "pr2: unpushed work");
    // The run rebased nothing above pr1: pr2's rebase was declined.
    await writeState({
      current_index: 3,
      declined: ["pr2"],
      log: [
        { at: new Date().toISOString(), branch: "pr2", action: "rebase-declined", onto: "pr1" },
      ],
    });

    const res = await runCli(["restack", "--resume"]);

    expect(res.exitCode).toBe(0);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    expect(await isAncestor(await sha("pr1"), await remoteSha("pr2"))).toBe(true);
    expect((await savedState())?.declined).toEqual([]);
  });

  test("a --push override on --resume is kept by a later plain --resume", async () => {
    // pr1 gains files that conflict with both pr2 and pr3, so the run stops twice.
    await createLinearStack(tmpDir);
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr1");
    await Bun.write(`${tmpDir}/pr2.txt`, "from pr1\n");
    await makeCommit(tmpDir, "pr3.txt", "from pr1\n", "pr1: conflicting pr2.txt and pr3.txt");
    await $`git -C ${tmpDir} add pr2.txt`.quiet();
    await $`git -C ${tmpDir} commit -q --amend --no-edit`.quiet();
    const resolve = async (file: string) => {
      await Bun.write(`${tmpDir}/${file}`, "resolved\n");
      await $`git -C ${tmpDir} add ${file}`.quiet();
      await $`git -C ${tmpDir} rebase --continue`
        .env({ ...process.env, GIT_EDITOR: "true" })
        .quiet();
    };

    expect((await runCli(["restack", "--no-push"])).exitCode).toBe(2);
    await resolve("pr2.txt");
    expect((await runCli(["restack", "--resume", "--push"])).exitCode).toBe(2);
    expect((await savedState())?.push).toBe(true);
    await resolve("pr3.txt");

    const res = await runCli(["restack", "--resume"]);

    expect(res.exitCode).toBe(0);
    expect(await remoteSha("pr3")).toBe(await sha("pr3"));
  });

  test("killed after saving the rebase but before git started it: --resume runs it", async () => {
    await stackNeedingRestack();
    await writeState({
      rebase: {
        branch: "pr2",
        onto: "pr1",
        onto_sha: await sha("pr1"),
        pre_tip: await sha("pr2"),
        boundary: await sha("pr1~1"),
      },
    });

    const res = await runCli(["restack", "--resume"]);

    expect(res.exitCode).toBe(0);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    for (const b of ["pr1", "pr2", "pr3"]) expect(await remoteSha(b)).toBe(await sha(b));
  });

  test("a state file from an older gh-stack is refused, not upgraded; --fresh discards it", async () => {
    await stackNeedingRestack();
    await Bun.write(
      `${tmpDir}/.git/.gh-stack/restack-state.json`,
      JSON.stringify({
        current_index: 1,
        stack_name: "test-stack",
        chain: ["pr1", "pr2"],
        push: true,
      }),
    );

    const res = await runCli(["restack"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("written by an older gh-stack");
    expect(res.out).toContain("gh-stack restack --fresh");

    const fresh = await runCli(["restack", "--fresh"]);
    expect(fresh.exitCode).toBe(0);
    expect((await savedState())?.version).toBe(RUN_STATE_VERSION);
  });
});
