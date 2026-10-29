// gh-stack config — Show the resolved flag defaults and where each came from.
//
// Answers "why did this open as a draft?" in one command. Read-only: it never
// writes a config file (edit the TOML directly).
import pc from "picocolors";
import {
  SETTINGS,
  describeSource,
  loadConfigLayers,
  resolveSetting,
  type ConfigFile,
  type ConfigLayers,
  type ConfigSource,
  type SettingName,
  ConfigError,
} from "../lib/config.ts";

const HELP = `
gh-stack config — Show flag defaults and where each value comes from

USAGE
  gh-stack config [--json]

Prints every configurable default with its resolved value and source. Values
resolve, highest first: CLI flag > env var > repo config > user config >
built-in default. Outside a git repo it shows the user and env layers only.

FILES
  .gh-stack.toml                     Repo root (commit it to share conventions)
  ~/.config/gh-stack/config.toml     Personal defaults (honors XDG_CONFIG_HOME)

  [submit]
  draft = true        # new PRs open as drafts       (--draft / --no-draft)

  [restack]
  push = false        # restack and sync stay local  (--push / --no-push)
                      # (merge and submit --restack always push)

ENVIRONMENT (1/0, true/false, or yes/no)
  GH_STACK_DRAFT       submit draft default
  GH_STACK_NO_PUSH     restack/sync/merge --base push default (1 = don't push)

--yes is not configurable from a file: auto-confirming destructive operations
must be asked for per run (--yes or GH_STACK_YES=1).

OPTIONS
  --json    Output as JSON
`;

export interface ConfigReport {
  settings: {
    key: string;
    value: boolean;
    source: ConfigSource;
    origin: string | null;
    flags: string[];
    env: string;
  }[];
  files: { repo: FileInfo | null; user: FileInfo | null };
}

interface FileInfo {
  path: string;
  exists: boolean;
}

function fileInfo(f: ConfigFile | null): FileInfo | null {
  return f ? { path: f.path, exists: f.exists } : null;
}

function fileLine(label: string, f: FileInfo | null): string {
  return f
    ? `  ${label}  ${f.path} ${f.exists ? "" : pc.dim("(not found)")}`.trimEnd()
    : `  ${label}  ${pc.dim("(not in a git work tree)")}`;
}

/** Build the report from loaded layers. Pure, so it's unit-testable. */
export function buildConfigReport(layers: ConfigLayers): ConfigReport {
  return {
    settings: (Object.keys(SETTINGS) as SettingName[]).map((name) => {
      const spec = SETTINGS[name];
      const r = resolveSetting(name, [], layers);
      return {
        key: name,
        value: r.value,
        source: r.source,
        origin: r.origin ?? null,
        flags: [...spec.onFlags, ...spec.offFlags],
        env: spec.env.name,
      };
    }),
    files: { repo: fileInfo(layers.repo), user: fileInfo(layers.user) },
  };
}

export default async function config(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }

  // Both steps can throw ConfigError: loading (bad TOML, wrong-typed value)
  // and resolving (a non-boolean env var).
  let report: ConfigReport;
  try {
    const loaded = await loadConfigLayers();
    for (const w of loaded.warnings) console.error(`gh-stack: warning: ${w}`);
    report = buildConfigReport(loaded.layers);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`gh-stack: ${err.message}`);
    process.exit(1);
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log();
  const width = Math.max(...report.settings.map((s) => s.key.length));
  for (const s of report.settings) {
    const value = s.value ? pc.green("true ") : pc.yellow("false");
    const source = describeSource({ ...s, origin: s.origin ?? undefined });
    console.log(`  ${s.key.padEnd(width)}  ${value}  ${pc.dim(source)}`);
  }

  console.log();
  console.log(pc.dim("Config files:"));
  console.log(fileLine("repo", report.files.repo));
  console.log(fileLine("user", report.files.user));
  console.log();
}
