// Recognize a commit whose change already reached the rebase target through
// another commit (#79).
//
// The usual source is a cherry-picked copy: a stack branch carries a copy of a
// commit from another PR, that PR squash-merges, and the next sync replays the
// copy onto a main that already holds it. git drops a copy whose patch matches
// exactly, but real copies are usually older versions of the commit (the
// original PR was amended after the copy was taken), sometimes with a new
// subject, so the replay stops on an add/add or content conflict.
//
// A copy is told apart from real work by two things together:
//   1. one commit the target gained since the branch's base touched every file
//      the copy touches (the squash that landed it), and
//   2. nearly all the lines the copy adds are already in the target's version
//      of those files.
// Measured on the swarm copies from Nov 11 (ENT-948, ENT-951, ENT-960): 91-100%
// of their added lines were on main; the real commits that conflicted in the
// same syncs had 0-22%.
import { $ } from "bun";

/** Share of a commit's significant added lines that must already be on the target. */
export const LANDED_SHARE = 0.8;
/** Below this many significant added lines there's too little evidence to judge. */
export const MIN_ADDED_LINES = 3;

export interface LandedCopy {
  commit: string;
  subject: string;
  /** The target's commit that touched every file the copy touches. */
  via: { sha: string; subject: string };
  added: number;
  present: number;
  /** Files where the copy's version differs from the target's: the target's is kept. */
  differs: string[];
}

interface TargetCommit {
  sha: string;
  subject: string;
  files: Set<string>;
}

/**
 * Whether `commit`, stopped on a conflict while rebasing onto `onto`, is a
 * copy of a change `onto` already has. `since` bounds the search: only
 * commits on `onto` that `since` lacks can have landed it. Null means it
 * isn't (or there's not enough evidence to say it is).
 */
export async function landedCopy(
  commit: string,
  onto: string,
  since: string,
  cwd?: string,
): Promise<LandedCopy | null> {
  const files = await changedFiles(commit, cwd);
  if (files.length === 0) return null;

  const via = (await targetCommits(onto, since, cwd)).find((t) =>
    files.every((f) => t.files.has(f)),
  );
  if (!via) return null;

  let added = 0;
  let present = 0;
  for (const [file, lines] of await addedLines(commit, cwd)) {
    const there = lineCounts(await fileAt(onto, file, cwd));
    for (const line of lines) {
      added++;
      const n = there.get(line) ?? 0;
      if (n > 0) {
        present++;
        there.set(line, n - 1);
      }
    }
  }
  if (added < MIN_ADDED_LINES || present < added * LANDED_SHARE) return null;

  const differs: string[] = [];
  for (const file of files) {
    const same = await git(["diff", "--quiet", commit, onto, "--", file], cwd);
    if (same.exitCode !== 0) differs.push(file);
  }
  return {
    commit,
    subject: (await git(["log", "-1", "--format=%s", commit], cwd)).stdout.trim(),
    via: { sha: via.sha, subject: via.subject },
    added,
    present,
    differs,
  };
}

/**
 * A line worth counting: trimmed, at least 4 characters with a letter or
 * digit. Braces, `end` and blank lines match anywhere and prove nothing.
 */
export function significant(line: string): string | null {
  const t = line.trim();
  return t.length >= 4 && /[A-Za-z0-9]/.test(t) ? t : null;
}

async function git(args: string[], cwd?: string) {
  let shell = $`git ${args}`.quiet().nothrow();
  if (cwd) shell = shell.cwd(cwd);
  const r = await shell;
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
}

async function changedFiles(commit: string, cwd?: string): Promise<string[]> {
  const out = await git(
    ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", commit],
    cwd,
  );
  return out.stdout.split("\0").filter(Boolean);
}

/** Commits on `onto` that `since` lacks, newest first, with the files each touched. */
async function targetCommits(onto: string, since: string, cwd?: string): Promise<TargetCommit[]> {
  const out = await git(
    [
      "log",
      "--no-merges",
      "--no-renames",
      "--name-only",
      "-z",
      "--format=%x1e%H%x1f%s",
      onto,
      `^${since}`,
    ],
    cwd,
  );
  // Each record: "<sha>\x1f<subject>\0", then "\n" and each file NUL-terminated.
  return out.stdout
    .split("\x1e")
    .slice(1)
    .map((record) => {
      const [head = "", ...files] = record.split("\0");
      const [sha = "", subject = ""] = head.split("\x1f");
      return {
        sha,
        subject,
        files: new Set(files.map((f) => f.replace(/^\n/, "")).filter(Boolean)),
      };
    });
}

/** The significant lines `commit` adds, per file. */
async function addedLines(commit: string, cwd?: string): Promise<Map<string, string[]>> {
  const out = await git(["show", "--format=", "-U0", "--no-renames", "--no-color", commit], cwd);
  const byFile = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      current = path === "/dev/null" ? null : [];
      if (current) byFile.set(path.replace(/^b\//, ""), current);
    } else if (line.startsWith("+") && current) {
      const s = significant(line.slice(1));
      if (s) current.push(s);
    }
  }
  return byFile;
}

async function fileAt(ref: string, file: string, cwd?: string): Promise<string> {
  const out = await git(["cat-file", "blob", `${ref}:${file}`], cwd);
  return out.exitCode === 0 ? out.stdout : "";
}

function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const s = significant(line);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}
