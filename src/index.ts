#!/usr/bin/env bun
// gh-stack — Unified stacked PR manager for squash-merge workflows

// Map GH_STACK_NO_COLOR → NO_COLOR so picocolors (and other tools) respect it,
// and turn colors off for plain mode (--plain, GH_STACK_YES=1, GH_STACK_PLAIN=1)
// and --json (a machine reads the stderr logs, and error messages land inside
// the JSON itself).
//
// picocolors reads NO_COLOR once, when it first loads. So this file has NO
// static imports: those are evaluated before this body runs, and Bun evaluates
// a CommonJS dependency like picocolors even before an earlier ESM side-effect
// import. Everything that can pull in picocolors is imported dynamically below.
const earlyArgs = new Set(process.argv.slice(2));
const colorOff =
  !!process.env.GH_STACK_NO_COLOR ||
  earlyArgs.has("--plain") ||
  earlyArgs.has("--json") ||
  process.env.GH_STACK_YES === "1" ||
  process.env.GH_STACK_PLAIN === "1";
if (colorOff) process.env.NO_COLOR = "1";

const { ensureGitRepo } = await import("./lib/safety.ts");
const { parseCliArgs } = await import("./lib/cli.ts");
const { setAutoYes } = await import("./lib/ui.ts");
const { setPlain } = await import("./lib/output.ts");
const { version: VERSION } = await import("../package.json");

const args = process.argv.slice(2);
const parsed = parseCliArgs(args, process.env);
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

// Ensure we're in a git repo for all commands — except `learn`, which just
// emits/installs the agent skill and is useful outside any repo (e.g. an agent
// onboarding before cloning, or `learn --skill --global`), and `config`, which
// shows the user and env layers anywhere (and the repo layer inside a repo).
if (command !== "learn" && command !== "config") {
  await ensureGitRepo();
}

// Route to subcommand — strip global flags from command args
const commandArgs = parsed.commandArgs;

// A config problem (malformed TOML, a non-boolean env value) is reported as
// one clean line, whichever command hit it.
const { ConfigError } = await import("./lib/config.ts");
try {
  switch (command) {
    case "log":
      await (await import("./commands/log.ts")).default(commandArgs);
      break;

    case "init":
      await (await import("./commands/init.ts")).default(commandArgs);
      break;

    case "create":
      await (await import("./commands/create.ts")).default(commandArgs);
      break;

    case "add":
      await (await import("./commands/add.ts")).default(commandArgs);
      break;

    case "join":
      await (await import("./commands/join.ts")).default(commandArgs);
      break;

    case "delete":
      await (await import("./commands/delete.ts")).default(commandArgs);
      break;

    case "split":
      await (await import("./commands/split.ts")).default(commandArgs);
      break;

    case "rename":
      await (await import("./commands/rename.ts")).default(commandArgs);
      break;

    case "checkout":
    case "co":
      await (await import("./commands/checkout.ts")).default(commandArgs);
      break;

    case "ls":
      await (await import("./commands/list.ts")).default(commandArgs);
      break;

    case "restack":
    case "rebase":
      await (await import("./commands/restack.ts")).default(commandArgs);
      break;

    case "sync":
      await (await import("./commands/sync.ts")).default(commandArgs);
      break;

    case "submit":
      await (await import("./commands/submit.ts")).default(commandArgs);
      break;

    case "status":
      await (await import("./commands/status.ts")).default(commandArgs);
      break;

    case "merge":
      await (await import("./commands/merge.ts")).default(commandArgs);
      break;

    case "undo":
      await (await import("./commands/undo.ts")).default(commandArgs);
      break;

    case "doctor":
      await (await import("./commands/doctor.ts")).default(commandArgs);
      break;

    case "update-prs":
      await (await import("./commands/update-prs.ts")).default(commandArgs);
      break;

    case "stacks":
      await (await import("./commands/stacks.ts")).default(commandArgs);
      break;

    case "archive":
      await (await import("./commands/archive.ts")).default(commandArgs);
      break;

    case "up":
      await (await import("./commands/up.ts")).default(commandArgs);
      break;

    case "down":
      await (await import("./commands/down.ts")).default(commandArgs);
      break;

    case "top":
      await (await import("./commands/top.ts")).default(commandArgs);
      break;

    case "bottom":
      await (await import("./commands/bottom.ts")).default(commandArgs);
      break;

    case "learn":
      await (await import("./commands/learn.ts")).default(commandArgs);
      break;

    case "config":
      await (await import("./commands/config.ts")).default(commandArgs);
      break;

    case "--help":
    case "help":
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`gh-stack: ${err.message}`);
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
  ${green("ls")}             List branches with numbers
  ${green("stacks")}         List all stacks (--json for tools)

${bold("STACK MANAGEMENT")}
  ${green("restack")}        Rebase children onto updated parents
  ${green("sync")}           Sync base with main + restack all
  ${green("merge")}          Squash-merge via GitHub (top-down, or --approved bottom-up)
  ${green("split")}          Cut a stack into two at a branch
  ${green("join")}           Splice an existing branch/PR into a stack
  ${green("rename")}         Rename a tracked branch (keeps metadata in sync)
  ${green("delete")}         Remove a branch from the stack

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
  --help           Show help
  --version, -V    Show version

${bold("ENVIRONMENT")}
  GH_STACK_YES=1       Same as --yes (also enables --plain)
  GH_STACK_PLAIN=1     Same as --plain
  GH_STACK_NO_COLOR    Disable colored output
  GH_STACK_DRAFT=1     submit creates new PRs as drafts (0 = ready)
  GH_STACK_NO_PUSH=1   restack/sync never push (0 = push)

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
