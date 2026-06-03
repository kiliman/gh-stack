// Git-native branch membership index.
//
// Each branch records which stack it belongs to (plus its parent and PR) in
// git's own config under the `branch.<name>` section:
//
//   branch.<name>.ghstack-stack   <stack>
//   branch.<name>.ghstack-parent  <parent-branch>
//   branch.<name>.ghstack-pr      <number>
//   branch.<name>.ghstack-id      <uuid>  (stable identity; survives rename)
//
// Why config and not JSON: git maintains the `branch.<name>` section for us.
//   • `git branch -m old new`  → the section moves      → rename tracking free
//   • `git branch -D name`     → the section is deleted  → no orphaned membership
//
// So this is a self-cleaning, rename-safe index that runs alongside the
// `.gh-stack/` topology files and lets `doctor` cross-check the two. We use
// dash-separated, all-lowercase variable names on purpose: git only permits
// alphanumerics and `-` in config keys (underscores are rejected outright),
// and it lowercases the variable portion on read — so `ghstack-stack` round
// -trips exactly while a camelCase key would read back mangled.
import { $ } from "bun";

export interface BranchMembership {
  stack?: string;
  parent?: string;
  pr?: number;
  id?: string;
}

const KEY_PREFIX = "ghstack-";
const STACK_KEY = "ghstack-stack";
const PARENT_KEY = "ghstack-parent";
const PR_KEY = "ghstack-pr";
const ID_KEY = "ghstack-id";

function configKey(branch: string, key: string): string {
  return `branch.${branch}.${key}`;
}

/**
 * Set (or clear) the membership config for a single branch. Any field left
 * undefined is removed, so callers can pass a full desired state and trust the
 * branch ends up matching it exactly.
 */
export async function setBranchMembership(
  branch: string,
  membership: BranchMembership,
): Promise<void> {
  await setOrUnset(branch, STACK_KEY, membership.stack);
  await setOrUnset(branch, PARENT_KEY, membership.parent);
  await setOrUnset(branch, PR_KEY, membership.pr != null ? String(membership.pr) : undefined);
  await setOrUnset(branch, ID_KEY, membership.id);
}

async function setOrUnset(branch: string, key: string, value: string | undefined): Promise<void> {
  if (value === undefined || value === "") {
    await unsetKey(branch, key);
    return;
  }
  await $`git config ${configKey(branch, key)} ${value}`.quiet().nothrow();
}

async function unsetKey(branch: string, key: string): Promise<void> {
  // `--unset` exits 5 when the key is already absent — harmless, so nothrow.
  await $`git config --unset ${configKey(branch, key)}`.quiet().nothrow();
}

/**
 * Read one branch's membership. Returns an empty object if the branch has no
 * gh-stack config.
 */
export async function getBranchMembership(branch: string): Promise<BranchMembership> {
  const all = await allBranchMemberships();
  return all.get(branch) ?? {};
}

/**
 * Remove all gh-stack membership keys from a branch (leaves the branch and its
 * other config untouched).
 */
export async function clearBranchMembership(branch: string): Promise<void> {
  await unsetKey(branch, STACK_KEY);
  await unsetKey(branch, PARENT_KEY);
  await unsetKey(branch, PR_KEY);
  await unsetKey(branch, ID_KEY);
}

/**
 * Read every branch's gh-stack membership in one shot, keyed by branch name.
 *
 * Branch names may legally contain dots (`feat.x`), so we can't naively split
 * the config key on `.`. We anchor on the known `.ghstack-<field>` suffix and
 * treat everything between `branch.` and that suffix as the branch name.
 */
export async function allBranchMemberships(): Promise<Map<string, BranchMembership>> {
  const out = new Map<string, BranchMembership>();

  const { stdout, exitCode } = await $`git config --get-regexp ${"^branch\\..*\\.ghstack-"}`
    .quiet()
    .nothrow();
  // exit 1 simply means no matching keys — an empty repo, not an error.
  if (exitCode !== 0) return out;

  const text = stdout.toString().trim();
  if (!text) return out;

  for (const line of text.split("\n")) {
    const sep = line.indexOf(" ");
    if (sep === -1) continue;
    const fullKey = line.slice(0, sep);
    const value = line.slice(sep + 1);

    // fullKey looks like: branch.<name>.ghstack-<field>
    if (!fullKey.startsWith("branch.")) continue;
    const dotField = fullKey.lastIndexOf(`.${KEY_PREFIX}`);
    if (dotField === -1) continue;
    const branch = fullKey.slice("branch.".length, dotField);
    const field = fullKey.slice(dotField + 1); // ghstack-<field>

    const m = out.get(branch) ?? {};
    if (field === STACK_KEY) m.stack = value;
    else if (field === PARENT_KEY) m.parent = value;
    else if (field === ID_KEY) m.id = value;
    else if (field === PR_KEY) {
      const n = Number(value);
      if (Number.isFinite(n)) m.pr = n;
    }
    out.set(branch, m);
  }

  return out;
}
