// Test preload (bunfig.toml [test].preload): isolate the suite from any
// enclosing git repository.
//
// Git exports repo-locating variables such as GIT_DIR and GIT_INDEX_FILE to
// the hooks it runs. From a linked worktree, GIT_DIR is an absolute path, so
// when the pre-push hook runs `bun test`, every `git` the tests spawn would
// inherit it and operate on the real repository instead of its temp repo:
// `branch -M main` renames the pushed branch over local main,
// `config user.*` writes a Test identity, and `init --bare` sets core.bare.
//
// The pre-push hook clears these variables itself. This preload is the second
// layer, for any other way the suite can be started from a git hook. It
// removes them from process.env before any test runs, so each spawned git finds
// its repository from its own working directory. The list comes from git itself
// (`git rev-parse --local-env-vars`, the same set git clears before recursing
// into a submodule), with a fallback in case that call fails.
//
// Deleting from process.env only reaches Bun's `$` and spawns that pass
// `env: process.env`. A bare `Bun.spawn(cmd)` still uses the environment the
// process started with, so Bun.spawn/spawnSync are wrapped below to default
// `env` to the scrubbed process.env.

import { tmpdir } from "node:os";
import { join } from "node:path";

const FALLBACK_LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

function localEnvVars(): string[] {
  const result = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"]);
  const names = result.stdout.toString().split("\n").filter(Boolean);
  return result.exitCode === 0 && names.length > 0 ? names : FALLBACK_LOCAL_ENV_VARS;
}

for (const name of localEnvVars()) {
  delete process.env[name];
}
// GIT_CONFIG_COUNT pairs with numbered GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n>.
for (const name of Object.keys(process.env)) {
  if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete process.env[name];
}

// Both call shapes: spawn(cmd, options?) and spawn({ cmd, ...options }).
// oxlint-disable-next-line typescript/no-explicit-any
function withScrubbedEnv(args: any[]): any[] {
  const [first, second] = args;
  if (Array.isArray(first)) return [first, { ...second, env: second?.env ?? process.env }];
  return [{ ...first, env: first?.env ?? process.env }];
}
const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;
Object.assign(Bun, {
  // oxlint-disable-next-line typescript/no-explicit-any
  spawn: (...args: any[]) => (originalSpawn as any)(...withScrubbedEnv(args)),
  // oxlint-disable-next-line typescript/no-explicit-any
  spawnSync: (...args: any[]) => (originalSpawnSync as any)(...withScrubbedEnv(args)),
});

// Flag defaults (#39): never read the developer's own ~/.config/gh-stack or
// their GH_STACK_DRAFT / GH_STACK_NO_PUSH. The XDG dir is never created, so
// there is no user config; tests that need one set XDG_CONFIG_HOME themselves.
process.env.XDG_CONFIG_HOME = join(tmpdir(), `gh-stack-test-no-xdg-${process.pid}`);
delete process.env.GH_STACK_DRAFT;
delete process.env.GH_STACK_NO_PUSH;
