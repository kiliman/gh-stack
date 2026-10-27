// After `merge` collapses a stack top-down on GitHub (PR3 squashed into PR2's
// branch, PR2 into PR1's), every child's content lives in one squash commit on
// its parent's branch. If that branch is rewritten before the base PR merges
// (#28: a sync rebased the base and force-pushed it without the squash commit),
// the base PR ships without its children, and nothing errors.
//
// So before the base PR is handed to main, check that each child's squash
// commit is still in what it was squashed into:
//   - a child of the base: the base branch's head on origin;
//   - a child of an intermediate branch: that branch's PR head when it merged
//     (what was squashed into *its* parent).
//
// Fail closed. "covered" needs proof: the commit is an ancestor, a commit
// there has its patch-id, or the tree holds every file it wrote at the blob it
// wrote. "missing" needs proof too: the tree holds every file it touched
// exactly as it was *before* the commit. Anything in between is "unconfirmed",
// and a lookup that fails is "unverified". The caller must not merge on either
// without asking (and never under --yes).
import { $ } from "bun";
import * as git from "./git.ts";
import type { PrMergeResult } from "./github.ts";

export interface CollapsedChild {
  branch: string;
  pr: number;
  /** The stack parent it was squashed into. */
  parent: string;
  /** The parent's PR, when the parent isn't the base. */
  parentPr: number | null;
}

/**
 * A file a commit touched: its path, GitHub's status, its blob after the
 * commit (null if removed), and, when known, its blob before (null if added).
 */
export interface CommitFile {
  filename: string;
  status: string;
  sha: string | null;
  before?: string | null;
}

/** GitHub lookups, injected so the check runs against a local remote in tests. */
export interface CollapseLookup {
  prResult(
    pr: number,
  ): Promise<Pick<PrMergeResult, "state" | "baseRefName" | "headRefOid" | "mergeCommit"> | null>;
  commitPatch(sha: string): Promise<string | null>;
  /** The files a commit changed; null if unavailable or truncated. */
  commitFiles(sha: string): Promise<CommitFile[] | null>;
}

interface Placement {
  mergeCommit: string;
  /** The commit that should contain it, and what that is ("origin/pr1", "PR #2's merged head"). */
  container: string;
  containerLabel: string;
}

export type CollapseVerdict =
  | { child: CollapsedChild; status: "covered" }
  /** Proven absent: every file it touched is still as it was before it. */
  | ({ child: CollapsedChild; status: "missing"; fetchable: boolean } & Placement)
  /** Compared, but neither proof held: maybe there, maybe not. */
  | ({
      child: CollapsedChild;
      status: "unconfirmed";
      reason: string;
      transient: boolean;
    } & Placement)
  /** Couldn't get far enough to compare. */
  | { child: CollapsedChild; status: "unverified"; reason: string; transient: boolean };

export async function verifyCollapse(opts: {
  base: string;
  trunkRef: string;
  children: CollapsedChild[];
  lookup: CollapseLookup;
}): Promise<CollapseVerdict[]> {
  const { base, trunkRef, children, lookup } = opts;
  const shallow =
    (await $`git rev-parse --is-shallow-repository`.nothrow().quiet()).stdout.toString().trim() ===
    "true";

  // GitHub lookups: each PR once (a parent is also a child), all at once.
  const prs = new Map<number, ReturnType<CollapseLookup["prResult"]>>();
  const pr = (n: number) => {
    if (!prs.has(n))
      prs.set(
        n,
        lookup.prResult(n).catch(() => null),
      );
    return prs.get(n)!;
  };
  await Promise.all(
    children.flatMap((c) => [pr(c.pr), ...(c.parentPr != null ? [pr(c.parentPr)] : [])]),
  );

  const heads = await git.remoteHeads();
  const baseTip = heads.get(base) ?? null;
  if (baseTip) await git.fetchObjectsOnly([`refs/heads/${base}`]);

  // The git side runs one child at a time: concurrent fetches into one
  // repository contend for the same pack and ref locks.
  const verdicts: CollapseVerdict[] = [];
  for (const child of children) {
    const result = await pr(child.pr);
    if (!result) {
      verdicts.push({
        child,
        status: "unverified",
        reason: `couldn't read PR #${child.pr} from GitHub`,
        transient: true,
      });
      continue;
    }
    if (result.state !== "MERGED" || !result.mergeCommit) {
      verdicts.push({
        child,
        status: "unverified",
        reason: "GitHub reports no merge commit for it",
        transient: false,
      });
      continue;
    }
    if (result.baseRefName !== child.parent) {
      verdicts.push({
        child,
        status: "unverified",
        reason: `it merged into ${result.baseRefName}, not ${child.parent}`,
        transient: false,
      });
      continue;
    }

    // What should contain the squash commit.
    let container: string | null;
    let containerLabel: string;
    if (child.parent === base) {
      container = baseTip;
      containerLabel = `origin/${base}`;
    } else {
      const parentResult = child.parentPr != null ? await pr(child.parentPr) : null;
      const merged = parentResult?.state === "MERGED";
      container = merged ? parentResult.headRefOid : (heads.get(child.parent) ?? null);
      containerLabel = merged ? `PR #${child.parentPr}'s merged head` : `origin/${child.parent}`;
      if (container && !(await hasCommit(container))) await git.fetchObjectsOnly([container]);
    }
    if (!container || !(await hasCommit(container))) {
      verdicts.push({
        child,
        status: "unverified",
        reason: `couldn't fetch ${containerLabel}`,
        transient: true,
      });
      continue;
    }

    const squash = result.mergeCommit;
    const placement = { mergeCommit: squash, container, containerLabel };
    if (!(await hasCommit(squash))) await git.fetchObjectsOnly([squash]);
    const fetchable = await hasCommit(squash);

    // The commit and its patch from our own objects when we have them,
    // otherwise from GitHub (an orphaned squash commit usually can't be fetched).
    let patchId: string | null;
    let files: CommitFile[] | null;
    let historyChecked = false;
    if (fetchable) {
      if (await git.isAncestor(squash, container)) {
        verdicts.push({ child, status: "covered" });
        continue;
      }
      patchId = await patchIdOf(squash);
      files = await localCommitFiles(squash);
      historyChecked = !shallow;
    } else {
      const patch = await lookup.commitPatch(squash).catch(() => null);
      patchId = patch === null ? null : await patchIdFromText(patch);
      files = await lookup.commitFiles(squash).catch(() => null);
      // Fetching the container brought all its ancestors, so in a full clone
      // a squash commit we still don't have isn't one of them.
      historyChecked = !shallow;
    }

    if ((await patchIdIn(patchId, container, trunkRef)) || (await filesIn(files, container))) {
      verdicts.push({ child, status: "covered" });
      continue;
    }
    if (await filesAsBefore(files, container)) {
      verdicts.push({ child, status: "missing", fetchable, ...placement });
      continue;
    }

    const gaps: string[] = [];
    if (!historyChecked) {
      gaps.push(
        "the repository is shallow, so its history couldn't be searched (git fetch --unshallow)",
      );
    }
    if (patchId === null) gaps.push("its patch couldn't be read");
    if (files === null) gaps.push("its file list couldn't be read");
    if (files !== null) {
      gaps.push(
        "its files there match neither its own version nor the one before it (they may have changed since)",
      );
    }
    verdicts.push({
      child,
      status: "unconfirmed",
      reason: gaps.join("; "),
      // A GitHub read that failed may succeed on a retry.
      transient: !fetchable && (patchId === null || files === null),
      ...placement,
    });
  }
  return verdicts;
}

async function hasCommit(sha: string): Promise<boolean> {
  return git.refExists(`${sha}^{commit}`);
}

async function patchIdOf(sha: string): Promise<string | null> {
  const { stdout } = await $`git show ${sha} | git patch-id --stable`.nothrow().quiet();
  return stdout.toString().trim().split(" ")[0] || null;
}

async function patchIdFromText(patch: string): Promise<string | null> {
  const { stdout } = await $`git patch-id --stable < ${new Response(patch)}`.nothrow().quiet();
  return stdout.toString().trim().split(" ")[0] || null;
}

/** Whether a commit with this patch-id is among `container`'s own commits (above the trunk). */
async function patchIdIn(id: string | null, container: string, trunkRef: string): Promise<boolean> {
  if (!id) return false;
  const exclude = (await git.refExists(trunkRef)) ? [`^${trunkRef}`] : [];
  const { stdout } =
    await $`git log -p --no-merges --max-count=2000 ${container} ${exclude} | git patch-id --stable`
      .nothrow()
      .quiet();
  return stdout
    .toString()
    .split("\n")
    .some((line) => line.split(" ")[0] === id);
}

const NO_BLOB = /^0+$/;

/**
 * The files a local commit touched, with blobs before and after. NUL-separated
 * (-z) so paths come back raw, exactly as GitHub's API reports them.
 */
export async function localCommitFiles(sha: string): Promise<CommitFile[] | null> {
  const { stdout, exitCode } = await $`git diff-tree -r -z --no-commit-id --root ${sha}`
    .nothrow()
    .quiet();
  if (exitCode !== 0) return null;
  // -z: ":<old mode> <new mode> <old blob> <new blob> <status>\0<path>\0" per file.
  const parts = stdout.toString().split("\0");
  const files: CommitFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!.replace(/^:/, "").split(" ");
    const [, , oldBlob, newBlob, status] = meta;
    if (!status) continue;
    files.push({
      filename: parts[i + 1]!,
      status: status === "A" ? "added" : status === "D" ? "removed" : "modified",
      sha: NO_BLOB.test(newBlob!) ? null : newBlob!,
      before: NO_BLOB.test(oldBlob!) ? null : oldBlob!,
    });
  }
  return files;
}

/** Each path's blob in `tree` (absent paths are missing from the map). */
async function blobsAt(tree: string, paths: string[]): Promise<Map<string, string> | null> {
  const { stdout, exitCode } = await $`git --literal-pathspecs ls-tree -r -z ${tree} -- ${paths}`
    .nothrow()
    .quiet();
  if (exitCode !== 0) return null;
  const blobs = new Map<string, string>();
  for (const entry of stdout.toString().split("\0").filter(Boolean)) {
    // "<mode> <type> <blob>\t<path>"
    const tab = entry.indexOf("\t");
    blobs.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]!);
  }
  return blobs;
}

/**
 * Whether `container` holds every file `files` wrote, at the blob it wrote
 * (and none it removed): the content is there even if the commit was
 * rewritten. False when unsure, which never by itself means missing.
 */
async function filesIn(files: CommitFile[] | null, container: string): Promise<boolean> {
  if (!files || files.length === 0) return false;
  const blobs = await blobsAt(
    container,
    files.map((f) => f.filename),
  );
  if (!blobs) return false;
  return files.every((f) =>
    f.status === "removed"
      ? !blobs.has(f.filename)
      : f.sha !== null && blobs.get(f.filename) === f.sha,
  );
}

/**
 * Whether `container` holds every file `files` touched exactly as it was
 * *before* the commit: positive evidence its changes aren't there. Needs the
 * "before" of every file (GitHub's API only gives that for added files).
 */
async function filesAsBefore(files: CommitFile[] | null, container: string): Promise<boolean> {
  if (!files || files.length === 0 || files.some((f) => f.before === undefined)) return false;
  const blobs = await blobsAt(
    container,
    files.map((f) => f.filename),
  );
  if (!blobs) return false;
  return files.every((f) =>
    f.before === null ? !blobs.has(f.filename) : blobs.get(f.filename) === f.before,
  );
}
