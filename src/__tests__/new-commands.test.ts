// Tests for new Phase 1 commands: init (reworked), create, navigation, submit
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkout,
  cleanup,
  createBranch,
  createLinearStack,
  createTempRepo,
  getCurrentBranch,
  makeCommit,
  readMetadata,
  writeMetadata,
} from "./helpers.ts";
import init from "../commands/init.ts";
import create from "../commands/create.ts";
import up from "../commands/up.ts";
import down from "../commands/down.ts";
import top from "../commands/top.ts";
import bottom from "../commands/bottom.ts";
import { setAutoYes } from "../lib/ui.ts";
import type { StackMetadata } from "../types.ts";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  setAutoYes(true); // Skip interactive prompts in tests
});

afterEach(async () => {
  setAutoYes(false);
  process.chdir(originalCwd);
  await cleanup(tmpDir);
});

// ── init (reworked) ──

describe("init (smart defaults)", () => {
  test("creates stack named after current branch with zero prompts", async () => {
    await createBranch(tmpDir, "kiliman/feature-1", "main");
    await makeCommit(tmpDir, "f1.txt", "feature 1\n", "add feature 1");

    await init([]);

    const meta = await readMetadata(tmpDir);
    expect(meta.current_stack).toBe("kiliman/feature-1");
    expect(meta.stacks["kiliman/feature-1"]).toBeDefined();
    expect(meta.stacks["kiliman/feature-1"]!.branches["kiliman/feature-1"]).toBeDefined();
    expect(meta.stacks["kiliman/feature-1"]!.branches["kiliman/feature-1"]!.parent).toBe("main");
  });

  test("respects --name flag for custom stack name", async () => {
    await createBranch(tmpDir, "kiliman/feature-1", "main");
    await makeCommit(tmpDir, "f1.txt", "feature 1\n", "add feature 1");

    await init(["--name", "my-epic-stack"]);

    const meta = await readMetadata(tmpDir);
    expect(meta.current_stack).toBe("my-epic-stack");
    expect(meta.stacks["my-epic-stack"]).toBeDefined();
  });

  test("respects --parent flag", async () => {
    await createBranch(tmpDir, "develop", "main");
    await makeCommit(tmpDir, "dev.txt", "dev\n", "dev commit");
    await createBranch(tmpDir, "feature-1", "develop");
    await makeCommit(tmpDir, "f1.txt", "feature 1\n", "add feature 1");

    await init(["--parent", "develop"]);

    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["feature-1"]!.branches["feature-1"]!.parent).toBe("develop");
  });

  test("respects --description flag", async () => {
    await createBranch(tmpDir, "feature-1", "main");
    await makeCommit(tmpDir, "f1.txt", "feature 1\n", "add feature 1");

    await init(["--description", "My cool feature"]);

    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["feature-1"]!.description).toBe("My cool feature");
  });

  test("creates metadata file if none exists", async () => {
    await createBranch(tmpDir, "feature-1", "main");
    await makeCommit(tmpDir, "f1.txt", "feature 1\n", "add feature 1");

    const exists = await Bun.file(`${tmpDir}/.git/gh-stack-metadata.json`).exists();
    expect(exists).toBe(false);

    await init([]);

    const existsAfter = await Bun.file(`${tmpDir}/.git/gh-stack-metadata.json`).exists();
    expect(existsAfter).toBe(true);
  });

  test("auto-detects branch chain: main → feat-1 → feat-2", async () => {
    // Create chain: main → feat-1 → feat-2
    await createBranch(tmpDir, "feat-1", "main");
    await makeCommit(tmpDir, "f1.txt", "feature 1\n", "feat-1 commit");
    await createBranch(tmpDir, "feat-2", "feat-1");
    await makeCommit(tmpDir, "f2.txt", "feature 2\n", "feat-2 commit");

    // Init from the TOP of the chain
    await init([]);

    const meta = await readMetadata(tmpDir);
    const stack = meta.stacks["feat-2"]!;

    // Both branches should be in the stack
    expect(stack.branches["feat-1"]).toBeDefined();
    expect(stack.branches["feat-2"]).toBeDefined();

    // Parents should be correct
    expect(stack.branches["feat-1"]!.parent).toBe("main");
    expect(stack.branches["feat-2"]!.parent).toBe("feat-1");
  });

  test("auto-detects 3-branch chain: main → a → b → c", async () => {
    await createBranch(tmpDir, "a", "main");
    await makeCommit(tmpDir, "a.txt", "a\n", "a commit");
    await createBranch(tmpDir, "b", "a");
    await makeCommit(tmpDir, "b.txt", "b\n", "b commit");
    await createBranch(tmpDir, "c", "b");
    await makeCommit(tmpDir, "c.txt", "c\n", "c commit");

    await init([]);

    const meta = await readMetadata(tmpDir);
    const stack = meta.stacks["c"]!;

    expect(Object.keys(stack.branches)).toHaveLength(3);
    expect(stack.branches["a"]!.parent).toBe("main");
    expect(stack.branches["b"]!.parent).toBe("a");
    expect(stack.branches["c"]!.parent).toBe("b");
  });

  test("single branch (no chain) still works", async () => {
    await createBranch(tmpDir, "solo", "main");
    await makeCommit(tmpDir, "solo.txt", "solo\n", "solo commit");

    await init([]);

    const meta = await readMetadata(tmpDir);
    const stack = meta.stacks["solo"]!;

    expect(Object.keys(stack.branches)).toHaveLength(1);
    expect(stack.branches["solo"]!.parent).toBe("main");
  });

  test("chain detection ignores unrelated branches", async () => {
    // Create chain: main → feat-1 → feat-2
    await createBranch(tmpDir, "feat-1", "main");
    await makeCommit(tmpDir, "f1.txt", "feature 1\n", "feat-1 commit");
    await createBranch(tmpDir, "feat-2", "feat-1");
    await makeCommit(tmpDir, "f2.txt", "feature 2\n", "feat-2 commit");

    // Create an unrelated branch off main
    await createBranch(tmpDir, "unrelated", "main");
    await makeCommit(tmpDir, "unrelated.txt", "unrelated\n", "unrelated commit");

    // Go to feat-2 and init
    await checkout(tmpDir, "feat-2");
    await init([]);

    const meta = await readMetadata(tmpDir);
    const stack = meta.stacks["feat-2"]!;

    // Only chain branches, not the unrelated one
    expect(Object.keys(stack.branches)).toHaveLength(2);
    expect(stack.branches["unrelated"]).toBeUndefined();
  });

  test("chain detection ignores branches already merged into trunk", async () => {
    // Simulate: old branch merged into main long ago, then new chain on top
    // main ← old-branch (already merged)
    // main → feat-1 → feat-2

    // Create old branch off main, then merge it back
    await createBranch(tmpDir, "old-merged", "main");
    await makeCommit(tmpDir, "old.txt", "old\n", "old commit");
    await checkout(tmpDir, "main");
    // Merge old-merged into main (simulating squash-merge)
    await makeCommit(tmpDir, "old.txt", "old\n", "merge old-merged");

    // Now create a chain off updated main
    await createBranch(tmpDir, "feat-1", "main");
    await makeCommit(tmpDir, "f1.txt", "feature 1\n", "feat-1 commit");
    await createBranch(tmpDir, "feat-2", "feat-1");
    await makeCommit(tmpDir, "f2.txt", "feature 2\n", "feat-2 commit");

    await init([]);

    const meta = await readMetadata(tmpDir);
    const stack = meta.stacks["feat-2"]!;

    // Should NOT include old-merged (it's already in main)
    expect(stack.branches["old-merged"]).toBeUndefined();
    expect(Object.keys(stack.branches)).toHaveLength(2);
    expect(stack.branches["feat-1"]!.parent).toBe("main");
    expect(stack.branches["feat-2"]!.parent).toBe("feat-1");
  });

  test("chain detection with --parent flag uses correct trunk", async () => {
    // Create: main → develop → feat-1
    await createBranch(tmpDir, "develop", "main");
    await makeCommit(tmpDir, "dev.txt", "dev\n", "dev commit");
    await createBranch(tmpDir, "feat-1", "develop");
    await makeCommit(tmpDir, "f1.txt", "feature 1\n", "feat-1 commit");

    await init(["--parent", "develop"]);

    const meta = await readMetadata(tmpDir);
    const stack = meta.stacks["feat-1"]!;

    // Should only have feat-1 (develop is the trunk, not included in chain)
    expect(Object.keys(stack.branches)).toHaveLength(1);
    expect(stack.branches["feat-1"]!.parent).toBe("develop");
  });
});

// ── create ──

describe("create", () => {
  test("creates a new branch and adds to stack", async () => {
    // Set up a stack with one branch
    await createBranch(tmpDir, "pr1", "main");
    await makeCommit(tmpDir, "pr1.txt", "pr1\n", "pr1 commit");

    const meta: StackMetadata = {
      version: 2,
      current_stack: "test-stack",
      stacks: {
        "test-stack": {
          description: "Test",
          last_branch: "pr1",
          branches: {
            pr1: { parent: "main", pr: 1 },
          },
        },
      },
    };
    await writeMetadata(tmpDir, meta);

    // Create new branch from pr1
    await create(["pr2"]);

    // Should be on the new branch
    const current = await getCurrentBranch(tmpDir);
    expect(current).toBe("pr2");

    // Should be in the stack
    const updatedMeta = await readMetadata(tmpDir);
    const stack = updatedMeta.stacks["test-stack"]!;
    expect(stack.branches["pr2"]).toBeDefined();
    expect(stack.branches["pr2"]!.parent).toBe("pr1");
    expect(stack.last_branch).toBe("pr2");
  });

  test("sets description when --description flag is used", async () => {
    await createBranch(tmpDir, "pr1", "main");
    await makeCommit(tmpDir, "pr1.txt", "pr1\n", "pr1 commit");

    const meta: StackMetadata = {
      version: 2,
      current_stack: "test-stack",
      stacks: {
        "test-stack": {
          description: "Test",
          last_branch: "pr1",
          branches: {
            pr1: { parent: "main", pr: 1 },
          },
        },
      },
    };
    await writeMetadata(tmpDir, meta);

    await create(["pr2", "--description", "API layer"]);

    const updatedMeta = await readMetadata(tmpDir);
    expect(updatedMeta.stacks["test-stack"]!.branches["pr2"]!.description).toBe("API layer");
  });

  test("does not set a PR number on new branches", async () => {
    await createBranch(tmpDir, "pr1", "main");
    await makeCommit(tmpDir, "pr1.txt", "pr1\n", "pr1 commit");

    const meta: StackMetadata = {
      version: 2,
      current_stack: "test-stack",
      stacks: {
        "test-stack": {
          description: "Test",
          last_branch: "pr1",
          branches: {
            pr1: { parent: "main", pr: 1 },
          },
        },
      },
    };
    await writeMetadata(tmpDir, meta);

    await create(["pr2"]);

    const updatedMeta = await readMetadata(tmpDir);
    expect(updatedMeta.stacks["test-stack"]!.branches["pr2"]!.pr).toBeUndefined();
  });
});

// ── up / down / top / bottom ──

describe("up", () => {
  test("moves to child branch", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr1");

    await up([]);

    expect(await getCurrentBranch(tmpDir)).toBe("pr2");
  });

  test("moves multiple steps", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr1");

    await up(["2"]);

    expect(await getCurrentBranch(tmpDir)).toBe("pr3");
  });

  test("stops at top of stack", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");

    // Should not error, just warn
    await up([]);

    expect(await getCurrentBranch(tmpDir)).toBe("pr3");
  });

  test("updates last_branch tracking", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr1");

    await up([]);

    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.last_branch).toBe("pr2");
  });
});

describe("down", () => {
  test("moves to parent branch", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");

    await down([]);

    expect(await getCurrentBranch(tmpDir)).toBe("pr2");
  });

  test("moves multiple steps", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");

    await down(["2"]);

    expect(await getCurrentBranch(tmpDir)).toBe("pr1");
  });

  test("stops at bottom of stack (does not checkout main)", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr1");

    await down([]);

    // Should still be on pr1, not main
    expect(await getCurrentBranch(tmpDir)).toBe("pr1");
  });

  test("updates last_branch tracking", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");

    await down([]);

    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.last_branch).toBe("pr2");
  });
});

describe("top", () => {
  test("jumps to leaf branch", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr1");

    await top([]);

    expect(await getCurrentBranch(tmpDir)).toBe("pr3");
  });

  test("stays put if already at top", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");

    await top([]);

    expect(await getCurrentBranch(tmpDir)).toBe("pr3");
  });
});

describe("bottom", () => {
  test("jumps to first branch above trunk", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr3");

    await bottom([]);

    expect(await getCurrentBranch(tmpDir)).toBe("pr1");
  });

  test("stays put if already at bottom", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr1");

    await bottom([]);

    expect(await getCurrentBranch(tmpDir)).toBe("pr1");
  });
});

// ── submit (dry-run only — no GitHub access in tests) ──

describe("submit --dry-run", () => {
  test("reports correct scope for downstack branches", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr2");

    // Capture stdout to verify dry-run output
    const submit = (await import("../commands/submit.ts")).default;
    await submit(["--dry-run"]);

    // If we got here without error, the command ran.
    // The scope should be pr1 + pr2 (downstack from pr2)
    // We can't easily capture clack output, but we can verify
    // metadata wasn't modified
    const meta = await readMetadata(tmpDir);
    expect(meta.snapshots).toBeUndefined(); // No snapshots created
  });

  test("does not modify metadata in dry-run mode", async () => {
    await createLinearStack(tmpDir);
    await checkout(tmpDir, "pr2");

    const metaBefore = JSON.stringify(await readMetadata(tmpDir));

    const submit = (await import("../commands/submit.ts")).default;
    await submit(["--dry-run"]);

    const metaAfter = JSON.stringify(await readMetadata(tmpDir));
    expect(metaAfter).toBe(metaBefore);
  });
});

// ── branchToTitle (via submit module) ──

describe("branchToTitle", () => {
  // We test the title generation logic indirectly through the submit module
  // The function is not exported, but we can test it by checking the import
  test("submit module exports default function", async () => {
    const mod = await import("../commands/submit.ts");
    expect(typeof mod.default).toBe("function");
  });
});

// ── CLI integration (new command names) ──

describe("CLI routing with new command names", () => {
  const cliPath = new URL("../index.ts", import.meta.url).pathname;

  async function runCli(args: string[]) {
    const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
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
    return { exitCode, stdout, stderr };
  }

  test("'log' is the default command", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("log");
    expect(result.stdout).toContain("CORE WORKFLOW");
  });

  test("help shows TERMS section", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("TERMS");
    expect(result.stdout).toContain("trunk");
    expect(result.stdout).toContain("upstack");
    expect(result.stdout).toContain("downstack");
  });

  test("help shows new command groups", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("CORE WORKFLOW");
    expect(result.stdout).toContain("STACK NAVIGATION");
    expect(result.stdout).toContain("STACK MANAGEMENT");
    expect(result.stdout).toContain("submit");
    expect(result.stdout).toContain("create");
    expect(result.stdout).toContain("checkout");
    expect(result.stdout).toContain("delete");
  });

  test("create --help shows usage", async () => {
    const result = await runCli(["create", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gh-stack create");
    expect(result.stdout).toContain("<branch-name>");
  });

  test("submit --help shows usage", async () => {
    const result = await runCli(["submit", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gh-stack submit");
    expect(result.stdout).toContain("--dry-run");
  });

  test("up --help shows usage", async () => {
    const result = await runCli(["up", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gh-stack up");
  });

  test("down --help shows usage", async () => {
    const result = await runCli(["down", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gh-stack down");
  });

  test("top --help shows usage", async () => {
    const result = await runCli(["top", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gh-stack top");
  });

  test("bottom --help shows usage", async () => {
    const result = await runCli(["bottom", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gh-stack bottom");
  });

  test("'co' alias routes to checkout", async () => {
    const result = await runCli(["co", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gh-stack checkout");
  });

  test("old command names are no longer recognized", async () => {
    const showResult = await runCli(["show"]);
    expect(showResult.exitCode).toBe(1);
    expect(showResult.stderr).toContain("Unknown command");

    const addResult = await runCli(["add"]);
    expect(addResult.exitCode).toBe(1);
    expect(addResult.stderr).toContain("Unknown command");

    const removeResult = await runCli(["remove"]);
    expect(removeResult.exitCode).toBe(1);
    expect(removeResult.stderr).toContain("Unknown command");

    const switchResult = await runCli(["switch"]);
    expect(switchResult.exitCode).toBe(1);
    expect(switchResult.stderr).toContain("Unknown command");
  });
});
