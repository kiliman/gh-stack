// submit --json (#6): the pure result builder, plus the real CLI end to end
// against a stub `gh` on PATH, so stdout can be checked to hold only the JSON.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  buildSubmitJson,
  submitAction,
  type BranchOutcome,
  type SubmitJson,
} from "../commands/submit.ts";
import type { Stack } from "../types.ts";
import {
  checkout,
  cleanup,
  createBranch,
  createTempRepo,
  makeCommit,
  setupRemote,
} from "./helpers.ts";

function outcome(overrides: Partial<BranchOutcome> = {}): BranchOutcome {
  return {
    branch: "feat-a",
    parent: "main",
    pr: 7,
    url: null,
    pushed: false,
    created: false,
    baseChanged: false,
    draft: null,
    error: null,
    ...overrides,
  };
}

describe("submitAction", () => {
  const none = new Set<string>();

  test("an existing PR nothing touched is unchanged", () => {
    expect(submitAction(outcome(), none)).toBe("unchanged");
  });

  test("an existing PR is updated by a push, a base change, or a title/body edit", () => {
    expect(submitAction(outcome({ pushed: true }), none)).toBe("updated");
    expect(submitAction(outcome({ baseChanged: true }), none)).toBe("updated");
    expect(submitAction(outcome(), new Set(["feat-a"]))).toBe("updated");
  });

  test("a PR created this run is created, even though it was also pushed and edited", () => {
    const o = outcome({ created: true, pushed: true });
    expect(submitAction(o, new Set(["feat-a"]))).toBe("created");
  });

  test("an error wins over everything else", () => {
    const o = outcome({ created: true, pushed: true, error: "boom" });
    expect(submitAction(o, none)).toBe("failed");
  });
});

describe("buildSubmitJson", () => {
  const stack: Stack = {
    description: "",
    last_branch: "feat-b",
    branches: {
      "feat-a": { parent: "main", pr: 7, prTitle: "Feat A (1/2)" },
      "feat-b": { parent: "feat-a", pr: 8, prTitle: "Feat B (2/2)" },
    },
  };

  test("maps outcomes to the documented shape, in scope order", () => {
    const result = buildSubmitJson({
      stackName: "my-stack",
      currentBranch: "feat-b",
      stack,
      outcomes: [
        outcome(),
        outcome({
          branch: "feat-b",
          parent: "feat-a",
          pr: 8,
          url: "https://github.com/acme/widgets/pull/8",
          pushed: true,
          created: true,
          draft: true,
        }),
      ],
      edited: new Set(),
      nwo: "acme/widgets",
    });

    expect(result).toEqual({
      stack: "my-stack",
      current_branch: "feat-b",
      branches: [
        {
          branch: "feat-a",
          parent: "main",
          pr: 7,
          url: "https://github.com/acme/widgets/pull/7",
          title: "Feat A (1/2)",
          action: "unchanged",
          pushed: false,
          draft: null,
        },
        {
          branch: "feat-b",
          parent: "feat-a",
          pr: 8,
          url: "https://github.com/acme/widgets/pull/8",
          title: "Feat B (2/2)",
          action: "created",
          pushed: true,
          draft: true,
        },
      ],
    });
  });

  test("url is null without a PR or a known repo; error appears only on failure", () => {
    const result = buildSubmitJson({
      stackName: "s",
      currentBranch: "feat-a",
      stack,
      outcomes: [
        outcome({ pr: 7 }),
        outcome({ branch: "feat-c", pr: null, error: "gh pr create failed" }),
      ],
      edited: new Set(),
      nwo: null,
    });

    expect(result.branches[0]!.url).toBeNull();
    expect("error" in result.branches[0]!).toBe(false);
    expect(result.branches[1]).toMatchObject({
      pr: null,
      url: null,
      title: null,
      action: "failed",
      error: "gh pr create failed",
    });
  });
});

// ── End to end: real CLI, stub gh ──

const cliPath = new URL("../index.ts", import.meta.url).pathname;

// Answers the gh calls submit makes. `pr list` finds no PRs, `pr create` hands
// out PR numbers from 101 up (or fails when GH_FAIL_CREATE is set), description
// edits fail when GH_FAIL_BODY_EDIT is set, and every call is appended to $GH_LOG.
const GH_STUB = `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "repo view") echo "acme/widgets" ;;
  "pr create")
    if [ -n "$GH_FAIL_CREATE" ]; then echo "GraphQL: something broke" >&2; exit 1; fi
    n=$(cat "$GH_STATE" 2>/dev/null || echo 100)
    n=$((n + 1))
    echo "$n" > "$GH_STATE"
    echo "https://github.com/acme/widgets/pull/$n"
    ;;
  "pr edit")
    case "$*" in *--body-file*) [ -n "$GH_FAIL_BODY_EDIT" ] && exit 1 ;; esac
    ;;
esac
exit 0
`;

let tmpDir: string;
let remoteDir: string;
let stubDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = await setupRemote(tmpDir);
  stubDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-ghstub-"));
  await Bun.write(`${stubDir}/gh`, GH_STUB);
  await fs.chmod(`${stubDir}/gh`, 0o755);

  // A bare two-branch chain: main → feat-a → feat-b (submit self-heals it).
  await createBranch(tmpDir, "feat-a", "main");
  await makeCommit(tmpDir, "a.txt", "a\n", "feat-a: add a");
  await createBranch(tmpDir, "feat-b", "feat-a");
  await makeCommit(tmpDir, "b.txt", "b\n", "feat-b: add b");
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, stubDir);
});

async function runSubmit(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", cliPath, "submit", ...args], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      GH_LOG: `${stubDir}/calls.log`,
      GH_STATE: `${stubDir}/next-pr`,
      GH_STACK_NO_COLOR: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("submit --json (CLI)", () => {
  test("stdout is only the JSON document; logs go to stderr", async () => {
    const { stdout, stderr, exitCode } = await runSubmit(["--json", "-t", "Add things"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as SubmitJson;
    expect(result.current_branch).toBe("feat-b");
    expect(result.branches.map((b) => [b.branch, b.pr, b.url, b.action, b.pushed])).toEqual([
      ["feat-a", 101, "https://github.com/acme/widgets/pull/101", "created", true],
      ["feat-b", 102, "https://github.com/acme/widgets/pull/102", "created", true],
    ]);
    expect(result.branches.map((b) => b.draft)).toEqual([false, false]);
    expect(stderr).toContain("Done!");
  }, 30_000);

  test("a re-submit reports unchanged, and a new commit reports updated", async () => {
    expect((await runSubmit(["--json", "-t", "Add things"])).exitCode).toBe(0);

    const again = JSON.parse((await runSubmit(["--json"])).stdout) as SubmitJson;
    expect(again.branches.map((b) => b.action)).toEqual(["unchanged", "unchanged"]);

    await checkout(tmpDir, "feat-b");
    await makeCommit(tmpDir, "b2.txt", "b2\n", "feat-b: more");
    const third = JSON.parse((await runSubmit(["--json"])).stdout) as SubmitJson;
    expect(third.branches.map((b) => [b.branch, b.action, b.pushed])).toEqual([
      ["feat-a", "unchanged", false],
      ["feat-b", "updated", true],
    ]);
  }, 60_000);

  test("retitling an existing PR without pushing reports it updated", async () => {
    expect((await runSubmit(["--json", "-t", "Add things"])).exitCode).toBe(0);

    // feat-a is updated too: its stack section lists feat-b's title, so its
    // description is rewritten.
    const result = JSON.parse((await runSubmit(["--json", "-t", "Renamed"])).stdout) as SubmitJson;
    expect(result.branches.map((b) => [b.branch, b.action, b.pushed, b.title])).toEqual([
      ["feat-a", "updated", false, "Add things (1/2)"],
      ["feat-b", "updated", false, "Renamed (2/2)"],
    ]);
  }, 60_000);

  test("a title edit alone counts as updated (description edit failed)", async () => {
    expect((await runSubmit(["--json", "-t", "Add things"])).exitCode).toBe(0);

    const { stdout } = await runSubmit(["--json", "-t", "Renamed"], { GH_FAIL_BODY_EDIT: "1" });
    const result = JSON.parse(stdout) as SubmitJson;
    expect(result.branches.map((b) => [b.branch, b.action])).toEqual([
      ["feat-a", "unchanged"],
      ["feat-b", "updated"],
    ]);
  }, 60_000);

  test("a failed PR creation is reported per branch and exits 1", async () => {
    const { stdout, exitCode } = await runSubmit(["--json", "-t", "Add things"], {
      GH_FAIL_CREATE: "1",
    });

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout) as SubmitJson;
    expect(result.branches.map((b) => b.action)).toEqual(["failed", "failed"]);
    expect(result.branches[0]!.error).toContain("something broke");
  }, 30_000);

  test("a push failure still prints the branches handled so far, then exits 1", async () => {
    await Bun.$`git -C ${tmpDir} remote set-url origin ${tmpDir}/no-such-remote`.quiet();

    const { stdout, exitCode } = await runSubmit(["--json", "-t", "Add things"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout) as SubmitJson;
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0]).toMatchObject({
      branch: "feat-a",
      action: "failed",
      pushed: false,
      error: "push to origin/feat-a failed",
    });
  }, 30_000);

  test("--json with --dry-run is refused before doing anything", async () => {
    const { stdout, stderr, exitCode } = await runSubmit(["--json", "--dry-run"]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("--dry-run");
    expect(await Bun.file(`${stubDir}/calls.log`).exists()).toBe(false);
  }, 30_000);
});
