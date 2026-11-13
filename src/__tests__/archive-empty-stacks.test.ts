// #68: a stack whose branches are all removed with `delete --keep-branch` stayed
// in `stacks` as an empty shell, and nothing could put it away. `delete` now
// archives a stack it empties, `archive <name>` archives a stack by hand, and
// `doctor` archives empty stacks it finds.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanup,
  createBranch,
  createGhStub,
  createTempRepo,
  ghStubEnv,
  makeCommit,
  readMetadata,
  writeMetadata,
} from "./helpers.ts";
import type { Stack, StackMetadata } from "../types.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let stubDir: string;

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...process.env,
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

/** main → parent → child, tracked as stack "deps", PRs #1 and #2. */
const DEPS: Stack = {
  description: "",
  last_branch: "child",
  base: "main",
  branches: {
    parent: { parent: "main", pr: 1 },
    child: { parent: "parent", pr: 2 },
  },
};

const EMPTY: Stack = { description: "", last_branch: null, base: "main", branches: {} };

beforeEach(async () => {
  tmpDir = await createTempRepo();
  stubDir = await createGhStub();
  await createBranch(tmpDir, "parent", "main");
  await makeCommit(tmpDir, "parent.txt", "parent\n", "parent: commit");
  await createBranch(tmpDir, "child", "parent");
  await makeCommit(tmpDir, "child.txt", "child\n", "child: commit");
});

afterEach(async () => {
  await cleanup(tmpDir, stubDir);
});

async function seed(meta: Partial<StackMetadata>): Promise<void> {
  await writeMetadata(tmpDir, { version: 2, current_stack: null, stacks: {}, ...meta });
}

describe("delete archives a stack it empties", () => {
  test("removing the last branch moves the stack to the archive", async () => {
    await seed({ current_stack: "deps", stacks: { deps: structuredClone(DEPS) } });

    expect((await runCli(["delete", "child", "--keep-branch"])).exitCode).toBe(0);
    expect((await readMetadata(tmpDir)).stacks["deps"]).toBeDefined();

    const res = await runCli(["delete", "parent", "--keep-branch"]);
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("is empty now, so it was archived");

    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["deps"]).toBeUndefined();
    expect(meta.archive?.["deps"]?.branches).toEqual({});
  });
});

describe("archive <name>", () => {
  test("archives an active stack, keeping its PRs, and --restore brings it back", async () => {
    await seed({ current_stack: "deps", stacks: { deps: structuredClone(DEPS) } });

    const res = await runCli(["archive", "deps"]);
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Archived deps");

    let meta = await readMetadata(tmpDir);
    expect(meta.stacks["deps"]).toBeUndefined();
    expect(meta.archive?.["deps"]?.branches["child"]?.pr).toBe(2);

    expect((await runCli(["archive", "--restore", "deps"])).exitCode).toBe(0);
    meta = await readMetadata(tmpDir);
    expect(meta.stacks["deps"]?.branches["child"]?.pr).toBe(2);
    expect(meta.archive?.["deps"]).toBeUndefined();
  });

  test("archives several at once, suffixing a name the archive already has", async () => {
    await seed({
      stacks: { "deps/a": structuredClone(EMPTY), "deps/b": structuredClone(EMPTY) },
      archive: { "deps/a": structuredClone(DEPS) },
    });

    const res = await runCli(["archive", "deps/a", "deps/b"]);
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("as deps/a-2");

    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks)).toEqual([]);
    // The older archived deps/a is untouched.
    expect(meta.archive?.["deps/a"]?.branches["child"]?.pr).toBe(2);
    expect(Object.keys(meta.archive ?? {}).toSorted()).toEqual(["deps/a", "deps/a-2", "deps/b"]);
  });

  test("refuses an unknown name and changes nothing", async () => {
    await seed({ stacks: { deps: structuredClone(DEPS) } });

    const res = await runCli(["archive", "deps", "nope"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("No active stack named nope");
    expect((await readMetadata(tmpDir)).stacks["deps"]).toBeDefined();
  });

  test("--restore refuses when a branch is tracked in an active stack", async () => {
    await seed({
      stacks: { live: structuredClone(DEPS) },
      archive: { old: structuredClone(DEPS) },
    });

    const res = await runCli(["archive", "--restore", "old"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("tracked in another stack now");
    const meta = await readMetadata(tmpDir);
    expect(meta.archive?.["old"]).toBeDefined();
  });
});

describe("doctor archives empty stacks", () => {
  test("empty shells move to the archive, real stacks stay", async () => {
    await seed({
      stacks: {
        deps: structuredClone(DEPS),
        "deps/vitest-v5": structuredClone(EMPTY),
        "deps/dotenv-v18": structuredClone(EMPTY),
      },
    });

    const res = await runCli(["doctor"]);
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Archived empty stack deps/vitest-v5");
    expect(res.out).toContain("Archived empty stack deps/dotenv-v18");

    const meta = await readMetadata(tmpDir);
    expect(Object.keys(meta.stacks)).toEqual(["deps"]);
    expect(Object.keys(meta.archive ?? {}).toSorted()).toEqual([
      "deps/dotenv-v18",
      "deps/vitest-v5",
    ]);
  });
});
