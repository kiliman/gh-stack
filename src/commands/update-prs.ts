// gh-stack update-prs — Update PR descriptions with stack visualization
//
// The visualization is rendered entirely from local metadata (PR number,
// cached title, stack position) plus a single repo-identity lookup for URLs —
// no per-PR API call. `submit` reuses `refreshStackViz` and skips PATCHing any
// PR whose rendered block hasn't changed (see issue #16). Review/CI status is
// intentionally NOT shown here; that's tracked out-of-band.
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { createHash } from "node:crypto";
import * as git from "../lib/git.ts";
import {
  findStackForBranch,
  getOrderedBranches,
  stackBase,
  writeMetadata,
} from "../lib/metadata.ts";
import { ensureMetadata } from "../lib/safety.ts";
import { getPrInfo, getPrBody, updatePrBody, getRepoNwo, prUrlFor } from "../lib/github.ts";
import type { StackMetadata, Stack } from "../types.ts";

/** The ref a stack is rooted on, for rendering the base node of the viz. */
export interface BaseRef {
  label: string; // "main" or a branch name (for split stacks)
  prNumber?: number | null;
  prUrl?: string | null;
}

export interface BranchPrInfo {
  branch: string;
  prNumber: number | null;
  prTitle: string;
  prUrl: string | null;
}

/** Derive a readable PR title from a branch name (fallback when uncached). */
export function branchToTitle(branch: string): string {
  let name = branch.includes("/") ? branch.split("/").slice(1).join("/") : branch;
  name = name.replace(/-/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Resolve the base node for a stack's visualization. For a split stack whose
 * base is a branch in another stack, link to that branch's PR. The URL is
 * constructed locally from the repo identity — no API call.
 */
export async function resolveBaseRef(
  meta: StackMetadata,
  stack: Stack,
  nwo: string | null,
): Promise<BaseRef> {
  const base = stackBase(stack);
  if (base === "main" || base === "master") return { label: base };

  const ownerName = findStackForBranch(meta, base);
  const prNumber = ownerName ? (meta.stacks[ownerName]?.branches[base]?.pr ?? null) : null;
  return { label: base, prNumber, prUrl: prNumber ? prUrlFor(nwo, prNumber) : null };
}

/** Build a BranchPrInfo from metadata alone (no network). */
function toBranchInfo(stack: Stack, branch: string, nwo: string | null): BranchPrInfo {
  const bm = stack.branches[branch]!;
  const prNumber = bm.pr ?? null;
  return {
    branch,
    prNumber,
    prTitle: bm.prTitle || bm.description || branchToTitle(branch),
    prUrl: prNumber ? prUrlFor(nwo, prNumber) : null,
  };
}

/**
 * Fill in missing cached PR titles (one-time, e.g. right after migrating to v3
 * or adopting existing PRs). Fetches only the branches that lack a title, in
 * parallel; subsequent submits read straight from the cache. Returns true if
 * any title was written.
 */
async function backfillTitles(stack: Stack, ordered: string[]): Promise<boolean> {
  const missing = ordered.filter((b) => {
    const bm = stack.branches[b]!;
    return bm.pr != null && !bm.prTitle;
  });
  if (missing.length === 0) return false;

  await mapLimit(missing, 8, async (branch) => {
    const bm = stack.branches[branch]!;
    const info = await getPrInfo(bm.pr!);
    if (info?.title) bm.prTitle = info.title;
  });
  return true;
}

function vizHash(viz: string): string {
  return createHash("sha1").update(viz).digest("hex");
}

/** Splice the rendered viz block into a PR body, replacing any existing one. */
function mergeViz(body: string, viz: string): string {
  let base = body;
  const idx = base.indexOf("### 📚 Stacked on");
  if (idx !== -1) base = base.slice(0, idx).trimEnd();
  return base ? `${base}\n\n${viz}` : viz;
}

export interface VizResult {
  updated: number; // PRs whose description we PATCHed
  unchanged: number; // PRs skipped because their rendered block was identical
  skipped: number; // branches with no PR
  dirty: boolean; // metadata mutated (caller should persist)
}

/**
 * Refresh the stack visualization across a stack's PRs. Renders every block
 * locally, then PATCHes only the PRs whose block actually changed (unless
 * `force`), running the surviving PATCHes concurrently.
 */
export async function refreshStackViz(
  meta: StackMetadata,
  stack: Stack,
  ordered: string[],
  opts: { force?: boolean } = {},
): Promise<VizResult> {
  const force = opts.force ?? false;
  const nwo = await getRepoNwo();

  let dirty = await backfillTitles(stack, ordered);

  const branchInfos = ordered.map((b) => toBranchInfo(stack, b, nwo));
  const baseRef = await resolveBaseRef(meta, stack, nwo);

  // Render every block locally and decide what needs writing — no network yet.
  const plans = branchInfos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => info.prNumber != null)
    .map(({ info, i }) => {
      const viz = buildStackViz(branchInfos, i, baseRef);
      const hash = vizHash(viz);
      const bm = stack.branches[info.branch]!;
      return { info, viz, hash, bm, needsUpdate: force || bm.vizHash !== hash };
    });

  const toUpdate = plans.filter((plan) => plan.needsUpdate);
  const unchanged = plans.length - toUpdate.length;
  const skipped = branchInfos.length - plans.length;

  const oks = await mapLimit(toUpdate, 8, async (plan) => {
    const body = await getPrBody(plan.info.prNumber!);
    if (body === null) return false;
    const ok = await updatePrBody(plan.info.prNumber!, mergeViz(body, plan.viz));
    if (ok) plan.bm.vizHash = plan.hash;
    return ok;
  });

  const updated = oks.filter(Boolean).length;
  if (updated > 0) dirty = true;

  return { updated, unchanged, skipped, dirty };
}

export default async function updatePrs(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack update-prs — Update PR descriptions with stack visualization

USAGE
  gh-stack update-prs [--force]

Updates all PRs in the current stack with a standardized stack section
showing the tree structure, PR links, and per-PR stack index. By default
PRs whose rendered block is unchanged are skipped; --force rewrites all.
`);
    return;
  }

  const force = args.includes("--force");
  const meta = await ensureMetadata();
  const branch = await git.currentBranch();
  const stackName = findStackForBranch(meta, branch);

  if (!stackName) {
    p.cancel(`Branch ${pc.blue(branch)} not found in any stack`);
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);

  p.intro(pc.cyan("Update PR Descriptions"));
  p.log.info(`Stack: ${pc.yellow(stackName)}`);
  p.log.info(`Found ${ordered.length} branch(es) in stack`);
  console.log();

  const s = p.spinner();
  s.start("Updating PR descriptions...");
  const result = await refreshStackViz(meta, stack, ordered, { force });
  s.stop("Done");

  if (result.dirty) await writeMetadata(meta);

  console.log();
  p.outro(
    pc.green(
      `Updated ${result.updated} PR(s)` +
        (result.unchanged > 0 ? `, ${result.unchanged} unchanged` : "") +
        (result.skipped > 0 ? `, ${result.skipped} without PRs` : ""),
    ),
  );
}

export function buildStackViz(
  branches: BranchPrInfo[],
  targetIndex: number,
  base: BaseRef = { label: "main" },
): string {
  const lines: string[] = ["### 📚 Stacked on", ""];

  // Base node: link to the base PR if there is one (split stacks), else the
  // plain ref name. `**bold**` renders in markdown but not inside <pre>.
  const baseLink = base.prNumber
    ? `${base.prUrl ? `<a href="${base.prUrl}">#${base.prNumber}</a>` : `#${base.prNumber}`} ${base.label}`
    : null;

  if (branches.length === 1) {
    lines.push(`- ⚫ ${baseLink ?? `**${base.label}**`}`);
    return lines.join("\n");
  }

  lines.push("<pre>");
  lines.push(`⚫ ${baseLink ?? base.label}`);
  lines.push("┃");

  for (let i = 0; i < branches.length; i++) {
    const info = branches[i]!;
    const isLast = i === branches.length - 1;
    const isTarget = i === targetIndex;

    // PR link
    let prLink: string;
    if (info.prNumber) {
      prLink = info.prUrl ? `<a href="${info.prUrl}">#${info.prNumber}</a>` : `#${info.prNumber}`;
    } else {
      prLink = "(no PR yet)";
    }

    // 👈 marker for the current PR
    const marker = isTarget ? " 👈" : "";

    // Tree character
    const tree = isLast ? "┗━" : "┣━";

    // Leading `N.` is the branch's 1-based position in the stack — makes it
    // easy to tell which PR is #6 in a 12-PR stack at a glance.
    lines.push(`${tree} ${i + 1}. ${prLink} ${info.prTitle}${marker}`);

    if (!isLast) {
      lines.push("┃");
    }
  }

  lines.push("</pre>");
  return lines.join("\n");
}

/** Run `fn` over `items` with at most `limit` concurrent in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
