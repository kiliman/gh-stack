#!/usr/bin/env bun
// gh-stack — Unified stacked PR manager for squash-merge workflows

// Map GH_STACK_NO_COLOR → NO_COLOR so picocolors (and other tools) respect it,
// and turn colors off for plain mode (--plain, --yes, GH_STACK_YES, GH_STACK_PLAIN)
// and --json (a machine reads the stderr logs, and error messages land inside
// the JSON itself).
//
// picocolors reads NO_COLOR once, when it first loads. So this file has NO
// static imports: those are evaluated before this body runs, and Bun evaluates
// a CommonJS dependency like picocolors even before an earlier ESM side-effect
// import. Everything that can pull in picocolors is imported dynamically below,
// after NO_COLOR is settled; cli.ts and config-error.ts import nothing that does.
const { parseCliArgs } = await import("./lib/cli.ts");
const { ConfigError } = await import("./lib/config-error.ts");

const args = process.argv.slice(2);
let parsed: ReturnType<typeof parseCliArgs>;
try {
  parsed = parseCliArgs(args, process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`gh-stack: ${err.message}`);
  process.exit(1);
}
if (parsed.noColor || parsed.plain || args.includes("--json")) process.env.NO_COLOR = "1";

// gh-stack's own read-only git calls (status, diff) shouldn't take index.lock
// to save a refreshed stat cache: that only contends with our own writes and
// with a gh-stack running in another worktree (#69). Bun's shell reads
// process.env at each call, so this reaches every git we run.
process.env.GIT_OPTIONAL_LOCKS ??= "0";

const { ensureGitRepo } = await import("./lib/safety.ts");
const { COMMANDS, RUNS_OUTSIDE_REPO } = await import("./lib/commands.ts");
const { setAutoYes } = await import("./lib/ui.ts");
const { setPlain } = await import("./lib/output.ts");
const { version: VERSION } = await import("../package.json");

const command = parsed.command;

// Handle global flags
if (parsed.showVersion) {
  console.log(`gh-stack v${VERSION}`);
  process.exit(0);
}

if (parsed.showGlobalHelp) {
  printHelp();
  process.exit(0);
}

// Global --yes flag: skip all interactive confirmations (for agents/CI)
if (parsed.autoYes) {
  setAutoYes(true);
}

// Global --plain (or GH_STACK_YES=1): drop intro/outro/spinner/color chrome.
if (parsed.plain) {
  setPlain(true);
}

const load = COMMANDS[command];
if (!load) {
  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

// Every command needs a git repo except those in RUNS_OUTSIDE_REPO, and a
// help page, which shows anywhere.
if (!RUNS_OUTSIDE_REPO.has(command) && !parsed.showHelp) {
  await ensureGitRepo();
}

// A config problem (malformed TOML, a non-boolean env value) is reported as
// one clean line, whichever command hit it.
const { GitLockError, WorktreeBusyError, describeBlockedBranch, rebaseCommand } =
  await import("./lib/git.ts");
const { PrFetchError } = await import("./lib/github.ts");
try {
  await (await load()).default(parsed.commandArgs);
} catch (err) {
  if (err instanceof GitLockError) await reportHeldLock(err);
  if (err instanceof WorktreeBusyError) await reportBusyWorktree(err);
  if (err instanceof PrFetchError) {
    console.error(
      `gh-stack: ${err.message}\n  It stopped there rather than guess the PR's state. This is usually transient; run the command again.`,
    );
    process.exit(1);
  }
  if (!(err instanceof ConfigError)) throw err;
  console.error(`gh-stack: ${err.message}`);
  process.exit(1);
}

/**
 * A branch's worktree stopped being ready while the command ran (#78): the
 * up-front check passed, then someone changed files there. Nothing was done
 * to that branch.
 */
async function reportBusyWorktree(err: InstanceType<typeof WorktreeBusyError>): Promise<never> {
  const { findPendingRun } = await import("./lib/run-log.ts");
  const pending = await findPendingRun().catch(() => null);
  console.error(
    [
      `gh-stack: stopped before rebasing ${err.branch}:`,
      `  ${describeBlockedBranch(err.branch, err.worktree, err.why).join("\n  ")}`,
      pending
        ? "  Then pick the run up where it stopped:\n    gh-stack restack --resume"
        : "  Then run the command again.",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * Another git process held a lock past every retry (#69). Say so plainly:
 * nothing conflicted, and the step runs again once the lock is gone.
 */
async function reportHeldLock(err: InstanceType<typeof GitLockError>): Promise<never> {
  const { findPendingRun } = await import("./lib/run-log.ts");
  const pending = await findPendingRun().catch(() => null);
  const lines = [
    `gh-stack: another git process holds ${err.lockPath}, and still did after waiting ${(err.waitedMs / 1000).toFixed(1)}s.`,
    `  Nothing conflicted: ${err.command} couldn't take the lock, so it changed nothing.`,
  ];
  const holder = err.holder;
  if (!("unknown" in holder) && holder.holders.length > 0) {
    lines.push(`  Held by: ${holder.holders.join("\n           ")}`);
  }
  if (err.rebaseInProgress) {
    lines.push(
      `  The rebase is paused, not conflicted. Once the lock is gone:`,
      `    ${rebaseCommand(err.worktree)} --continue`,
    );
  }
  lines.push(
    pending
      ? `  Once the lock is gone, pick the run up where it stopped:\n    gh-stack restack --resume`
      : `  Once the lock is gone, run the command again.`,
  );
  if ("unknown" in holder) {
    lines.push(
      `  If no other git process is running, the lock is stale; remove it:\n    rm ${err.lockPath}`,
    );
  } else if (holder.holders.length === 0) {
    lines.push(
      `  No process has it open, so it's stale (left by a git that crashed); remove it:\n    rm ${err.lockPath}`,
    );
  }
  console.error(lines.join("\n"));
  process.exit(1);
}

function printHelp() {
  console.log(`
gh-stack v${VERSION} — Stacked PR manager for squash-merge workflows

${bold("USAGE")}
  gh-stack <command> [options]

${bold("TERMS")}
  trunk       Base branch of the repository (usually main)
  stack       A chain of dependent branches
  upstack     Branches that depend on the current branch (children)
  downstack   Branches the current branch depends on (ancestors)

${bold("CORE WORKFLOW")}
  ${green("init")}           Create a new stack from the current branch
  ${green("create")}         Create a new branch and add to the stack
  ${green("add")}            Track the current local branch in a stack ${dim("(no push/PR)")}
  ${green("submit")}         Push branches and create/update PRs
  ${green("log")}            Display current stack tree ${dim("(default)")}

${bold("STACK NAVIGATION")}
  ${green("checkout")}       Switch to a branch or stack ${dim("(alias: co)")}
  ${green("up")}             Move to child branch (upstack)
  ${green("down")}           Move to parent branch (downstack)
  ${green("top")}            Jump to the tip of the stack
  ${green("bottom")}         Jump to the base of the stack
  ${green("ls")}             List branches with numbers ${dim("(alias: list)")}
  ${green("stacks")}         List all stacks (--json for tools)

${bold("STACK MANAGEMENT")}
  ${green("restack")}        Rebase children onto updated parents
  ${green("sync")}           Sync base with main + restack all
  ${green("merge")}          Squash-merge via GitHub (top-down, or --approved bottom-up)
  ${green("split")}          Cut a stack into two at a branch
  ${green("join")}           Splice an existing branch/PR into a stack
  ${green("rename")}         Rename a tracked branch (keeps metadata in sync)
  ${green("delete")}         Remove a branch from the stack
  ${green("untrack")}        Stop tracking a branch (the branch and its PR stay)

${bold("INFO & MAINTENANCE")}
  ${green("status")}         PR dashboard (CI, reviews)
  ${green("undo")}           Restore from last snapshot
  ${green("archive")}        Manage archived stacks
  ${green("update-prs")}     Refresh stack visualization in PR descriptions
  ${green("doctor")}         Migrate & repair stack metadata
  ${green("config")}         Show flag defaults and where each comes from
  ${green("learn")}          Print the agent skill (--skill installs it)

${bold("GLOBAL OPTIONS")}
  --yes, -y        Skip confirmations ${dim("(for agents/CI)")}
  --plain          Plain output: no spinners, colors, or box drawing
  --help           Show help (gh-stack <command> --help, or help <command>)
  --version, -V    Show version

${bold("ENVIRONMENT")}
  GH_STACK_YES=1       Same as --yes (also enables --plain)
  GH_STACK_PLAIN=1     Same as --plain
  GH_STACK_NO_COLOR=1  Disable colored output
  GH_STACK_DRAFT=1     submit creates new PRs as drafts (0 = ready)
  GH_STACK_NO_PUSH=1   restack/sync/join/merge --base never push (0 = push)
  Each takes 1/0, true/false, or yes/no; anything else is an error.

${bold("CONFIG")}
  .gh-stack.toml (repo root) and ~/.config/gh-stack/config.toml set flag
  defaults, e.g. [submit] draft = true. Run ${green("gh-stack config")} to see them.
`);
}

function bold(s: string) {
  return process.env.NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`;
}
function green(s: string) {
  return process.env.NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`;
}
function dim(s: string) {
  return process.env.NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`;
}
