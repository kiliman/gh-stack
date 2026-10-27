// Defaults config (#39): repo and user defaults for boolean command flags, so
// a convention like "every PR opens as a draft" can't be forgotten.
//
//   .gh-stack.toml at the repo root          (committed, shared by the team)
//   ~/.config/gh-stack/config.toml           (personal; honors XDG_CONFIG_HOME)
//   GH_STACK_DRAFT=1, GH_STACK_NO_PUSH=1     (env, per session)
//
// Precedence, highest first: CLI flag > env > repo config > user config > built-in.
// Keys mirror command and flag names (`[submit] draft`). A new default is one
// entry in SETTINGS. `--yes` is deliberately not configurable from any file.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { repoRoot } from "./git.ts";

export type ConfigSource = "flag" | "env" | "repo" | "user" | "default";

export interface BoolSetting {
  section: string;
  key: string;
  builtin: boolean;
  /** Flags that turn it on / off. The last one on the command line wins. */
  onFlags: string[];
  offFlags: string[];
  /** `invert`: the variable names the opposite (GH_STACK_NO_PUSH=1 → push = false). */
  env: { name: string; invert?: boolean };
  description: string;
}

export const SETTINGS = {
  "submit.draft": {
    section: "submit",
    key: "draft",
    builtin: false,
    onFlags: ["--draft", "-d"],
    offFlags: ["--no-draft"],
    env: { name: "GH_STACK_DRAFT" },
    description: "Create new PRs as drafts",
  },
  "restack.push": {
    section: "restack",
    key: "push",
    builtin: true,
    onFlags: ["--push"],
    offFlags: ["--no-push"],
    env: { name: "GH_STACK_NO_PUSH", invert: true },
    description: "Push rebased branches (restack and sync)",
  },
} satisfies Record<string, BoolSetting>;

export type SettingName = keyof typeof SETTINGS;

export const REPO_CONFIG_FILE = ".gh-stack.toml";

export interface ConfigFile {
  path: string;
  exists: boolean;
  data: Record<string, unknown>;
}

export interface ConfigLayers {
  env: Record<string, string | undefined>;
  repo: ConfigFile | null;
  user: ConfigFile | null;
}

export interface Resolved {
  value: boolean;
  source: ConfigSource;
  /** The flag, env var, or file the value came from. */
  origin?: string;
}

/** A config problem the user must fix: malformed TOML, a wrong-typed value. */
export class ConfigError extends Error {}

function settingByPath(section: string, key: string): BoolSetting | undefined {
  return (SETTINGS as Record<string, BoolSetting>)[`${section}.${key}`];
}

/**
 * Parse a flag-default env var: 1/true/yes or 0/false/no (any case); empty =
 * unset. Anything else is an error, so a typo can't be silently ignored.
 */
export function parseEnvBool(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes"].includes(v)) return true;
  if (["0", "false", "no"].includes(v)) return false;
  throw new ConfigError(`${name}=${raw} is not a boolean (use 1/0, true/false, or yes/no).`);
}

/**
 * Check a parsed config file against SETTINGS. A known key with a non-boolean
 * value is an error (silently falling back could open a PR the repo wanted as
 * a draft); unknown sections and keys come back as warnings.
 */
export function validateConfig(data: Record<string, unknown>, file: string): string[] {
  const warnings: string[] = [];
  for (const [section, value] of Object.entries(data)) {
    if (section === "yes") {
      warnings.push(yesWarning(section, file));
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      warnings.push(`ignoring unknown key "${section}" in ${file}`);
      continue;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const spec = settingByPath(section, key);
      if (!spec) {
        warnings.push(
          key === "yes"
            ? yesWarning(`[${section}] yes`, file)
            : `ignoring unknown key [${section}] ${key} in ${file}`,
        );
        continue;
      }
      if (typeof v !== "boolean") {
        throw new ConfigError(
          `[${section}] ${key} in ${file} must be true or false, got ${JSON.stringify(v)}.`,
        );
      }
    }
  }
  return warnings;
}

function yesWarning(where: string, file: string): string {
  return (
    `ignoring ${where} in ${file}: auto-confirming destructive operations can't be ` +
    `set in a config file. Pass --yes or set GH_STACK_YES=1 for the run that needs it.`
  );
}

/** The value an explicit flag sets, or null when no flag for it is present. */
export function flagSetting(name: SettingName, args: string[]): Resolved | null {
  const spec: BoolSetting = SETTINGS[name];
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i]!;
    if (spec.onFlags.includes(arg)) return { value: true, source: "flag", origin: arg };
    if (spec.offFlags.includes(arg)) return { value: false, source: "flag", origin: arg };
  }
  return null;
}

/**
 * Resolve one setting from the CLI args and the config layers. Pure: the
 * layers are loaded (and validated) by `loadConfigLayers`.
 */
export function resolveSetting(name: SettingName, args: string[], layers: ConfigLayers): Resolved {
  const spec: BoolSetting = SETTINGS[name];

  const flag = flagSetting(name, args);
  if (flag) return flag;

  const envValue = parseEnvBool(spec.env.name, layers.env[spec.env.name]);
  if (envValue !== undefined) {
    return {
      value: spec.env.invert ? !envValue : envValue,
      source: "env",
      origin: spec.env.name,
    };
  }

  for (const source of ["repo", "user"] as const) {
    const file = layers[source];
    const section = file?.data[spec.section] as Record<string, unknown> | undefined;
    const v = section?.[spec.key];
    if (typeof v === "boolean") return { value: v, source, origin: file!.path };
  }

  return { value: spec.builtin, source: "default" };
}

/**
 * Read and validate one TOML file. A missing file (ENOENT) is an empty layer;
 * any other read failure (a directory, no permission) is a ConfigError.
 */
export function loadConfigFile(file: string): { file: ConfigFile; warnings: string[] } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { file: { path: file, exists: false, data: {} }, warnings: [] };
    }
    throw new ConfigError(`can't read ${file}: ${(err as Error).message}`);
  }
  let data: Record<string, unknown>;
  try {
    data = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`invalid TOML in ${file}: ${(err as Error).message}`);
  }
  return { file: { path: file, exists: true, data }, warnings: validateConfig(data, file) };
}

/** `$XDG_CONFIG_HOME/gh-stack/config.toml`, else `~/.config/gh-stack/config.toml`. */
export function userConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "gh-stack", "config.toml");
}

/** `<repo root>/.gh-stack.toml`, or null outside a work tree. */
export async function repoConfigPath(): Promise<string | null> {
  try {
    const root = await repoRoot();
    return root ? path.join(root, REPO_CONFIG_FILE) : null;
  } catch {
    return null; // not in a git work tree (e.g. `gh-stack config` run anywhere)
  }
}

/**
 * Load env + repo + user layers. Files are re-read on every call (they're tiny
 * and commands resolve once or twice), so in-process tests that switch repos
 * never see a stale layer. Throws ConfigError; returns warnings to print.
 */
export async function loadConfigLayers(): Promise<{ layers: ConfigLayers; warnings: string[] }> {
  const repoPath = await repoConfigPath();
  const repo = repoPath ? loadConfigFile(repoPath) : null;
  const user = loadConfigFile(userConfigPath());
  return {
    layers: { env: process.env, repo: repo?.file ?? null, user: user.file },
    warnings: [...(repo?.warnings ?? []), ...user.warnings],
  };
}

/**
 * Resolve a setting for a command. An explicit flag decides without reading
 * any config, so a broken config file or env var can't stop a command (or a
 * chained one, like merge's restack) that was told exactly what to do.
 * Otherwise the layers are loaded: warnings go to stderr, and a ConfigError
 * is thrown for the command, or index.ts, to report.
 */
export async function resolveFlag(name: SettingName, args: string[]): Promise<Resolved> {
  const flag = flagSetting(name, args);
  if (flag) return flag;
  const { layers, warnings } = await loadConfigLayers();
  for (const w of warnings) console.error(`gh-stack: warning: ${w}`);
  return resolveSetting(name, [], layers);
}

/** Human-readable origin of a resolved value, e.g. `repo config (/x/.gh-stack.toml)`. */
export function describeSource(r: Resolved): string {
  switch (r.source) {
    case "flag":
      return `${r.origin} flag`;
    case "env":
      return `${r.origin} env var`;
    case "repo":
      return `repo config (${r.origin})`;
    case "user":
      return `user config (${r.origin})`;
    case "default":
      return "built-in default";
  }
}
