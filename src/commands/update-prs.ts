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
import {
  findOpenPrForBranch,
  getPrInfo,
  getPrBody,
  updatePrBody,
  updatePrTitle,
  getRepoNwo,
  prUrlFor,
} from "../lib/github.ts";
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

/**
 * Whether a live PR body already carries exactly this viz block. GitHub
 * stores bodies edited in its web UI with CRLF line endings, so normalize
 * before comparing — otherwise every such PR would look perpetually stale.
 */
export function bodyHasViz(body: string, viz: string): boolean {
  return body.replace(/\r\n/g, "\n").includes(viz);
}

/**
 * Record PR numbers for tracked branches whose PR was opened outside gh-stack
 * (e.g. `gh pr create`), by looking up the open PR for each PR-less branch.
 * Only an unambiguous single match is adopted. Returns the branches adopted —
 * the caller persists metadata when non-empty. (#35)
 */
export async function discoverMissingPrs(stack: Stack, ordered: string[]): Promise<string[]> {
  const missing = ordered.filter((b) => stack.branches[b]!.pr == null);
  const found = await mapLimit(missing, 8, async (branch) => {
    const pr = await findOpenPrForBranch(branch);
    if (pr == null) return null;
    stack.branches[branch]!.pr = pr;
    return branch;
  });
  return found.filter((b): b is string => b != null);
}

/** Splice the rendered viz block into a PR body, replacing any existing one. */
function mergeViz(body: string, viz: string): string {
  let base = body;
  const idx = base.indexOf("### 📚 Stacked on");
  if (idx !== -1) base = base.slice(0, idx).trimEnd();
  return base ? `${base}\n\n${viz}` : viz;
}

// ── PR-title stack numbering ──
//
// The stack position lives in the PR title as a ` (N/M)` suffix so reviewers
// can see order from a bare "needs review" list (parens, not brackets, to avoid
// colliding with `[BEE-1234]` ticket tags). The cached `prTitle` tracks exactly
// what's on GitHub; we recover the base title by stripping the suffix and
// re-applying the current position, so reordering/adding a branch renumbers the
// whole stack and a no-op re-submit touches nothing.

/** Matches a trailing ` (N/M)` stack-position suffix, e.g. " (2/4)". */
const SEQ_SUFFIX = /\s*\(\d+\/\d+\)\s*$/;

/** Strip a trailing ` (N/M)` suffix to recover the base PR title. */
export function stripSeqSuffix(title: string): string {
  return title.replace(SEQ_SUFFIX, "").trimEnd();
}

/** The title a branch at `position` of `total` should have. Idempotent. */
export function numberedTitle(title: string, position: number, total: number): string {
  const base = stripSeqSuffix(title);
  return total >= 2 ? `${base} (${position}/${total})` : base;
}

export interface TitleResult {
  updated: number; // PR titles we edited on GitHub
  updatedBranches: string[]; // …and their branches, for per-branch reporting (submit --json)
  dirty: boolean; // metadata mutated (cached prTitle changed) — caller persists
}

/**
 * Decide which PR titles need editing and to what. Pure (no network) so it's
 * unit-testable. `items` must be the whole stack in order — the index drives
 * the `(N/M)` position. The base title is an explicit `override` (from
 * `submit -t`) when given, else the cached `prTitle`; a branch with neither a
 * PR nor a known base is skipped (never guess from the branch name). An edit is
 * emitted only when the desired title differs from what's cached/on GitHub.
 */
export function planTitleEdits<
  T extends { pr?: number | null; prTitle?: string; override?: string },
>(items: T[]): { item: T; desired: string }[] {
  const total = items.length;
  const edits: { item: T; desired: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.pr == null) continue;
    const base = it.override ?? it.prTitle;
    if (!base) continue;
    const desired = numberedTitle(base, i + 1, total);
    if (desired !== it.prTitle) edits.push({ item: it, desired });
  }
  return edits;
}

/**
 * Reconcile every PR title in the stack to carry its `(N/M)` stack position.
 * Backfills any missing cached titles first (so we never clobber a real GitHub
 * title with a branch-name guess), then edits only the titles that actually
 * changed — a no-op re-submit makes zero edits, while adding/reordering a
 * branch renumbers the whole stack. Run BEFORE refreshStackViz so the viz shows
 * numbered titles.
 *
 * `titleOverrides` (branch → new base title) lets `submit -t` set the current
 * branch's title; the override is renumbered like any other title and the
 * cache is kept in sync.
 */
export async function reconcilePrTitles(
  stack: Stack,
  ordered: string[],
  opts: { titleOverrides?: Record<string, string> } = {},
): Promise<TitleResult> {
  const dirtyBackfill = await backfillTitles(stack, ordered);
  const overrides = opts.titleOverrides ?? {};

  const items = ordered.map((name) => {
    const bm = stack.branches[name]!;
    return { name, pr: bm.pr, prTitle: bm.prTitle, override: overrides[name], bm };
  });

  const edits = planTitleEdits(items);
  const oks = await mapLimit(edits, 8, async ({ item, desired }) => {
    const ok = await updatePrTitle(item.pr!, desired);
    if (ok) item.bm.prTitle = desired;
    return ok;
  });

  const updatedBranches = edits.filter((_, i) => oks[i]).map(({ item }) => item.name);
  const updated = updatedBranches.length;
  return { updated, updatedBranches, dirty: dirtyBackfill || updated > 0 };
}

export interface VizResult {
  updated: number; // PRs whose description we PATCHed
  updatedBranches: string[]; // …and their branches, for per-branch reporting (submit --json)
  unchanged: number; // PRs skipped because their rendered block was identical
  skipped: number; // branches with no PR
  skippedBranches: string[]; // …and their names, so callers can say which
  dirty: boolean; // metadata mutated (caller should persist)
}

/**
 * Refresh the stack visualization across a stack's PRs. Renders every block
 * locally, then PATCHes only the PRs whose block actually changed (unless
 * `force`), running the surviving PATCHes concurrently.
 *
 * `bodyOverrides` (branch → new description) lets `submit -b` replace a PR's
 * body: the override is used as the base instead of the current GitHub body,
 * the managed `📚 Stacked on` block is re-merged into it, and the PR is updated
 * even if the viz block itself didn't change.
 *
 * `verifyLive` checks each PR whose cached hash matches against its actual
 * body, so a viz block removed by an external edit (`gh pr edit`, the web UI)
 * is restored rather than reported "unchanged". It costs one read per PR, so
 * `update-prs` opts in while `submit` stays on the cheap hash check. (#34)
 */
export async function refreshStackViz(
  meta: StackMetadata,
  stack: Stack,
  ordered: string[],
  opts: { force?: boolean; verifyLive?: boolean; bodyOverrides?: Record<string, string> } = {},
): Promise<VizResult> {
  const force = opts.force ?? false;
  const bodyOverrides = opts.bodyOverrides ?? {};
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
      // A body override forces the PATCH even when the viz block is unchanged.
      const overridden = bodyOverrides[info.branch] != null;
      const needsUpdate = force || overridden || bm.vizHash !== hash;
      return { info, viz, hash, bm, needsUpdate, liveBody: null as string | null };
    });

  if (opts.verifyLive) {
    await mapLimit(
      plans.filter((plan) => !plan.needsUpdate),
      8,
      async (plan) => {
        const body = await getPrBody(plan.info.prNumber!);
        if (body !== null && !bodyHasViz(body, plan.viz)) {
          plan.needsUpdate = true;
          plan.liveBody = body;
        }
      },
    );
  }

  const toUpdate = plans.filter((plan) => plan.needsUpdate);
  const unchanged = plans.length - toUpdate.length;
  const skippedBranches = branchInfos.filter((b) => b.prNumber == null).map((b) => b.branch);
  const skipped = skippedBranches.length;

  const oks = await mapLimit(toUpdate, 8, async (plan) => {
    // `submit -b` replaces the body; otherwise keep the PR's current body and
    // just re-merge the viz block into it.
    const override = bodyOverrides[plan.info.branch];
    const body = override ?? plan.liveBody ?? (await getPrBody(plan.info.prNumber!));
    if (body === null) return false;
    const ok = await updatePrBody(plan.info.prNumber!, mergeViz(body, plan.viz));
    if (ok) plan.bm.vizHash = plan.hash;
    return ok;
  });

  const updatedBranches = toUpdate.filter((_, i) => oks[i]).map((plan) => plan.info.branch);
  const updated = updatedBranches.length;
  if (updated > 0) dirty = true;

  return { updated, updatedBranches, unchanged, skipped, skippedBranches, dirty };
}

export default async function updatePrs(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack update-prs — Update PR descriptions with stack visualization

USAGE
  gh-stack update-prs [--force]

Updates all PRs in the current stack with a standardized stack section
showing the tree structure, PR links, and per-PR stack index. Each PR's
live description is checked, so a stack section removed by an outside
edit (gh pr edit, the GitHub UI) is restored. PRs that already show the
current section are left alone; --force rewrites all.

Tracked branches with no recorded PR are looked up on GitHub first, so a
PR opened outside gh-stack (e.g. gh pr create) is adopted automatically.
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
  s.start("Updating PR titles & descriptions...");
  const adopted = await discoverMissingPrs(stack, ordered);
  const titles = await reconcilePrTitles(stack, ordered);
  const result = await refreshStackViz(meta, stack, ordered, { force, verifyLive: true });
  s.stop("Done");

  if (adopted.length > 0 || titles.dirty || result.dirty) await writeMetadata(meta);

  for (const b of adopted) {
    p.log.success(
      `Adopted PR #${stack.branches[b]!.pr} for ${pc.blue(b)} (opened outside gh-stack)`,
    );
  }
  if (result.skippedBranches.length > 0) {
    p.log.warn(
      `Skipped ${result.skippedBranches.length} branch(es) with no open PR: ${result.skippedBranches.map((b) => pc.blue(b)).join(", ")}\n` +
        `  Open them with ${pc.green("gh-stack submit")}`,
    );
  }

  console.log();
  p.outro(
    pc.green(
      `Updated ${result.updated} description(s), ${titles.updated} title(s)` +
        (result.unchanged > 0 ? `, ${result.unchanged} already up to date` : "") +
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

    // No leading `N.` — the stack position now lives in the PR title itself as
    // a `(N/M)` suffix (see reconcilePrTitles), so the tree just shows titles.
    lines.push(`${tree} ${prLink} ${info.prTitle}${marker}`);

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
