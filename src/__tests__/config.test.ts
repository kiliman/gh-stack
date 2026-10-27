// Flag defaults config (#39): the resolver and its precedence, file loading and
// validation, and the real CLI reading .gh-stack.toml / user config / env.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ConfigError,
  loadConfigFile,
  parseEnvBool,
  resolveSetting,
  validateConfig,
  type ConfigLayers,
} from "../lib/config.ts";
import { buildConfigReport } from "../commands/config.ts";
import {
  checkout,
  cleanup,
  createBranch,
  createGhStub,
  createLinearStack,
  createTempRepo,
  ghStubEnv,
  makeCommit,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";

function layers(
  opts: {
    env?: Record<string, string>;
    repo?: Record<string, unknown>;
    user?: Record<string, unknown>;
  } = {},
): ConfigLayers {
  return {
    env: opts.env ?? {},
    repo: opts.repo ? { path: "/r/.gh-stack.toml", exists: true, data: opts.repo } : null,
    user: opts.user ? { path: "/u/config.toml", exists: true, data: opts.user } : null,
  };
}

describe("resolveSetting precedence: flag > env > repo > user > built-in", () => {
  test("built-in default when nothing is set", () => {
    expect(resolveSetting("submit.draft", [], layers())).toEqual({
      value: false,
      source: "default",
    });
    expect(resolveSetting("restack.push", [], layers()).value).toBe(true);
  });

  test("user config beats the built-in default", () => {
    const r = resolveSetting("submit.draft", [], layers({ user: { submit: { draft: true } } }));
    expect(r).toEqual({ value: true, source: "user", origin: "/u/config.toml" });
  });

  test("repo config beats user config", () => {
    const r = resolveSetting(
      "submit.draft",
      [],
      layers({ repo: { submit: { draft: true } }, user: { submit: { draft: false } } }),
    );
    expect(r).toEqual({ value: true, source: "repo", origin: "/r/.gh-stack.toml" });
  });

  test("env beats repo config", () => {
    const r = resolveSetting(
      "submit.draft",
      [],
      layers({ env: { GH_STACK_DRAFT: "0" }, repo: { submit: { draft: true } } }),
    );
    expect(r).toEqual({ value: false, source: "env", origin: "GH_STACK_DRAFT" });
  });

  test("a flag beats env, and --no-draft overrides a true default", () => {
    const l = layers({ env: { GH_STACK_DRAFT: "1" }, repo: { submit: { draft: true } } });
    expect(resolveSetting("submit.draft", ["--no-draft"], l)).toEqual({
      value: false,
      source: "flag",
      origin: "--no-draft",
    });
    expect(resolveSetting("submit.draft", ["-d"], layers()).value).toBe(true);
  });

  test("the last of conflicting flags wins", () => {
    expect(resolveSetting("submit.draft", ["--draft", "--no-draft"], layers()).value).toBe(false);
    expect(resolveSetting("submit.draft", ["--no-draft", "--draft"], layers()).value).toBe(true);
  });

  test("GH_STACK_NO_PUSH is inverted: 1 = don't push, 0 = push over a repo default", () => {
    expect(
      resolveSetting("restack.push", [], layers({ env: { GH_STACK_NO_PUSH: "1" } })).value,
    ).toBe(false);
    const l = layers({ env: { GH_STACK_NO_PUSH: "0" }, repo: { restack: { push: false } } });
    expect(resolveSetting("restack.push", [], l)).toMatchObject({ value: true, source: "env" });
  });

  test("--push overrides GH_STACK_NO_PUSH and a push = false default", () => {
    const l = layers({ env: { GH_STACK_NO_PUSH: "1" }, repo: { restack: { push: false } } });
    expect(resolveSetting("restack.push", ["--push"], l)).toMatchObject({
      value: true,
      source: "flag",
    });
  });

  test("an empty env var counts as unset", () => {
    const l = layers({ env: { GH_STACK_DRAFT: "" }, repo: { submit: { draft: true } } });
    expect(resolveSetting("submit.draft", [], l).source).toBe("repo");
  });
});

describe("parseEnvBool", () => {
  test("accepts 1/0, true/false, yes/no in any case", () => {
    for (const v of ["1", "true", "YES"]) expect(parseEnvBool("X", v)).toBe(true);
    for (const v of ["0", "False", "no"]) expect(parseEnvBool("X", v)).toBe(false);
    expect(parseEnvBool("X", undefined)).toBeUndefined();
  });

  test("rejects anything else, naming the variable", () => {
    expect(() => parseEnvBool("GH_STACK_DRAFT", "maybe")).toThrow(ConfigError);
    expect(() => parseEnvBool("GH_STACK_DRAFT", "maybe")).toThrow("GH_STACK_DRAFT=maybe");
    expect(() => parseEnvBool("GH_STACK_NO_PUSH", "on")).toThrow("GH_STACK_NO_PUSH=on");
  });
});

describe("validateConfig", () => {
  test("known boolean keys pass silently", () => {
    expect(validateConfig({ submit: { draft: true }, restack: { push: false } }, "f")).toEqual([]);
  });

  test("unknown sections and keys warn instead of failing", () => {
    const warnings = validateConfig({ submit: { drafts: true }, deploy: { x: 1 }, top: 3 }, "f");
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("[submit] drafts");
  });

  test("yes is refused with its own explanation, top-level or in a section", () => {
    const warnings = validateConfig({ yes: true, restack: { yes: true } }, "/r/.gh-stack.toml");
    expect(warnings).toHaveLength(2);
    for (const w of warnings) expect(w).toContain("GH_STACK_YES=1");
  });

  test("a known key with a non-boolean value is an error naming the file and key", () => {
    expect(() => validateConfig({ submit: { draft: "yes" } }, "/r/.gh-stack.toml")).toThrow(
      '[submit] draft in /r/.gh-stack.toml must be true or false, got "yes"',
    );
  });
});

describe("loadConfigFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-cfg-"));
  });
  afterEach(async () => {
    await cleanup(dir);
  });

  test("a missing file is an empty layer", () => {
    const { file, warnings } = loadConfigFile(`${dir}/nope.toml`);
    expect(file).toEqual({ path: `${dir}/nope.toml`, exists: false, data: {} });
    expect(warnings).toEqual([]);
  });

  test("malformed TOML is a ConfigError that names the file", async () => {
    await Bun.write(`${dir}/bad.toml`, "[submit\ndraft = true\n");
    expect(() => loadConfigFile(`${dir}/bad.toml`)).toThrow(`invalid TOML in ${dir}/bad.toml`);
  });

  test("a path that is a directory is a ConfigError, not a missing file", async () => {
    await fs.mkdir(`${dir}/config.toml`);
    expect(() => loadConfigFile(`${dir}/config.toml`)).toThrow(`can't read ${dir}/config.toml`);
  });

  test("an unreadable file is a ConfigError, not a missing file", async () => {
    await Bun.write(`${dir}/locked.toml`, "[submit]\ndraft = true\n");
    await fs.chmod(`${dir}/locked.toml`, 0o000);
    expect(() => loadConfigFile(`${dir}/locked.toml`)).toThrow(`can't read ${dir}/locked.toml`);
  });

  test("parses and validates a good file", async () => {
    await Bun.write(`${dir}/ok.toml`, "[submit]\ndraft = true\nfoo = 1\n");
    const { file, warnings } = loadConfigFile(`${dir}/ok.toml`);
    expect(file.data).toEqual({ submit: { draft: true, foo: 1 } });
    expect(warnings).toEqual([`ignoring unknown key [submit] foo in ${dir}/ok.toml`]);
  });
});

describe("buildConfigReport", () => {
  test("reports every setting with its value and source", () => {
    const report = buildConfigReport(layers({ repo: { submit: { draft: true } } }));
    expect(report.settings).toEqual([
      {
        key: "submit.draft",
        value: true,
        source: "repo",
        origin: "/r/.gh-stack.toml",
        flags: ["--draft", "-d", "--no-draft"],
        env: "GH_STACK_DRAFT",
      },
      {
        key: "restack.push",
        value: true,
        source: "default",
        origin: null,
        flags: ["--push", "--no-push"],
        env: "GH_STACK_NO_PUSH",
      },
    ]);
    expect(report.files).toEqual({
      repo: { path: "/r/.gh-stack.toml", exists: true },
      user: null,
    });
  });
});

// ── End to end: the real CLI ──

const cliPath = new URL("../index.ts", import.meta.url).pathname;

let tmpDir: string;
let xdgDir: string;
const extraDirs: string[] = [];

async function runCli(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: cwd ?? tmpDir,
    env: { ...process.env, XDG_CONFIG_HOME: xdgDir, GH_STACK_NO_COLOR: "1", ...env },
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

async function remoteSha(branch: string): Promise<string> {
  return (await $`git -C ${tmpDir} ls-remote origin ${branch}`.text()).trim().split(/\s+/)[0]!;
}

async function writeUserConfig(toml: string): Promise<void> {
  await fs.mkdir(`${xdgDir}/gh-stack`, { recursive: true });
  await Bun.write(`${xdgDir}/gh-stack/config.toml`, toml);
}

// Only the CLI tests pay for a temp repo; the pure tests above don't.
describe("CLI (real binary, temp repos)", () => {
  beforeEach(async () => {
    tmpDir = await createTempRepo();
    xdgDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-xdg-"));
  });

  afterEach(async () => {
    await cleanup(tmpDir, xdgDir, ...extraDirs.splice(0));
  });

  describe("gh-stack config (CLI)", () => {
    test("works outside a git repo, showing the user and env layers", async () => {
      const outside = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-norepo-"));
      extraDirs.push(outside);
      await writeUserConfig("[submit]\ndraft = true\n");

      const res = await runCli(["config"], { GH_STACK_NO_PUSH: "1" }, outside);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/submit\.draft\s+true\s+user config/);
      expect(res.stdout).toMatch(/restack\.push\s+false\s+GH_STACK_NO_PUSH env var/);
      expect(res.stdout).toMatch(/repo\s+\(not in a git work tree\)/);
    }, 30_000);

    test("shows each value with its source: repo over user, env over repo", async () => {
      await Bun.write(`${tmpDir}/.gh-stack.toml`, "[submit]\ndraft = true\n");
      await writeUserConfig("[submit]\ndraft = false\n[restack]\npush = false\n");

      const json = JSON.parse((await runCli(["config", "--json"])).stdout);
      expect(json.settings.map((s: any) => [s.key, s.value, s.source])).toEqual([
        ["submit.draft", true, "repo"],
        ["restack.push", false, "user"],
      ]);
      expect(json.files.repo).toEqual({ path: `${tmpDir}/.gh-stack.toml`, exists: true });

      const withEnv = await runCli(["config"], { GH_STACK_DRAFT: "0" });
      expect(withEnv.exitCode).toBe(0);
      expect(withEnv.stdout).toMatch(/submit\.draft\s+false\s+GH_STACK_DRAFT env var/);
      expect(withEnv.stdout).toMatch(/restack\.push\s+false\s+user config/);
    }, 30_000);

    test("malformed TOML exits 1 with an error naming the file", async () => {
      await Bun.write(`${tmpDir}/.gh-stack.toml`, "[submit\ndraft = true\n");

      const res = await runCli(["config"]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain(`invalid TOML in ${tmpDir}/.gh-stack.toml`);
    }, 30_000);

    test("a non-boolean env var exits 1 with a clean error naming it", async () => {
      const res = await runCli(["config"], { GH_STACK_DRAFT: "maybe" });
      expect(res.exitCode).toBe(1);
      expect(res.stderr.trim()).toBe(
        "gh-stack: GH_STACK_DRAFT=maybe is not a boolean (use 1/0, true/false, or yes/no).",
      );
    }, 30_000);

    test("unknown keys and yes warn on stderr but don't stop the command", async () => {
      await Bun.write(
        `${tmpDir}/.gh-stack.toml`,
        "yes = true\n[submit]\ndraft = true\ncolor = 1\n",
      );

      const res = await runCli(["config"]);
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toContain("[submit] color");
      expect(res.stderr).toContain("GH_STACK_YES=1");
      expect(res.stdout).toMatch(/submit\.draft\s+true/);
    }, 30_000);

    test("yes in a repo config does not auto-confirm", async () => {
      await Bun.write(`${tmpDir}/.gh-stack.toml`, "yes = true\n");
      await createLinearStack(tmpDir);
      await checkout(tmpDir, "pr2");

      // `delete` confirms before removing; with no TTY and no --yes it must refuse
      // to prompt (#33) rather than proceed as if confirmed.
      const res = await runCli(["delete", "pr2"]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("refusing to prompt");
    }, 30_000);
  });

  describe("submit draft default (CLI, stub gh)", () => {
    let stubDir: string;
    let remoteDir: string;

    beforeEach(async () => {
      remoteDir = await setupRemote(tmpDir);
      stubDir = await createGhStub();
      extraDirs.push(remoteDir, stubDir);
      await createBranch(tmpDir, "feat-a", "main");
      await makeCommit(tmpDir, "a.txt", "a\n", "feat-a: add a");
    });

    async function createCalls(): Promise<string[]> {
      const log = await Bun.file(`${stubDir}/calls.log`).text();
      return log.split("\n").filter((line) => line.startsWith("pr create"));
    }

    test("[submit] draft = true in .gh-stack.toml creates the PR as a draft", async () => {
      await Bun.write(`${tmpDir}/.gh-stack.toml`, "[submit]\ndraft = true\nreviewers = 2\n");

      const res = await runCli(["submit", "--json", "-t", "A"], ghStubEnv(stubDir));
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).branches[0].draft).toBe(true);
      expect(await createCalls()).toEqual([expect.stringContaining("--draft")]);
      expect(res.stderr).toContain("New PRs open as drafts: repo config");
      expect(res.stderr).toContain("warning: ignoring unknown key [submit] reviewers");
    }, 30_000);

    test("--no-draft overrides the repo default", async () => {
      await Bun.write(`${tmpDir}/.gh-stack.toml`, "[submit]\ndraft = true\n");

      const res = await runCli(["submit", "--json", "--no-draft", "-t", "A"], ghStubEnv(stubDir));
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).branches[0].draft).toBe(false);
      expect(await createCalls()).toEqual([expect.not.stringContaining("--draft")]);
    }, 30_000);

    test("a bad GH_STACK_DRAFT stops submit --json before any push, as a JSON error", async () => {
      const res = await runCli(["submit", "--json", "-t", "A"], {
        ...ghStubEnv(stubDir),
        GH_STACK_DRAFT: "maybe",
      });
      expect(res.exitCode).toBe(1);
      expect(JSON.parse(res.stdout).error.message).toContain("GH_STACK_DRAFT=maybe");
      expect(await Bun.file(`${stubDir}/calls.log`).exists()).toBe(false);
      expect((await $`git -C ${tmpDir} ls-remote origin feat-a`.text()).trim()).toBe("");
    }, 30_000);

    test("submit --draft --restack never reads a broken config, so it can't stop halfway", async () => {
      // Register feat-a → feat-b, then break the config and fix feat-a.
      await createBranch(tmpDir, "feat-b", "feat-a");
      await makeCommit(tmpDir, "b.txt", "b\n", "feat-b: add b");
      expect((await runCli(["submit", "-t", "B", "--yes"], ghStubEnv(stubDir))).exitCode).toBe(0);
      await Bun.write(`${tmpDir}/.gh-stack.toml`, "[submit\n");
      await checkout(tmpDir, "feat-a");
      await makeCommit(tmpDir, "a2.txt", "a2\n", "feat-a: fix");

      const res = await runCli(["submit", "--draft", "--restack", "--yes"], ghStubEnv(stubDir));
      expect(res.exitCode).toBe(0);
      // The chained restack rebased feat-b and pushed it (it always pushes).
      const local = (await $`git -C ${tmpDir} rev-parse feat-b`.text()).trim();
      expect(await remoteSha("feat-b")).toBe(local);
    }, 60_000);

    test("GH_STACK_DRAFT=1 drafts with no config file", async () => {
      const res = await runCli(["submit", "--json", "-t", "A"], {
        ...ghStubEnv(stubDir),
        GH_STACK_DRAFT: "1",
      });
      expect(res.exitCode).toBe(0);
      expect(await createCalls()).toEqual([expect.stringContaining("--draft")]);
    }, 30_000);
  });

  describe("[restack] push default (CLI)", () => {
    let remoteDir: string;

    beforeEach(async () => {
      await createLinearStack(tmpDir);
      remoteDir = await setupRemote(tmpDir);
      extraDirs.push(remoteDir);
      await pushAllBranches(tmpDir);
      // A new commit on pr1 means pr2/pr3 need rebasing (and pushing).
      await checkout(tmpDir, "pr1");
      await makeCommit(tmpDir, "fix.txt", "fix\n", "fix on pr1");
    });

    test("push = false keeps restack local, and its hint (restack --push) publishes", async () => {
      await Bun.write(`${tmpDir}/.gh-stack.toml`, "[restack]\npush = false\n");
      const before = await remoteSha("pr2");

      const local = await runCli(["restack", "--yes"]);
      expect(local.exitCode).toBe(0);
      const out = local.stdout + local.stderr;
      expect(out).toContain("Not pushing: repo config");
      expect(out).toContain("Not pushed (repo config");
      expect(out).toContain("Publish when ready: gh-stack restack --push");
      expect(await remoteSha("pr2")).toBe(before);

      // Follow the hint as printed, with nothing new to rebase.
      await checkout(tmpDir, "pr1");
      const pushed = await runCli(["restack", "--yes", "--push"]);
      expect(pushed.exitCode).toBe(0);
      const pr2Local = (await $`git -C ${tmpDir} rev-parse pr2`.text()).trim();
      expect(await remoteSha("pr2")).toBe(pr2Local);
    }, 60_000);

    test("a bad GH_STACK_NO_PUSH stops restack before it rebases anything", async () => {
      const pr2Before = (await $`git -C ${tmpDir} rev-parse pr2`.text()).trim();

      const res = await runCli(["restack", "--yes"], { GH_STACK_NO_PUSH: "maybe" });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("gh-stack: GH_STACK_NO_PUSH=maybe is not a boolean");
      expect((await $`git -C ${tmpDir} rev-parse pr2`.text()).trim()).toBe(pr2Before);
    }, 30_000);

    test("sync --push reaches the children it restacks despite push = false", async () => {
      await Bun.write(`${tmpDir}/.gh-stack.toml`, "[restack]\npush = false\nforce = true\n");
      // Move main on origin so sync has something to rebase the stack onto.
      await checkout(tmpDir, "main");
      await makeCommit(tmpDir, "main.txt", "main\n", "main moves");
      await $`git -C ${tmpDir} push -q origin main`;
      await checkout(tmpDir, "pr1");

      const res = await runCli(["sync", "--yes", "--push"]);
      expect(res.exitCode).toBe(0);
      // An explicit flag decides without reading config: no warning about the
      // unknown key, in sync or in the restack it runs.
      expect(res.stderr + res.stdout).not.toContain("[restack] force");
      for (const b of ["pr1", "pr2", "pr3"]) {
        const local = (await $`git -C ${tmpDir} rev-parse ${b}`.text()).trim();
        expect(await remoteSha(b)).toBe(local);
      }
    }, 60_000);
  });
  describe("restack --resume keeps the interrupted run's push decision", () => {
    let remoteDir: string;

    // pr1 gains a pr2.txt that conflicts with pr2's own, so restack stops on pr2
    // with push = false in effect. The config is then removed (push would
    // default to true) before the conflict is resolved and the run resumed.
    beforeEach(async () => {
      await createLinearStack(tmpDir);
      remoteDir = await setupRemote(tmpDir);
      extraDirs.push(remoteDir);
      await pushAllBranches(tmpDir);
      await checkout(tmpDir, "pr1");
      await makeCommit(tmpDir, "pr2.txt", "from pr1\n", "pr1: conflicting pr2.txt");
      await Bun.write(`${tmpDir}/.gh-stack.toml`, "[restack]\npush = false\n");

      const first = await runCli(["restack", "--yes"]);
      expect(first.exitCode).not.toBe(0);

      await fs.rm(`${tmpDir}/.gh-stack.toml`);
      await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
      await $`git -C ${tmpDir} add pr2.txt`.quiet();
      await $`git -C ${tmpDir} rebase --continue`
        .env({ ...process.env, GIT_EDITOR: "true" })
        .quiet();
    });

    test("a resume without a flag stays local-only, even though the config changed", async () => {
      const before = await remoteSha("pr2");

      const res = await runCli(["restack", "--resume", "--yes"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout + res.stderr).toContain("Not pushed (resumed a local-only run");
      expect(await remoteSha("pr2")).toBe(before);
    }, 60_000);

    test("an explicit --push on the resume wins", async () => {
      const res = await runCli(["restack", "--resume", "--yes", "--push"]);
      expect(res.exitCode).toBe(0);
      const local = (await $`git -C ${tmpDir} rev-parse pr2`.text()).trim();
      expect(await remoteSha("pr2")).toBe(local);
    }, 60_000);
  });
});
