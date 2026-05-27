export interface ParsedCliArgs {
  command: string;
  commandArgs: string[];
  autoYes: boolean;
  plain: boolean;
  showVersion: boolean;
  showGlobalHelp: boolean;
}

const LEADING_GLOBAL_FLAGS = new Set(["--yes", "-y", "--plain", "--help", "--version", "-V"]);

export function parseCliArgs(rawArgs: string[], env: NodeJS.ProcessEnv): ParsedCliArgs {
  let commandIndex = 0;
  const leadingFlags = new Set<string>();

  while (commandIndex < rawArgs.length && LEADING_GLOBAL_FLAGS.has(rawArgs[commandIndex]!)) {
    leadingFlags.add(rawArgs[commandIndex]!);
    commandIndex++;
  }

  const command = rawArgs[commandIndex] || "log";
  const commandArgs = rawArgs
    .slice(commandIndex + 1)
    .filter((arg) => arg !== "--yes" && arg !== "-y" && arg !== "--plain");

  const autoYes = rawArgs.includes("--yes") || rawArgs.includes("-y") || env.GH_STACK_YES === "1";
  // Plain mode auto-enables under GH_STACK_YES=1 (agents skip the chrome anyway)
  // or explicit --plain. Both compose with each other.
  const plain = autoYes || rawArgs.includes("--plain") || env.GH_STACK_PLAIN === "1";

  return {
    command,
    commandArgs,
    autoYes,
    plain,
    showVersion: leadingFlags.has("--version") || leadingFlags.has("-V"),
    showGlobalHelp: !rawArgs[commandIndex] && leadingFlags.has("--help"),
  };
}
