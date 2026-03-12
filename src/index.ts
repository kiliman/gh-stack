#!/usr/bin/env bun
// git-stack — Unified stacked PR manager for squash-merge workflows
import { ensureGitRepo } from "./lib/safety.ts";

const VERSION = "2.0.0";

const args = process.argv.slice(2);
const command = args[0] || "show";

// Handle global flags
if (args.includes("--version") || args.includes("-V")) {
  console.log(`git-stack v${VERSION}`);
  process.exit(0);
}

if (args.includes("--help") && !args[0]) {
  printHelp();
  process.exit(0);
}

// Ensure we're in a git repo for all commands
await ensureGitRepo();

// Route to subcommand
const commandArgs = args.slice(1);

switch (command) {
  case "show":
    await (await import("./commands/show.ts")).default(commandArgs);
    break;

  case "init":
    await (await import("./commands/init.ts")).default(commandArgs);
    break;

  case "add":
    await (await import("./commands/add.ts")).default(commandArgs);
    break;

  case "remove":
    await (await import("./commands/remove.ts")).default(commandArgs);
    break;

  case "switch":
    await (await import("./commands/switch.ts")).default(commandArgs);
    break;

  case "restack":
  case "rebase":
    await (await import("./commands/restack.ts")).default(commandArgs);
    break;

  case "sync":
    await (await import("./commands/sync.ts")).default(commandArgs);
    break;

  case "update-prs":
    await (await import("./commands/update-prs.ts")).default(commandArgs);
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
git-stack v${VERSION} — Stacked PR manager for squash-merge workflows

${bold("USAGE")}
  git-stack <command> [options]

${bold("COMMANDS")}
  ${green("show")}           Display current stack tree ${dim("(default)")}
  ${green("init")}           Create a new stack
  ${green("add")}            Add a branch to the current stack
  ${green("remove")}         Remove a branch from the stack
  ${green("switch")}         Switch branch or stack
  ${green("restack")}        Rebase children onto updated parents
  ${green("sync")}           Sync base with main + restack all
  ${green("update-prs")}     Update PR descriptions with stack viz
  ${green("status")}         PR dashboard (CI, reviews)
  ${green("merge")}          Local squash-merge top-down
  ${green("undo")}           Restore from last snapshot
  ${green("archive")}        Manage archived stacks

${bold("OPTIONS")}
  --help           Show help
  --version, -V    Show version
`);
}

function bold(s: string) {
  return `\x1b[1m${s}\x1b[0m`;
}
function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}
function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}
