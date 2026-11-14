// --help in any position prints the command's help page and runs nothing
// (#96). `gh-stack --help submit` used to run submit, which pushes, and
// `gh-stack log --help` printed the tree because log had no help page.
//
// Every name in COMMANDS (aliases included) is run in a repo holding a real
// stack with a remote, standing mid-stack so navigation would move. If a
// command ran instead of printing help, the repo's state would change: HEAD,
// refs (local, remote-tracking and on the remote itself), the metadata files,
// or a call to gh.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { COMMANDS } from "../lib/commands.ts";
import {
  checkout,
  cleanup,
  createGhStub,
  createLinearStack,
  createTempRepo,
  ghStubEnv,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";

const cliPath = new URL("../index.ts", import.meta.url).pathname;

let repo: string;
let remote: string;
let stub: string;
let outside: string;

beforeAll(async () => {
  repo = await createTempRepo();
  await createLinearStack(repo);
  remote = await setupRemote(repo);
  await pushAllBranches(repo);
  await checkout(repo, "pr2");
  stub = await createGhStub();
  outside = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-no-repo-"));
});

afterAll(async () => {
  await cleanup(repo, remote, stub, outside);
});

async function runCli(cwd: string, args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd,
    // --yes semantics without a TTY: a command that runs instead of printing
    // help can't stop at a prompt, so it gets as far as it would for an agent.
    env: { ...process.env, ...ghStubEnv(stub), GH_STACK_YES: "1" },
    stdin: "ignore",
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

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .toSorted();
}

/** Everything a command could change: HEAD, all refs, the remote, metadata, branch config. */
async function repoState(): Promise<string> {
  const metaDir = path.join(repo, ".git", ".gh-stack");
  const metaFiles = await listFiles(metaDir);
  const contents = await Promise.all(metaFiles.map((f) => Bun.file(f).text()));
  return [
    await $`git -C ${repo} symbolic-ref HEAD`.text(),
    await $`git -C ${repo} for-each-ref --format=${"%(refname) %(objectname)"}`.text(),
    await $`git -C ${remote} for-each-ref --format=${"%(refname) %(objectname)"}`.text(),
    await $`git -C ${repo} status --porcelain`.text(),
    await $`git -C ${repo} config --get-regexp ${"^branch\\."}`.nothrow().text(),
    ...metaFiles.map((f, i) => `${f}\n${contents[i]}`),
  ].join("\n---\n");
}

async function ghCalls(): Promise<string> {
  return Bun.file(path.join(stub, "calls.log"))
    .text()
    .catch(() => "");
}

describe("--help runs nothing (#96)", () => {
  test.each(Object.keys(COMMANDS))("%s", async (command) => {
    const before = await repoState();
    const forms = [
      [command, "--help"],
      ["--help", command],
      ["help", command],
    ];
    for (const args of forms) {
      const r = await runCli(repo, args);
      expect({ args, exitCode: r.exitCode, stderr: r.stderr }).toEqual({
        args,
        exitCode: 0,
        stderr: "",
      });
      expect(r.stdout).toContain("USAGE");
      // Each command's own page, not the global command list.
      expect(r.stdout).not.toContain("CORE WORKFLOW");
    }
    expect(await repoState()).toBe(before);
    expect(await ghCalls()).toBe("");
  });

  test("a command's help shows outside a git repository", async () => {
    for (const args of [
      ["submit", "--help"],
      ["--help", "log"],
    ]) {
      const r = await runCli(outside, args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("USAGE");
    }
  });

  test("--help or help alone lists the commands", async () => {
    for (const args of [["--help"], ["help"]]) {
      const r = await runCli(outside, args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("CORE WORKFLOW");
    }
  });

  test("an unknown command after help is reported as unknown", async () => {
    const r = await runCli(repo, ["help", "frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown command: frobnicate");
  });
});

// FORCE_COLOR makes picocolors color a pipe, so color shows unless NO_COLOR is set.
async function logOutput(env: Record<string, string>, args: string[] = []) {
  const { NO_COLOR: _drop, ...base } = process.env;
  const proc = Bun.spawn(["bun", "run", cliPath, "log", ...args], {
    cwd: repo,
    env: { ...base, FORCE_COLOR: "1", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { output: stdout + stderr, stderr, exitCode };
}

// #96: GH_STACK_YES and GH_STACK_PLAIN took only "1", and GH_STACK_NO_COLOR
// took any non-empty value, "0" included. They now share GH_STACK_NO_PUSH's
// parser: 1/0, true/false, yes/no, and an error for anything else.
describe("GH_STACK_* booleans (#96)", () => {
  const ANSI = "\x1b[";

  test("GH_STACK_NO_COLOR=0 keeps color; =true turns it off", async () => {
    const colored = await logOutput({ GH_STACK_NO_COLOR: "0" });
    expect(colored.exitCode).toBe(0);
    expect(colored.output).toContain(ANSI);
    const plain = await logOutput({ GH_STACK_NO_COLOR: "true" });
    expect(plain.exitCode).toBe(0);
    expect(plain.output).not.toContain(ANSI);
  });

  test("GH_STACK_YES=yes and the --yes flag both turn color off", async () => {
    expect((await logOutput({ GH_STACK_YES: "yes" })).output).not.toContain(ANSI);
    expect((await logOutput({}, ["--yes"])).output).not.toContain(ANSI);
  });

  test("a non-boolean value is a one-line error before anything runs", async () => {
    const r = await logOutput({ GH_STACK_YES: "sure" });
    expect(r.exitCode).toBe(1);
    // Bun's console.error paints stderr red under FORCE_COLOR; compare the text.
    // oxlint-disable-next-line no-control-regex
    expect(r.stderr.replace(/\x1b\[[0-9;]*m/g, "").trim()).toBe(
      "gh-stack: GH_STACK_YES=sure is not a boolean (use 1/0, true/false, or yes/no).",
    );
  });
});
