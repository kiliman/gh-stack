// The import-free part of config. index.ts parses the GH_STACK_* booleans
// before it sets NO_COLOR, and picocolors reads NO_COLOR once when it loads, so
// nothing on this path may import a module that pulls picocolors in (config.ts
// does, through git.ts).

/** A config problem the user must fix: malformed TOML, a wrong-typed value. */
export class ConfigError extends Error {}

/**
 * Parse a boolean env var: 1/true/yes or 0/false/no (any case); empty =
 * unset. Anything else is an error, so a typo can't be silently ignored.
 */
export function parseEnvBool(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes"].includes(v)) return true;
  if (["0", "false", "no"].includes(v)) return false;
  throw new ConfigError(`${name}=${raw} is not a boolean (use 1/0, true/false, or yes/no).`);
}
