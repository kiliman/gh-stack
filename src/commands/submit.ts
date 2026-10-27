// gh-stack submit — Push branches and create/update PRs
import * as p from "../lib/output.ts";
import pc from "picocolors";
import { $ } from "bun";
import * as git from "../lib/git.ts";
import {
  buildRebaseChain,
  findStackForBranch,
  getOrderedBranches,
  readMetadata,
  writeMetadata,
} from "../lib/metadata.ts";
import { isAutoYes } from "../lib/ui.ts";
import { ConfigError, describeSource, resolveFlag } from "../lib/config.ts";
import type { Stack, StackMetadata } from "../types.ts";
import { getPrNumber, getRepoNwo, prUrlFor } from "../lib/github.ts";
import { resolveOrCreateStack } from "../lib/chain.ts";
import { reconcilePrTitles, refreshStackViz, branchToTitle } from "./update-prs.ts";

const HELP = `
gh-stack submit — Push branches and create/update PRs

USAGE
  gh-stack submit [options]

Pushes all branches from trunk to the current branch, creating PRs
for branches that don't have them and updating stack visualization
in all PR descriptions. Idempotent — safe to run repeatedly.

Self-healing: if the current branch isn't tracked in a stack yet,
submit auto-detects the branch chain from trunk → current, registers
(or reconciles into) a stack, then pushes + creates PRs for the whole
chain. You never need to run \`gh-stack init\` first.

OPTIONS
  -d, --draft          Create new PRs as drafts (default: [submit] draft in
                       config, or GH_STACK_DRAFT; see gh-stack config)
      --no-draft       Create new PRs ready for review, overriding a draft default
  -n, --no-edit        Don't prompt for PR titles (auto-generate from branch name)
  -t, --title <title>  Set the PR title (current branch) — creates or updates
  -b, --body <body>    Set the PR body (current branch) — creates or updates
      --body-file <f>  Read PR body from a file
      --restack        After submitting, restack the branches above the current
                       one onto it (propagate a downstack fix up to children)
      --json           Print the result as JSON on stdout: each branch's PR
                       number, URL, and action (created/updated/unchanged/failed).
                       Logs go to stderr, uncolored. Implies --no-edit.
                       Not combinable with --restack or --dry-run
      --dry-run        Show what would happen without doing anything

Updating an existing PR: -t / -b also update the PR for the branch you're on
if it already exists — the title keeps its (N/M) stack position, and the body
is replaced with the "Stacked on" block re-merged in. Use this instead of
gh pr edit so the stack visualization is never clobbered.

JSON output (--json): stdout is one JSON document on every exit, success or
not, so a script or agent can capture the PRs it just created without a
follow-up \`gh pr view\`:
  { "stack": "...", "current_branch": "...",
    "branches": [{ "branch", "parent", "pr", "url", "title",
                   "action", "pushed", "draft", "error"? }],
    "error": null | { "message": "..." } }
"branches" is the submit scope (trunk → current), in stack order. "action" is
created (new PR), updated (pushed, or base/title/description edited),
unchanged, or failed (PR creation or push failed; see the entry's "error").
"draft" is true/false for PRs created this run and null otherwise. The
top-level "error" is set when the run stopped early (bad flags, nothing to
submit, a push failure); "branches" then holds what happened before it, and
"stack"/"current_branch" may be null. Exits 1 if "error" is set or any branch
failed. Not available with --dry-run or --restack (run \`gh-stack restack\`
separately).

Restack after submit (--restack): submit covers DOWNSTACK (trunk → current);
restack covers UPSTACK (the children above current). Together they sync the
whole stack from wherever you're standing. The common loop: drop downstack,
fix an issue, commit, then \`submit --restack\` to push the fix and propagate
it up — one command instead of two. Skips cleanly if nothing sits above you.

EXAMPLES
  gh-stack submit                              # Push + create PRs interactively
  gh-stack submit -n                           # Push + create PRs with auto-titles
  gh-stack submit -t "My PR" -b "Description"  # Explicit title and body
  gh-stack submit --restack                    # Submit, then restack children onto it
  gh-stack submit --draft                      # Create new PRs as drafts
  gh-stack submit --no-draft                   # Ready for review despite a draft default
  gh-stack submit --json -t "My PR" | jq '.branches[-1].url'   # URL of the PR
  gh-stack submit --dry-run                    # Preview what would happen
`;

// ── --json result ──

export type SubmitAction = "created" | "updated" | "unchanged" | "failed";

/** What the push/create phase did to one branch in scope. */
export interface BranchOutcome {
  branch: string;
  parent: string;
  pr: number | null;
  /** URL printed by `gh pr create`. Existing PRs get theirs from the repo nwo. */
  url: string | null;
  pushed: boolean;
  created: boolean;
  baseChanged: boolean;
  /** Whether a PR created this run was opened as a draft (null: not created). */
  draft: boolean | null;
  error: string | null;
}

export interface SubmitBranchJson {
  branch: string;
  parent: string;
  pr: number | null;
  url: string | null;
  title: string | null;
  action: SubmitAction;
  pushed: boolean;
  draft: boolean | null;
  error?: string;
}

export interface SubmitJson {
  stack: string | null;
  current_branch: string | null;
  branches: SubmitBranchJson[];
  /** Set when the run stopped early: bad flags, nothing to submit, a push failure. */
  error: { message: string } | null;
}

/**
 * Classify one branch's outcome. A PR is "updated" when it already existed and
 * this run changed it on GitHub: new commits pushed, base retargeted, or its
 * title/description edited (`edited`, from the reconcile + viz phases).
 */
export function submitAction(outcome: BranchOutcome, edited: ReadonlySet<string>): SubmitAction {
  if (outcome.error) return "failed";
  if (outcome.created) return "created";
  if (outcome.pushed || outcome.baseChanged || edited.has(outcome.branch)) return "updated";
  return "unchanged";
}

/**
 * What a run has established so far. Filled in as submit goes, so an early
 * exit can still report the stack, branch, and branches handled before it.
 */
export interface RunState {
  stackName: string | null;
  currentBranch: string | null;
  stack: Stack | null;
  outcomes: BranchOutcome[];
  /** Branches whose PR title or description was edited (reconcile + viz). */
  edited: ReadonlySet<string>;
}

/** Build the `submit --json` document. Pure, so the shape is unit-testable. */
export function buildSubmitJson(
  run: RunState & { error: string | null; nwo: string | null },
): SubmitJson {
  return {
    stack: run.stackName,
    current_branch: run.currentBranch,
    branches: run.outcomes.map((o) => {
      const entry: SubmitBranchJson = {
        branch: o.branch,
        parent: o.parent,
        pr: o.pr,
        url: o.url ?? (o.pr != null ? prUrlFor(run.nwo, o.pr) : null),
        title: run.stack?.branches[o.branch]?.prTitle ?? null,
        action: submitAction(o, run.edited),
        pushed: o.pushed,
        draft: o.draft,
      };
      if (o.error) entry.error = o.error;
      return entry;
    }),
    error: run.error ? { message: run.error } : null,
  };
}

/** Write the --json document to stdout, awaited so it's flushed before any exit. */
async function emitJson(run: RunState, error: string | null): Promise<SubmitJson> {
  // Only an existing PR (no URL from `gh pr create`) needs the repo's nwo, so
  // an early refusal makes no gh call at all.
  const needsNwo = run.outcomes.some((o) => o.pr != null && !o.url);
  const result = buildSubmitJson({ ...run, error, nwo: needsNwo ? await getRepoNwo() : null });
  await Bun.write(Bun.stdout, JSON.stringify(result, null, 2) + "\n");
  return result;
}

/** Stops a run with a message for the user. In --json mode it becomes `error`. */
class SubmitAbort extends Error {}

/**
 * Check if a local branch is up-to-date with its remote counterpart.
 */
async function isBranchUpToDate(branch: string): Promise<boolean> {
  try {
    const localSha = (await $`git rev-parse ${branch}`.text()).trim();
    const remoteSha = (await $`git rev-parse origin/${branch}`.text()).trim();
    return localSha === remoteSha;
  } catch {
    // Remote branch doesn't exist yet
    return false;
  }
}

/**
 * Push a branch to origin with upstream tracking and force-with-lease.
 */
async function pushBranch(branch: string): Promise<boolean> {
  try {
    await $`git push -u --force-with-lease origin ${branch}`.quiet();
    return true;
  } catch {
    return false;
  }
}

export default async function submit(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }

  // --json: logs and errors go to stderr (plain, and uncolored because index.ts
  // sets NO_COLOR before picocolors loads), so stdout carries only the JSON.
  const jsonMode = args.includes("--json");
  if (jsonMode) p.setStderrOnly();

  const run: RunState = {
    stackName: null,
    currentBranch: null,
    stack: null,
    outcomes: [],
    edited: new Set(),
  };
  let error: string | null = null;
  try {
    await runSubmit(args, run, jsonMode);
  } catch (err) {
    // A ConfigError (bad config file or env value) is an expected stop too: in
    // --json mode it becomes the document's error, like any refusal.
    const expected = err instanceof SubmitAbort || err instanceof ConfigError;
    if (!jsonMode && !expected) throw err;
    if (!expected) console.error(err);
    error = (err as Error).message;
    p.cancel(error);
    if (!jsonMode) process.exit(1);
  }

  if (jsonMode) {
    const result = await emitJson(run, error);
    if (result.error || result.branches.some((b) => b.action === "failed")) process.exitCode = 1;
  }
}

async function runSubmit(args: string[], run: RunState, jsonMode: boolean): Promise<void> {
  // Draft is create-time only: existing PRs keep whatever state they have.
  const draft = await resolveFlag("submit.draft", args);
  const draftFlag = draft.value;
  let draftNoted = false;
  const dryRun = args.includes("--dry-run");
  const restackFlag = args.includes("--restack");

  if (jsonMode && dryRun) {
    throw new SubmitAbort(
      "--json can't be combined with --dry-run: --json reports what submit did.",
    );
  }
  // restack runs git commands that write to stdout directly, so its output
  // can't be kept off the JSON channel.
  if (jsonMode && restackFlag) {
    throw new SubmitAbort(
      "--json can't be combined with --restack. Run `gh-stack restack` separately after submit.",
    );
  }

  // Parse value flags
  let titleFlag: string | undefined;
  let bodyFlag: string | undefined;
  let bodyFileFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--title" || args[i] === "-t") && args[i + 1]) {
      titleFlag = args[++i];
    } else if ((args[i] === "--body" || args[i] === "-b") && args[i + 1]) {
      bodyFlag = args[++i];
    } else if (args[i] === "--body-file" && args[i + 1]) {
      bodyFileFlag = args[++i];
    }
  }

  // Resolve body from file if provided
  if (bodyFileFlag && !bodyFlag) {
    try {
      bodyFlag = await Bun.file(bodyFileFlag).text();
    } catch {
      throw new SubmitAbort(`Could not read body file: ${bodyFileFlag}`);
    }
  }

  // --json callers are scripts and agents: nothing can answer a title prompt.
  const noEdit =
    args.includes("--no-edit") || args.includes("-n") || isAutoYes() || !!titleFlag || jsonMode;

  // Read metadata, or start with an empty in-memory store. submit self-heals,
  // so a missing metadata file is fine — we'll build the stack from local
  // branch ancestry and persist it (unless --dry-run).
  const meta: StackMetadata = (await readMetadata()) ?? {
    version: 2,
    current_stack: null,
    stacks: {},
  };
  const branch = await git.currentBranch();
  run.currentBranch = branch;
  let stackName = findStackForBranch(meta, branch);

  // ── Self-heal: branch isn't in any stack ──
  // Reconstruct the stack from local branch ancestry so the end state is
  // always stack registered + branches pushed + PRs created — no need to
  // remember to run `gh-stack init` first.
  let heal: { base: string; chain: string[]; created: boolean; added: string[] } | null = null;
  if (!stackName) {
    const trunk = await git.trunkBranch();

    if (branch === trunk || branch === "main" || branch === "master") {
      throw new SubmitAbort(
        `You're on ${pc.blue(branch)} — nothing to submit.\n\n  Checkout a feature branch first.`,
      );
    }

    let resolution;
    try {
      resolution = await resolveOrCreateStack(meta, branch, trunk);
    } catch (err) {
      throw new SubmitAbort((err as Error).message);
    }

    stackName = resolution.stackName;
    heal = {
      base: resolution.base,
      chain: resolution.chain,
      created: resolution.created,
      added: resolution.addedBranches,
    };

    // Persist the reconstructed/updated stack before pushing (skip on dry-run)
    if (!dryRun) await writeMetadata(meta);
  }

  const stack = meta.stacks[stackName]!;
  const ordered = getOrderedBranches(stack);
  run.stackName = stackName;
  run.stack = stack;

  // Determine downstack scope: branches from trunk up to and including current
  const currentIndex = ordered.indexOf(branch);
  const scope = currentIndex >= 0 ? ordered.slice(0, currentIndex + 1) : ordered;

  p.intro(pc.cyan("Submit Stack"));

  // Report self-heal results (stack creation / reconciliation + detected chain)
  if (heal) {
    if (heal.created) {
      p.log.success(
        `No stack found — created ${pc.yellow(stackName)} from ${heal.chain.length} local branch(es)`,
      );
    } else if (heal.added.length > 0) {
      const baseNote =
        heal.base === "main" || heal.base === "master" ? "" : ` (base: ${heal.base})`;
      p.log.success(
        `Adopted ${heal.added.length} untracked branch(es) into ${pc.yellow(stackName)}${pc.dim(baseNote)}`,
      );
    }

    p.print();
    p.print(`  ${pc.dim(heal.base)}`);
    for (let i = 0; i < heal.chain.length; i++) {
      const b = heal.chain[i]!;
      const isLast = i === heal.chain.length - 1;
      const tree = isLast ? "  ┗━" : "  ┣━";
      const isNew = heal.added.includes(b);
      const label = b === branch ? pc.yellow(b) + pc.dim(" (current)") : b;
      const tag = isNew ? pc.green(" +") : "";
      p.print(`${tree} ${label}${tag}`);
      if (!isLast) p.print("  ┃");
    }
    p.print();
  }

  p.log.info(`Stack: ${pc.yellow(stackName)}`);
  p.log.info(
    `Scope: ${scope.length} of ${ordered.length} branch(es) (downstack from ${pc.blue(branch)})`,
  );
  p.print();

  if (dryRun) {
    p.log.info(pc.dim("Dry run — no changes will be made"));
    p.print();
  }

  // ── Phase 1: Push branches and create/update PRs ──
  let pushed = 0;
  let created = 0;
  let existing = 0;
  let metadataChanged = false;
  const outcomes = run.outcomes;

  // The branch's PR: recorded in metadata, else looked up on GitHub. A PR
  // found that way (opened outside gh-stack) is recorded for next time.
  const findPr = async (name: string): Promise<number | null> => {
    const bm = stack.branches[name]!;
    if (bm.pr) return bm.pr;
    if (dryRun) return null;
    const found = await getPrNumber(name);
    if (found) {
      bm.pr = found;
      metadataChanged = true;
    }
    return found;
  };

  for (const branchName of scope) {
    const branchMeta = stack.branches[branchName]!;
    const parentBranch = branchMeta.parent;
    const outcome: BranchOutcome = {
      branch: branchName,
      parent: parentBranch,
      pr: null,
      url: null,
      pushed: false,
      created: false,
      baseChanged: false,
      draft: null,
      error: null,
    };
    outcomes.push(outcome);

    // ── Push (skip if already up-to-date) ──
    if (dryRun) {
      p.log.step(`${pc.dim("push")} ${branchName} → origin/${branchName}`);
    } else if (await isBranchUpToDate(branchName)) {
      p.log.info(`${pc.dim("✓")} ${pc.blue(branchName)} already up to date`);
    } else {
      const s = p.spinner();
      s.start(`Pushing ${pc.blue(branchName)}...`);
      const ok = await pushBranch(branchName);
      if (ok) {
        s.stop(`Pushed ${pc.blue(branchName)}`);
        pushed++;
        outcome.pushed = true;
      } else {
        s.stop(pc.red(`Failed to push ${branchName}`));
        outcome.error = `push to origin/${branchName} failed`;
        outcome.pr = await findPr(branchName);
        // Keep what this run learned (PRs created or discovered below this
        // branch, and this branch's own PR) before aborting.
        if (metadataChanged) await writeMetadata(meta);
        throw new SubmitAbort(`Push failed for ${pc.blue(branchName)}. Aborting.`);
      }
    }

    // ── Check for existing PR ──
    const prNumber = await findPr(branchName);
    outcome.pr = prNumber;

    if (prNumber) {
      // ── Existing PR: update base only if the parent actually changed ──
      existing++;
      if (dryRun) {
        p.log.step(`${pc.dim("exists")} PR #${prNumber} for ${branchName}`);
      } else {
        // Skip the network round-trip when the base we last set still matches
        // the current parent — the common case on a re-submit (issue #16).
        if (branchMeta.prBase !== parentBranch) {
          try {
            await $`gh pr edit ${prNumber} --base ${parentBranch}`.quiet();
            branchMeta.prBase = parentBranch;
            metadataChanged = true;
            outcome.baseChanged = true;
          } catch {
            // Best effort — base might already be correct
          }
        }
        p.log.info(`${pc.dim("✓")} PR #${prNumber} for ${pc.blue(branchName)}`);
      }
    } else {
      // ── Create new PR ──
      const defaultTitle = titleFlag || branchToTitle(branchName);
      let title = defaultTitle;

      if (!noEdit && !dryRun) {
        const input = await p.text({
          message: `PR title for ${pc.blue(branchName)}`,
          initialValue: defaultTitle,
          placeholder: defaultTitle,
        });
        if (p.isCancel(input)) {
          p.cancel("Cancelled");
          process.exit(0);
        }
        title = (input as string).trim() || defaultTitle;
      }

      const body = bodyFlag ?? "";

      if (dryRun) {
        p.log.step(
          `${pc.dim("create")} PR for ${branchName} → ${parentBranch} "${title}"${draftFlag ? " (draft)" : ""}`,
        );
        created++;
      } else {
        // A default (not a flag) decided draft vs ready: say which, once.
        if (!draftNoted && draft.source !== "flag" && draft.source !== "default") {
          draftNoted = true;
          p.log.info(
            pc.dim(
              `New PRs open ${draftFlag ? "as drafts" : "ready for review"}: ${describeSource(draft)}.`,
            ),
          );
        }
        const s = p.spinner();
        s.start(`Creating PR for ${pc.blue(branchName)}...`);

        const ghArgs = [
          "pr",
          "create",
          "--base",
          parentBranch,
          "--head",
          branchName,
          "--title",
          title,
          "--body",
          body,
        ];
        if (draftFlag) ghArgs.push("--draft");

        const proc = Bun.spawn(["gh", ...ghArgs], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;

        if (exitCode === 0) {
          // Extract PR number from URL output
          const prUrl = output.trim();
          const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
          const newPrNumber = prNumMatch ? parseInt(prNumMatch[1]!, 10) : null;
          outcome.created = true;
          outcome.draft = draftFlag;
          outcome.pr = newPrNumber;
          outcome.url = prUrl || null;

          if (newPrNumber) {
            branchMeta.pr = newPrNumber;
            branchMeta.prTitle = title;
            branchMeta.prBase = parentBranch;
            metadataChanged = true;
            s.stop(`Created PR #${newPrNumber} for ${pc.blue(branchName)}`);
          } else {
            s.stop(`Created PR for ${pc.blue(branchName)} (could not parse PR number)`);
          }
          created++;
        } else {
          const stderr = await new Response(proc.stderr).text();
          s.stop(pc.red(`Failed to create PR for ${branchName}`));
          p.log.error(stderr.trim());
          outcome.error = stderr.trim() || "gh pr create failed";
        }
      }
    }
  }

  p.print();

  if (dryRun) {
    p.outro(
      pc.dim(
        `Dry run complete: would push ${scope.length}, create ${created}, update ${existing} PR(s)`,
      ),
    );
    if (restackFlag) await maybeRestack(stack, branch, true);
    return;
  }

  // ── Phase 2: Reconcile PR titles (stack position) then refresh the stack
  // visualization. Titles first so the viz renders the numbered titles. Both
  // render locally and only hit the network for PRs that actually changed
  // (see issue #16), so a no-op re-submit is free. ──
  // `-t`/`-b` (and `--body-file`) update the PR for the branch you're on, even
  // if it already exists — title is renumbered, body is replaced with the viz
  // block re-merged. This makes `submit` the one tool to update a PR without
  // `gh pr edit` clobbering the `📚 Stacked on` block.
  p.log.info(pc.cyan("Updating PR titles & stack visualization..."));
  const titles = await reconcilePrTitles(stack, ordered, {
    titleOverrides: titleFlag ? { [branch]: titleFlag } : undefined,
  });
  const viz = await refreshStackViz(meta, stack, ordered, {
    bodyOverrides: bodyFlag ? { [branch]: bodyFlag } : undefined,
  });

  run.edited = new Set([...titles.updatedBranches, ...viz.updatedBranches]);

  // One persist for everything we cached this run (discovered PRs, base edits,
  // backfilled/renumbered titles, viz hashes).
  if (metadataChanged || titles.dirty || viz.dirty) {
    await writeMetadata(meta);
  }

  // ── Summary ──
  p.print();
  p.outro(
    pc.green(
      `Done! Pushed ${pushed} branch(es), created ${created} PR(s), updated ${viz.updated} description(s), ${titles.updated} title(s)` +
        (viz.unchanged > 0 ? `, ${viz.unchanged} unchanged` : ""),
    ),
  );

  // ── --restack: propagate a downstack fix up to the children ──
  // submit owns DOWNSTACK (trunk → current); restack owns UPSTACK (the branches
  // above current). Running both from one branch syncs the whole stack.
  if (restackFlag) await maybeRestack(stack, branch, false);
}

/**
 * Chain into `restack` from the current branch after a submit, so a downstack
 * fix propagates up to its children in one command. No-op (with a friendly
 * note) when nothing sits above the current branch — there's nothing to rebase.
 */
async function maybeRestack(stack: Stack, branch: string, dryRun: boolean): Promise<void> {
  // buildRebaseChain returns the current branch + all its descendants; a length
  // of 1 means it's the top of its line, so there's nothing above to restack.
  if (buildRebaseChain(stack, branch).length <= 1) {
    p.print();
    p.log.info(pc.dim(`--restack: nothing sits above ${pc.yellow(branch)} — nothing to restack.`));
    return;
  }

  p.print();
  const { default: restack } = await import("./restack.ts");
  // Always push: submit publishes by nature, and the explicit flag means no
  // config is read after submit's own pushes already happened.
  await restack([...(dryRun ? ["--dry-run"] : []), "--push"]);
}
