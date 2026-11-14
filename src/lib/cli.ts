import { parseEnvBool } from "./config-error.ts";

export interface ParsedCliArgs {
  command: string;
  commandArgs: string[];
  autoYes: boolean;
  plain: boolean;
  noColor: boolean;
  showVersion: boolean;
  showGlobalHelp: boolean;
  /** The command was asked for its help page; it must print it and do nothing else. */
  showHelp: boolean;
}

const LEADING_GLOBAL_FLAGS = new Set(["--yes", "-y", "--plain", "--help", "--version", "-V"]);

/**
 * Split argv into the command and its args, and resolve the global flags.
 * `--help` anywhere asks for help: `gh-stack --help submit`, `gh-stack submit
 * --help` and `gh-stack help submit` all hand `--help` to submit, which prints
 * its help page and runs nothing. Throws ConfigError for a GH_STACK_YES,
 * GH_STACK_PLAIN or GH_STACK_NO_COLOR value that isn't a boolean.
 */
export function parseCliArgs(rawArgs: string[], env: NodeJS.ProcessEnv): ParsedCliArgs {
  let commandIndex = 0;
  const leadingFlags = new Set<string>();

  while (commandIndex < rawArgs.length && LEADING_GLOBAL_FLAGS.has(rawArgs[commandIndex]!)) {
    leadingFlags.add(rawArgs[commandIndex]!);
    commandIndex++;
  }

  let command = rawArgs[commandIndex];
  let rest = rawArgs.slice(commandIndex + 1);
  let helpRequested = leadingFlags.has("--help");
  if (command === "help") {
    command = rest[0];
    rest = rest.slice(1);
    helpRequested = true;
  }

  const commandArgs = rest.filter((arg) => arg !== "--yes" && arg !== "-y" && arg !== "--plain");
  const showHelp = !!command && (helpRequested || commandArgs.includes("--help"));
  if (showHelp && !commandArgs.includes("--help")) commandArgs.push("--help");

  const autoYes =
    rawArgs.includes("--yes") ||
    rawArgs.includes("-y") ||
    parseEnvBool("GH_STACK_YES", env.GH_STACK_YES) === true;
  // Plain mode comes with --yes / GH_STACK_YES (agents skip the chrome anyway)
  // or with an explicit --plain / GH_STACK_PLAIN.
  const plain =
    autoYes ||
    rawArgs.includes("--plain") ||
    parseEnvBool("GH_STACK_PLAIN", env.GH_STACK_PLAIN) === true;

  return {
    command: command || "log",
    commandArgs,
    autoYes,
    plain,
    noColor: parseEnvBool("GH_STACK_NO_COLOR", env.GH_STACK_NO_COLOR) === true,
    showVersion: leadingFlags.has("--version") || leadingFlags.has("-V"),
    showGlobalHelp: !command && helpRequested,
    showHelp,
  };
}
