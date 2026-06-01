#!/usr/bin/env bun
// gh-stack — Unified stacked PR manager for squash-merge workflows

// Map GH_STACK_NO_COLOR → NO_COLOR so picocolors (and other tools) respect it.
// Also pre-detect plain mode (--plain flag, GH_STACK_YES=1, or GH_STACK_PLAIN=1)
// and set NO_COLOR *before* any import below — picocolors snapshots env at
// load time, so this must run before the import block.
const _earlyArgs = process.argv.slice(2);
const _earlyPlain =
  _earlyArgs.includes("--plain") ||
  process.env.GH_STACK_YES === "1" ||
  process.env.GH_STACK_PLAIN === "1";
if (process.env.GH_STACK_NO_COLOR || _earlyPlain) {
  process.env.NO_COLOR = "1";
}

import { ensureGitRepo } from "./lib/safety.ts";
import { parseCliArgs } from "./lib/cli.ts";
import { setAutoYes } from "./lib/ui.ts";
import { setPlain } from "./lib/output.ts";

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

// Ensure we're in a git repo for all commands
await ensureGitRepo();

// Route to subcommand — strip global flags from command args
const commandArgs = parsed.commandArgs;

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

  case "delete":
    await (await import("./commands/delete.ts")).default(commandArgs);
    break;

  case "split":
    await (await import("./commands/split.ts")).default(commandArgs);
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

  case "--help":
  case "help":
    printHelp();
    break;

  default:
    console.error(`Unknown command: ${command}\n`);
    printHelp();
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
  ${green("submit")}         Push branches and create/update PRs
  ${green("log")}            Display current stack tree ${dim("(default)")}

${bold("STACK NAVIGATION")}
  ${green("checkout")}       Switch to a branch or stack ${dim("(alias: co)")}
  ${green("up")}             Move to child branch (upstack)
  ${green("down")}           Move to parent branch (downstack)
  ${green("top")}            Jump to the tip of the stack
  ${green("bottom")}         Jump to the base of the stack
  ${green("ls")}             List branches with numbers

${bold("STACK MANAGEMENT")}
  ${green("restack")}        Rebase children onto updated parents
  ${green("sync")}           Sync base with main + restack all
  ${green("merge")}          Local squash-merge top-down
  ${green("split")}          Cut a stack into two at a branch
  ${green("delete")}         Remove a branch from the stack

${bold("INFO & MAINTENANCE")}
  ${green("status")}         PR dashboard (CI, reviews)
  ${green("undo")}           Restore from last snapshot
  ${green("archive")}        Manage archived stacks

${bold("GLOBAL OPTIONS")}
  --yes, -y        Skip confirmations ${dim("(for agents/CI)")}
  --plain          Plain output: no spinners, colors, or box drawing
  --help           Show help
  --version, -V    Show version

${bold("ENVIRONMENT")}
  GH_STACK_YES=1       Same as --yes (also enables --plain)
  GH_STACK_PLAIN=1     Same as --plain
  GH_STACK_NO_COLOR    Disable colored output
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
