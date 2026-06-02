// Filesystem layout for v3 metadata, all under `.git/.gh-stack/`.
//
//   .git/.gh-stack/
//     current                      hint: last-active stack name (a cache, not truth)
//     active/<stack>.json          topology of a live stack
//     archived/<stack>.json        merged/closed stacks
//     deleted/<stack>.json         tombstones (recoverable)
//     snapshots/<ts>__<stack>.json append-only pre-operation branch tips
//     restack-state.json           in-flight restack/sync resume state
//
// Everything lives inside `.git/` and is never committed — gh-stack is a
// single-developer tool, so there's no need to share metadata across clones.
import { gitDir } from "./git.ts";

let cachedGitDir: string | null = null;

async function getGitDir(): Promise<string> {
  if (!cachedGitDir) cachedGitDir = await gitDir();
  return cachedGitDir;
}

/** Root of the v3 metadata folder. */
export async function ghStackDir(): Promise<string> {
  return `${await getGitDir()}/.gh-stack`;
}

export async function activeDir(): Promise<string> {
  return `${await ghStackDir()}/active`;
}
export async function archivedDir(): Promise<string> {
  return `${await ghStackDir()}/archived`;
}
export async function deletedDir(): Promise<string> {
  return `${await ghStackDir()}/deleted`;
}
export async function snapshotsDir(): Promise<string> {
  return `${await ghStackDir()}/snapshots`;
}
export async function currentFile(): Promise<string> {
  return `${await ghStackDir()}/current`;
}
export async function restackStateFile(): Promise<string> {
  return `${await ghStackDir()}/restack-state.json`;
}

/** Legacy v2 monolith path (pre-migration). */
export async function legacyMetadataPath(): Promise<string> {
  return `${await getGitDir()}/gh-stack-metadata.json`;
}

/** Legacy v2 restack-state path (pre-migration). */
export async function legacyRestackStatePath(): Promise<string> {
  return `${await getGitDir()}/.gh-stack-sync-state`;
}

// Stack names come from branch names, which can contain `/` and other chars
// that aren't filesystem-safe. Encode to a flat, reversible filename.
export function stackFileName(stack: string): string {
  return `${encodeURIComponent(stack)}.json`;
}

export function stackNameFromFile(file: string): string {
  return decodeURIComponent(file.replace(/\.json$/, ""));
}

// For test isolation: forget the memoized git dir.
export function resetGitDirCache(): void {
  cachedGitDir = null;
}
