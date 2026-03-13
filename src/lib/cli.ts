export interface ParsedCliArgs {
  command: string;
  commandArgs: string[];
  autoYes: boolean;
  showVersion: boolean;
  showGlobalHelp: boolean;
}

const LEADING_GLOBAL_FLAGS = new Set(["--yes", "-y", "--help", "--version", "-V"]);

export function parseCliArgs(rawArgs: string[], env: NodeJS.ProcessEnv): ParsedCliArgs {
  let commandIndex = 0;
  const leadingFlags = new Set<string>();

  while (commandIndex < rawArgs.length && LEADING_GLOBAL_FLAGS.has(rawArgs[commandIndex]!)) {
    leadingFlags.add(rawArgs[commandIndex]!);
    commandIndex++;
  }

  const command = rawArgs[commandIndex] || "show";
  const commandArgs = rawArgs
    .slice(commandIndex + 1)
    .filter((arg) => arg !== "--yes" && arg !== "-y");

  return {
    command,
    commandArgs,
    autoYes: rawArgs.includes("--yes") || rawArgs.includes("-y") || env.GH_STACK_YES === "1",
    showVersion: leadingFlags.has("--version") || leadingFlags.has("-V"),
    showGlobalHelp: !rawArgs[commandIndex] && leadingFlags.has("--help"),
  };
}
