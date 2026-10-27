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
// Removing these variables from process.env before any test runs means each
// spawned git finds its repository from its own working directory, as intended.
// The list comes from git itself (`git rev-parse --local-env-vars`, the same set
// git clears before recursing into a submodule), with a fallback in case that
// call fails.

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
