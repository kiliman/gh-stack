// Git-native branch membership index.
//
// Each branch records which stack it belongs to (plus its parent and PR) in
// git's own config under the `branch.<name>` section:
//
//   branch.<name>.ghstack-stack   <stack>
//   branch.<name>.ghstack-parent  <parent-branch>
//   branch.<name>.ghstack-pr      <number>
//   branch.<name>.ghstack-id      <uuid>  (stable identity; survives rename)
//   branch.<name>.ghstack-gitdir  <path>  (the git dir of the worktree that owns it)
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
//
// Git config is shared by every worktree of a repo, but each worktree keeps its
// own stack files (under its own git dir). `ghstack-gitdir` records which
// worktree wrote a branch's membership, so a write in one worktree leaves the
// branches another worktree is stacking alone (#64).
import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { runGit } from "./git.ts";

export interface BranchMembership {
  stack?: string;
  parent?: string;
  pr?: number;
  id?: string;
  gitdir?: string;
}

const KEY_PREFIX = "ghstack-";
const STACK_KEY = "ghstack-stack";
const PARENT_KEY = "ghstack-parent";
const PR_KEY = "ghstack-pr";
const ID_KEY = "ghstack-id";
const GITDIR_KEY = "ghstack-gitdir";

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
  await setOrUnset(branch, GITDIR_KEY, membership.gitdir);
}

async function setOrUnset(branch: string, key: string, value: string | undefined): Promise<void> {
  if (value === undefined || value === "") {
    await unsetKey(branch, key);
    return;
  }
  // The repo's config is shared by every worktree, so another gh-stack (or any
  // `git config` write) can hold config.lock for a moment: runGit waits it out
  // instead of silently dropping the write.
  await runGit(["config", configKey(branch, key), value]);
}

async function unsetKey(branch: string, key: string): Promise<void> {
  // `--unset` exits 5 when the key is already absent — harmless, so the exit
  // code is ignored.
  await runGit(["config", "--unset", configKey(branch, key)]);
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
 * Remove a branch's stack membership (stack, parent, id, owner), keeping its
 * PR number. The PR belongs to the branch, not to the stack, so a branch that
 * leaves its stack (`delete --keep-branch`, a removed worktree's branches) and
 * is tracked again later, in this worktree or another, gets its PR back. (#67)
 */
export async function clearBranchMembership(branch: string): Promise<void> {
  await unsetKey(branch, STACK_KEY);
  await unsetKey(branch, PARENT_KEY);
  await unsetKey(branch, ID_KEY);
  await unsetKey(branch, GITDIR_KEY);
}

/** True if `m` records stack membership, not just a PR number kept after leaving a stack. */
export function hasMembership(m: BranchMembership): boolean {
  return !!(m.stack || m.parent || m.id || m.gitdir);
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
    else if (field === GITDIR_KEY) m.gitdir = value;
    else if (field === PR_KEY) {
      const n = Number(value);
      if (Number.isFinite(n)) m.pr = n;
    }
    out.set(branch, m);
  }

  return out;
}

/**
 * True if `m` belongs to a worktree other than `mine` that still exists.
 * Membership with no owner (written before owners were recorded) or with an
 * owner that's gone is up for grabs.
 */
export function ownedByOtherWorktree(m: BranchMembership | undefined, mine: string): boolean {
  return !!m?.gitdir && m.gitdir !== mine && gitDirIsLive(m.gitdir);
}

/**
 * A worktree's git dir is live while it exists and, for a linked worktree,
 * while its checkout does too: `.git/worktrees/<name>/gitdir` names the
 * checkout's `.git` file, which is what `git worktree prune` checks. The main
 * checkout's git dir has no `gitdir` file.
 */
function gitDirIsLive(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const pointer = path.join(dir, "gitdir");
  if (!existsSync(pointer)) return true;
  try {
    return existsSync(readFileSync(pointer, "utf8").trim());
  } catch {
    return false;
  }
}
