// Before a run rewrites branches, make sure origin doesn't hold content the
// local branches lack (#28).
//
// The incident: `merge --collapse` squash-merged PR2 into PR1's branch on
// GitHub. The local PR1 never pulled that squash commit, a `sync` rebased the
// local PR1 and force-pushed it, and the base PR silently lost every child's
// content. `--force-with-lease` doesn't protect against this once the
// remote-tracking ref has been fetched.
//
// The hard part is not crying wolf. After a `--no-push` restack, or a run
// interrupted before its pushes, origin legitimately holds the *pre-rewrite*
// versions of local commits. Those aren't new: local had them and rewrote them
// on purpose. So a commit on origin counts as new content only if
//   1. it was never in the local branch's history (its reflog, or a tip a
//      snapshot recorded), and
//   2. it isn't patch-equivalent to a local commit.
import { $ } from "bun";
import pc from "picocolors";
import * as p from "./output.ts";
import * as git from "./git.ts";
import { isAutoYes } from "./ui.ts";
import type { StackMetadata } from "../types.ts";

/** A branch whose origin copy differs but couldn't be checked. */
export interface Unverified {
  branch: string;
  remoteSha: string;
  reason: string;
}

export interface RemoteOnlyContent {
  branch: string;
  localSha: string;
  remoteSha: string;
  /** "sha subject", oldest first. */
  commits: string[];
  /** Local is simply behind origin (a fast-forward brings the commits in). */
  behind: boolean;
}

/** How many reflog entries count as "versions local already had". */
const REFLOG_DEPTH = 300;

/**
 * For each branch with a copy on origin that differs from local, the commits
 * origin has that are new content (see the module comment). `cleared` maps the
 * branches whose origin copy differs but holds nothing new to the origin tip
 * that was checked. `unverified` lists branches whose origin copy couldn't be
 * checked (not fetched, or git failed): never cleared, the caller fails closed.
 */
export async function findRemoteOnlyContent(
  meta: StackMetadata,
  branches: string[],
): Promise<{
  found: RemoteOnlyContent[];
  cleared: Map<string, string>;
  unverified: Unverified[];
}> {
  const found: RemoteOnlyContent[] = [];
  const cleared = new Map<string, string>();
  const unverified: Unverified[] = [];
  const heads = await git.remoteHeads();
  const trunk = await git.trunkBranch();

  const targets: { branch: string; local: string; remote: string }[] = [];
  for (const branch of new Set(branches)) {
    if (branch === trunk || branch === "main" || branch === "master") continue;
    const remote = heads.get(branch);
    if (!remote || !(await git.localBranchExists(branch))) continue;
    const local = await git.revParse(branch);
    if (remote !== local) targets.push({ branch, local, remote });
  }
  if (targets.length === 0) return { found, cleared, unverified };

  // Origin's trunk too: commits that came from it (GitHub's "Update branch"
  // merges main into a PR branch) aren't the user's to lose.
  const trunkTip = heads.get(trunk);
  await git.fetchObjectsOnly([
    ...targets.map((t) => `refs/heads/${t.branch}`),
    ...(trunkTip ? [`refs/heads/${trunk}`] : []),
  ]);

  for (const { branch, local, remote } of targets) {
    if (!(await git.refExists(`${remote}^{commit}`))) {
      unverified.push({
        branch,
        remoteSha: remote,
        reason: `origin/${branch} couldn't be fetched`,
      });
      continue;
    }
    if (await git.isAncestor(remote, local)) {
      cleared.set(branch, remote); // local already has all of it
      continue;
    }

    const known = [
      local,
      ...(await reflogTips(branch)),
      ...snapshotTips(meta, branch),
      ...(trunkTip ? [trunkTip] : []),
    ];
    const candidates = await revListLines([
      "--ignore-missing",
      "--reverse",
      "--no-merges",
      remote,
      "--not",
      ...new Set(known),
    ]);
    const unmatched = await revListLines([
      "--cherry-pick",
      "--right-only",
      "--no-merges",
      `${local}...${remote}`,
    ]);
    if (candidates === null || unmatched === null) {
      // No verdict is not a clean verdict: this branch stays unchecked.
      unverified.push({ branch, remoteSha: remote, reason: "git rev-list failed comparing it" });
      continue;
    }
    const fresh = candidates.filter((sha) => unmatched.includes(sha));
    if (fresh.length === 0) {
      cleared.set(branch, remote);
      continue;
    }
    found.push({
      branch,
      localSha: local,
      remoteSha: remote,
      commits: await oneLines(fresh),
      behind: await git.isAncestor(local, remote),
    });
  }
  return { found, cleared, unverified };
}

/** Earlier tips of `refs/heads/<branch>`, newest first. */
async function reflogTips(branch: string): Promise<string[]> {
  const { stdout } = await $`git reflog show --format=%H refs/heads/${branch}`.nothrow().quiet();
  return stdout.toString().split("\n").filter(Boolean).slice(0, REFLOG_DEPTH);
}

/** Tips of `branch` that snapshots recorded (the pre-rewrite versions). */
function snapshotTips(meta: StackMetadata, branch: string): string[] {
  const tips = new Set<string>();
  for (const snap of meta.snapshots ?? []) {
    const sha = snap.branches[branch];
    if (sha) tips.add(sha);
  }
  return [...tips];
}

/** `git rev-list` output, or null if it failed (never an empty "nothing found"). */
async function revListLines(args: string[]): Promise<string[] | null> {
  const { stdout, exitCode } = await $`git rev-list ${args}`.nothrow().quiet();
  if (exitCode !== 0) return null;
  return stdout.toString().split("\n").filter(Boolean);
}

/** "abbrev subject" for each sha, in the given order, from one `git log`. */
async function oneLines(shas: string[]): Promise<string[]> {
  const { stdout } = await $`git log --no-walk=unsorted --format=${"%h %s"} ${shas}`
    .nothrow()
    .quiet();
  return stdout.toString().split("\n").filter(Boolean);
}

/**
 * Stop a run before it rewrites a branch whose origin copy has new content.
 * Interactive: ask (default no). Under --yes: refuse, since no flag the user
 * gave said "drop commits from origin". `--overwrite-remote` proceeds. A dry
 * run only reports.
 */
export async function guardRemoteContent(
  meta: StackMetadata,
  branches: string[],
  opts: { command: string; overwrite: boolean; dryRun: boolean },
): Promise<Map<string, string>> {
  const { found, cleared, unverified } = await findRemoteOnlyContent(meta, branches);
  if (found.length === 0 && unverified.length === 0) return cleared;

  if (unverified.length > 0) {
    console.log();
    p.log.error(
      "Couldn't check these branches' copies on origin for commits the local branches lack:",
    );
    for (const u of unverified) {
      console.log(
        `  ${pc.yellow(u.branch)}  ${pc.dim(`(origin ${u.remoteSha.slice(0, 8)}: ${u.reason})`)}`,
      );
    }
    console.log();
    console.log(
      `  ${opts.command} would rebase or force-push them without knowing what's there. Look first:`,
    );
    for (const u of unverified) {
      console.log(
        `    ${pc.green(`git fetch origin ${u.branch} && git log ${u.branch}..origin/${u.branch}`)}`,
      );
    }
    console.log(`  Then re-run ${pc.green(`gh-stack ${opts.command}`)}.`);
    console.log(
      `  Or, to overwrite them regardless: ${pc.green(`gh-stack ${opts.command} --overwrite-remote`)}`,
    );
  }
  if (found.length === 0) return decide(cleared, [], unverified, opts);

  console.log();
  p.log.error(
    "Origin has commits that the local branches don't, and they aren't earlier versions of local commits:",
  );
  for (const f of found) {
    console.log(
      `  ${pc.yellow(f.branch)}  ${pc.dim(`(origin ${f.remoteSha.slice(0, 8)}, local ${f.localSha.slice(0, 8)})`)}`,
    );
    for (const c of f.commits) console.log(`    ${pc.red("+")} ${c}`);
  }
  console.log();
  console.log(
    `  ${opts.command} would rebase or force-push ${found.length === 1 ? "this branch" : "these branches"} without them, and they'd be lost from origin and the PR.`,
  );
  console.log(
    "  This is what happens after `merge --collapse` squashes a child PR into its parent on GitHub.",
  );
  console.log();
  console.log("  Bring them into the local branch first:");
  for (const f of found) {
    const shas = f.commits.map((c) => c.split(" ")[0]).join(" ");
    console.log(
      `    ${pc.green(f.behind ? `git checkout ${f.branch} && git pull --ff-only origin ${f.branch}` : `git checkout ${f.branch} && git cherry-pick ${shas}`)}`,
    );
  }
  console.log(`  Then re-run ${pc.green(`gh-stack ${opts.command}`)}.`);
  console.log(
    `  Or, to drop them on purpose: ${pc.green(`gh-stack ${opts.command} --overwrite-remote`)}`,
  );
  return decide(cleared, found, unverified, opts);
}

/**
 * What to do about branches with new or unchecked content on origin: report
 * (dry run), proceed (--overwrite-remote, or an interactive yes), or stop
 * (--yes, or no). Proceeding clears their checked tips for an explicit lease.
 */
async function decide(
  cleared: Map<string, string>,
  found: RemoteOnlyContent[],
  unverified: Unverified[],
  opts: { overwrite: boolean; dryRun: boolean },
): Promise<Map<string, string>> {
  console.log();
  if (opts.dryRun) {
    p.log.warn("[DRY RUN] A real run would stop here.");
    return cleared;
  }
  const overwrite = () => {
    for (const f of found) cleared.set(f.branch, f.remoteSha);
    for (const u of unverified) cleared.set(u.branch, u.remoteSha);
    return cleared;
  };
  if (opts.overwrite) {
    p.log.warn(
      "--overwrite-remote: continuing. Origin's copies of those branches will be overwritten.",
    );
    return overwrite();
  }
  if (isAutoYes()) {
    p.cancel("Stopped before rewriting anything (--yes never overwrites what it couldn't check).");
    process.exit(1);
  }
  const ok = await p.confirm({
    message: "Rewrite anyway, overwriting origin's copies of those branches?",
    initialValue: false,
  });
  if (p.isCancel(ok) || !ok) {
    p.cancel("Stopped before rewriting anything.");
    process.exit(1);
  }
  return overwrite();
}
