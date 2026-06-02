// Tests for the v3 metadata layer: per-stack files, git-native branch config,
// lifecycle-as-file-move (tombstones), and doctor migration/detection.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import type { StackMetadata } from "../types.ts";
import { createTempRepo, createLinearStack, cleanup } from "./helpers.ts";
import { readMetadata, writeMetadata, v3Exists, initMetadata } from "../lib/metadata.ts";
import {
  setBranchMembership,
  getBranchMembership,
  allBranchMemberships,
  clearBranchMembership,
} from "../lib/branch-config.ts";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanup(tmpDir);
});

// ── Branch config (git-native membership) ──

describe("branch config", () => {
  test("round-trips membership with dash-keyed, lowercase config", async () => {
    await $`git checkout -b feature-x`.quiet();
    await setBranchMembership("feature-x", { stack: "mystack", parent: "main", pr: 42 });

    const m = await getBranchMembership("feature-x");
    expect(m.stack).toBe("mystack");
    expect(m.parent).toBe("main");
    expect(m.pr).toBe(42);

    // Stored under dash-separated, lowercase keys.
    const raw = (await $`git config --get branch.feature-x.ghstack-stack`.text()).trim();
    expect(raw).toBe("mystack");
  });

  test("undefined fields are cleared, not written", async () => {
    await $`git checkout -b feature-y`.quiet();
    await setBranchMembership("feature-y", { stack: "s", parent: "main", pr: 7 });
    await setBranchMembership("feature-y", { stack: "s", parent: "main" }); // no pr

    const m = await getBranchMembership("feature-y");
    expect(m.pr).toBeUndefined();
    expect(m.stack).toBe("s");
  });

  test("clearBranchMembership removes all gh-stack keys", async () => {
    await $`git checkout -b feature-z`.quiet();
    await setBranchMembership("feature-z", { stack: "s", parent: "main", pr: 1 });
    await clearBranchMembership("feature-z");

    expect(await getBranchMembership("feature-z")).toEqual({});
  });

  test("git branch -D removes membership automatically", async () => {
    await $`git checkout -b doomed`.quiet();
    await setBranchMembership("doomed", { stack: "s", parent: "main" });
    await $`git checkout main`.quiet();
    await $`git branch -D doomed`.quiet();

    const all = await allBranchMemberships();
    expect(all.has("doomed")).toBe(false);
  });
});

// ── v3 storage round-trip + sync ──

describe("v3 storage", () => {
  test("writeMetadata fans out to per-stack files + branch config; readMetadata reassembles", async () => {
    await createLinearStack(tmpDir); // writes v3 directly via helper

    const meta = await readMetadata();
    expect(meta).not.toBeNull();
    expect(meta!.version).toBe(3);
    expect(meta!.current_stack).toBe("test-stack");
    expect(Object.keys(meta!.stacks["test-stack"]!.branches)).toEqual(["pr1", "pr2", "pr3"]);

    // A real write (via the lib) should backfill branch config.
    await writeMetadata(meta!);
    const all = await allBranchMemberships();
    expect(all.get("pr2")?.stack).toBe("test-stack");
    expect(all.get("pr2")?.parent).toBe("pr1");
    expect(all.get("pr3")?.pr).toBe(3);
  });

  test("each stack is its own file (no monolith)", async () => {
    await createLinearStack(tmpDir);
    const files = await fs.readdir(`${tmpDir}/.git/.gh-stack/active`);
    expect(files).toContain("test-stack.json");
    // Old monolith must not exist.
    expect(await Bun.file(`${tmpDir}/.git/gh-stack-metadata.json`).exists()).toBe(false);
  });
});

// ── Lifecycle as file move — a stack can't vanish ──

describe("lifecycle (tombstones)", () => {
  test("archiving moves a stack file to archived/, never deletes it", async () => {
    const { meta } = await createLinearStack(tmpDir);

    // Simulate a merge archiving the stack.
    meta.version = 3;
    meta.archive = { "test-stack": meta.stacks["test-stack"]! };
    delete meta.stacks["test-stack"];
    meta.current_stack = null;
    await writeMetadata(meta);

    expect(await Bun.file(`${tmpDir}/.git/.gh-stack/active/test-stack.json`).exists()).toBe(false);
    expect(await Bun.file(`${tmpDir}/.git/.gh-stack/archived/test-stack.json`).exists()).toBe(true);

    const reread = await readMetadata();
    expect(reread!.archive?.["test-stack"]).toBeDefined();
    expect(reread!.stacks["test-stack"]).toBeUndefined();
  });

  test("a stack dropped from both active and archive is tombstoned, not lost", async () => {
    const { meta } = await createLinearStack(tmpDir);
    delete meta.stacks["test-stack"];
    meta.current_stack = null;
    await writeMetadata(meta);

    expect(await Bun.file(`${tmpDir}/.git/.gh-stack/active/test-stack.json`).exists()).toBe(false);
    expect(await Bun.file(`${tmpDir}/.git/.gh-stack/deleted/test-stack.json`).exists()).toBe(true);
  });
});

// ── doctor migration + detection ──

describe("doctor", () => {
  test("migrates a v2 monolith (with archive) and backfills branch config", async () => {
    await $`git checkout -b feat-1`.quiet();
    await Bun.write(`${tmpDir}/f1.txt`, "1\n");
    await $`git add .`.quiet();
    await $`git commit -qm f1`.quiet();
    await $`git checkout main`.quiet();

    const v2: StackMetadata = {
      version: 2,
      current_stack: "live",
      stacks: {
        live: {
          description: "live one",
          last_branch: "feat-1",
          base: "main",
          branches: { "feat-1": { parent: "main", pr: 5 } },
        },
      },
      archive: {
        old: {
          description: "done",
          last_branch: "gone",
          base: "main",
          branches: { gone: { parent: "main", pr: 1 } },
        },
      },
    };
    await Bun.write(`${tmpDir}/.git/gh-stack-metadata.json`, JSON.stringify(v2, null, 2));

    const { default: doctor } = await import("../commands/doctor.ts");
    await doctor([]);

    expect(await v3Exists()).toBe(true);
    const meta = await readMetadata();
    expect(meta!.stacks["live"]).toBeDefined();
    expect(meta!.archive?.["old"]).toBeDefined();

    // Branch config backfilled for the live branch that exists.
    const all = await allBranchMemberships();
    expect(all.get("feat-1")?.stack).toBe("live");
    expect(all.get("feat-1")?.pr).toBe(5);

    // Legacy file retired to .bak.
    expect(await Bun.file(`${tmpDir}/.git/gh-stack-metadata.json`).exists()).toBe(false);
    expect(await Bun.file(`${tmpDir}/.git/gh-stack-metadata.json.bak`).exists()).toBe(true);
  });

  test("is idempotent and reports healthy on a clean v3 store", async () => {
    await initMetadata();
    const { default: doctor } = await import("../commands/doctor.ts");
    await doctor([]); // should not throw / exit
    expect(await v3Exists()).toBe(true);
  });
});
