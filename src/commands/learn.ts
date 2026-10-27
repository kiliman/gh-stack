// gh-stack learn — teach agents how to drive gh-stack.
//
//   gh-stack learn            Print the canonical, version-stamped skill to stdout.
//   gh-stack learn --skill    Install it as a skill file for a coding harness.
//
// The skill text is compiled into the binary (src/lib/skill.ts), so it's always
// in lockstep with the installed version — no hand-maintained skill to drift.
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import pc from "picocolors";
import * as p from "../lib/output.ts";
import * as git from "../lib/git.ts";
import { isAutoYes } from "../lib/ui.ts";
import { SKILL_NAME, skillContent } from "../lib/skill.ts";

const { version: VERSION } = await import("../../package.json");

export interface Harness {
  key: string;
  label: string;
  dir: string; // the per-harness config dir, e.g. ".claude"
}

// Project-root install locations per harness. Global installs swap the repo
// root for the home directory (same `<dir>/skills/<name>/SKILL.md` shape).
export const HARNESSES: Harness[] = [
  { key: "claude", label: "Claude Code", dir: ".claude" },
  { key: "codex", label: "Codex", dir: ".codex" },
  { key: "cursor", label: "Cursor", dir: ".cursor" },
];

const HARNESS_CHOICES = `${HARNESSES.map((h) => h.key).join(" | ")} | all`;

function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

/**
 * Parse `--harness`: one key, a comma list (`claude,codex`), or `all`.
 * Returns the harnesses in canonical order, or an error message.
 */
function parseHarnesses(value: string): Harness[] | string {
  const keys = new Set(
    value
      .toLowerCase()
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
  const unknown = [...keys].filter((k) => k !== "all" && !HARNESSES.some((h) => h.key === k));
  if (keys.size === 0 || unknown.length > 0) {
    const bad = unknown.length > 0 ? unknown.join(", ") : value;
    return `Unknown harness "${bad}". Choose from: ${HARNESSES.map((h) => h.key).join(", ")}, or all (comma lists work too).`;
  }
  return keys.has("all") ? HARNESSES : HARNESSES.filter((h) => keys.has(h.key));
}

/** Shorten a path under the home directory to `~/...` for display. */
function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * The first symlink on the install path — the skill dir, then SKILL.md — and
 * where it points. `lstat`, not `stat`: `Bun.write` follows symlinks, so a
 * symlinked skill dir (e.g. per-skill links into a version-controlled skills
 * repo) would otherwise be silently overwritten at its real location.
 */
async function findSymlink(
  skillDir: string,
  target: string,
): Promise<{ path: string; realPath: string; dangling: boolean } | undefined> {
  for (const path of [skillDir, target]) {
    try {
      if (!(await lstat(path)).isSymbolicLink()) continue;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined; // nothing below it either
      throw err;
    }
    // lstat says link, stat says nothing there: a dangling link.
    const dangling = await stat(path).then(
      () => false,
      () => true,
    );
    const realPath = dangling ? resolve(dirname(path), await readlink(path)) : await realpath(path);
    return { path, realPath, dangling };
  }
  return undefined;
}

/**
 * Where `path` really lands once every symlink along it is followed, including
 * dangling links and components that don't exist yet. Two harnesses whose
 * paths resolve to the same file share one SKILL.md.
 */
async function resolveReal(path: string, depth = 0): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Missing somewhere along the way; resolve what exists and append the rest.
  }
  if (depth < 40) {
    const st = await lstat(path).catch(() => undefined);
    if (st?.isSymbolicLink()) {
      return resolveReal(resolve(dirname(path), await readlink(path)), depth + 1);
    }
  }
  const parent = dirname(path);
  if (parent === path) return path;
  return join(await resolveReal(parent, depth + 1), basename(path));
}

/** Whether the skill dir or SKILL.md itself is a symlink (ancestors don't count). */
async function isSkillLevelLink(skillDir: string, target: string): Promise<boolean> {
  for (const path of [skillDir, target]) {
    const st = await lstat(path).catch(() => undefined);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

/** `"cancel"` when the user aborts the prompt (Ctrl-C / Esc). */
export type ConfirmFn = (message: string) => Promise<boolean | "cancel">;

export interface InstallOptions {
  root: string;
  harnesses: Harness[];
  content: string;
  global: boolean;
  force: boolean;
  autoYes: boolean;
  confirm: ConfirmFn;
}

export interface InstallResult {
  /** False if any target was refused or failed, or the run was cancelled. */
  ok: boolean;
  cancelled: boolean;
  installed: string[]; // harness keys, including aliases of a written file
  notAttempted: string[]; // harness keys left untouched by a cancel
}

/**
 * Install the skill for each harness. Each target is checked on its own: a
 * refused symlink, a dangling link, or a declined overwrite skips that harness
 * and the rest still install. Harnesses that resolve to the same SKILL.md (a
 * linked skill dir, or a shared `skills/` dir) are written once, through the
 * harness whose own skill path isn't a link, and the others are reported as
 * aliases of it.
 */
export async function installSkills(opts: InstallOptions): Promise<InstallResult> {
  const { root, harnesses, content, global, force, autoYes, confirm } = opts;

  const targets = await Promise.all(
    harnesses.map(async (harness) => {
      const skillDir = join(root, harness.dir, "skills", SKILL_NAME);
      const path = join(skillDir, "SKILL.md");
      return {
        harness,
        skillDir,
        path,
        real: await resolveReal(path),
        linked: await isSkillLevelLink(skillDir, path),
      };
    }),
  );
  type Target = (typeof targets)[number];

  // Group by real file. The primary writes it; the others are aliases.
  const groups = new Map<string, Target[]>();
  for (const t of targets) groups.set(t.real, [...(groups.get(t.real) ?? []), t]);
  const primaryOf = (group: Target[]) => group.find((t) => !t.linked) ?? group[0]!;

  const result: InstallResult = { ok: true, cancelled: false, installed: [], notAttempted: [] };
  const handled = new Set<string>();

  for (const t of targets) {
    if (handled.has(t.harness.key)) continue;
    const group = groups.get(t.real)!;
    const primary = primaryOf(group);
    const outcome = await installOne(primary);

    if (outcome === "cancel") {
      result.cancelled = true;
      result.ok = false;
      result.notAttempted = targets
        .map((x) => x.harness.key)
        .filter((k) => !handled.has(k) && !result.installed.includes(k));
      const names = (keys: string[]) =>
        keys.length > 0
          ? keys.map((k) => HARNESSES.find((h) => h.key === k)!.label).join(", ")
          : "nothing";
      p.cancel(
        `Cancelled. Installed: ${names(result.installed)}. Not attempted: ${names(result.notAttempted)}.`,
      );
      return result;
    }

    handled.add(primary.harness.key);
    if (outcome === "installed") result.installed.push(primary.harness.key);
    if (outcome === "failed") result.ok = false; // "declined" was the user's choice, not a failure

    for (const alias of group) {
      if (alias === primary) continue;
      handled.add(alias.harness.key);
      const via = `${tildify(alias.skillDir)} resolves to ${tildify(alias.real)}`;
      if (outcome === "installed") {
        result.installed.push(alias.harness.key);
        p.log.info(
          `${alias.harness.label}: ${via}; already installed via ${primary.harness.label}.`,
        );
      } else {
        p.log.info(
          `${alias.harness.label}: ${via}, the same file as ${primary.harness.label}; not installed (see above).`,
        );
      }
    }
  }
  return result;

  async function installOne(t: Target): Promise<"installed" | "declined" | "failed" | "cancel"> {
    const { harness, skillDir, path } = t;
    try {
      const link = await findSymlink(skillDir, path);
      // A dangling link can't be written through, --force or not.
      if (link?.dangling) {
        p.log.error(
          `${tildify(link.path)} is a dangling symlink to ${tildify(link.realPath)}, which does not exist.\n` +
            `Remove the link (${pc.dim(`rm ${tildify(link.path)}`)}) and re-run to install there.`,
        );
        return "failed";
      }
      // Never write through a symlink unless --force says so explicitly.
      // Auto-yes accepts routine prompts; it must not overwrite a file that
      // lives somewhere else (often another repo) on the user's behalf.
      if (link && !force) {
        const retry = `gh-stack learn --skill${global ? " --global" : ""} --harness ${harness.key} --force`;
        p.log.error(
          `${tildify(link.path)} is a symlink to ${tildify(link.realPath)}; not writing through it.\n` +
            `To overwrite the file it points to, run ${pc.dim(retry)}.`,
        );
        return "failed";
      }
      if (link) {
        p.log.warn(
          `${tildify(link.path)} is a symlink; writing through it to ${tildify(link.realPath)} (--force).`,
        );
      }

      // Confirm overwrite unless --force / auto-yes.
      if ((await Bun.file(path).exists()) && !force && !autoYes) {
        const ok = await confirm(`${pc.yellow(tildify(path))} already exists. Overwrite?`);
        if (ok === "cancel") return "cancel";
        if (!ok) {
          p.log.info(`Left existing ${harness.label} skill in place.`);
          return "declined";
        }
      }

      await Bun.write(path, content); // creates parent dirs as needed
    } catch (err) {
      p.log.error(`Could not install ${harness.label} skill at ${tildify(path)}: ${err}`);
      return "failed";
    }
    p.log.success(`Installed ${harness.label} skill → ${pc.cyan(tildify(path))}`);
    return "installed";
  }
}

export default async function learn(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack learn — teach an agent how to use gh-stack

USAGE
  gh-stack learn [--skill] [options]

By default, prints the canonical gh-stack skill (Markdown, stamped with the
current version) to stdout. The text is compiled into the binary, so it never
drifts out of sync with the installed version.

OPTIONS
  --skill                 Install the skill into a project (or --global) instead
                          of printing it
  --harness <name>        Target harness: ${HARNESS_CHOICES}, or a comma
                          list such as claude,codex (skips the interactive prompt)
  --global, -g            Install under your home dir (~/.<harness>/skills/...)
                          instead of the project root
  --force                 Overwrite an existing skill file without confirming,
                          and write through a symlinked skill dir or SKILL.md
  --help                  Show this help

INSTALL PATHS
  Claude Code   <root>/.claude/skills/${SKILL_NAME}/SKILL.md
  Codex         <root>/.codex/skills/${SKILL_NAME}/SKILL.md
  Cursor        <root>/.cursor/skills/${SKILL_NAME}/SKILL.md

SYMLINKS
  If the skill dir or SKILL.md is a symlink (e.g. into a skills repo you keep
  under version control), the install refuses and names the link target.
  Only --force writes through it; --yes / GH_STACK_YES does not. A dangling
  link is never written through: remove it to install there. Harnesses that
  resolve to the same SKILL.md (a linked skill dir or a shared skills/ dir)
  are written once and reported as installed via the first.

EXAMPLES
  gh-stack learn                          # print the skill to stdout
  gh-stack learn > AGENTS.md              # capture it however you like
  gh-stack learn --skill                  # interactive install (pick harness)
  gh-stack learn --skill --harness claude # install for Claude Code, no prompt
  gh-stack learn --skill --global -g      # install into your home dir
  gh-stack learn --skill -g --harness all # every harness, in your home dir
`);
    return;
  }

  const content = skillContent(VERSION);

  // Default: just print the skill. No chrome — pipe-friendly for agents.
  if (!args.includes("--skill")) {
    console.log(content);
    return;
  }

  // ── Install mode ──
  const global = args.includes("--global") || args.includes("-g");
  const force = args.includes("--force");
  const autoYes = isAutoYes();

  // Resolve harnesses: explicit flag, else interactive prompt.
  let harnesses: Harness[];
  const harnessFlag = flagValue(args, "--harness");
  if (harnessFlag) {
    const parsed = parseHarnesses(harnessFlag);
    if (typeof parsed === "string") {
      p.log.error(parsed);
      process.exitCode = 1;
      return;
    }
    harnesses = parsed;
  } else if (autoYes) {
    p.log.error(`Non-interactive mode needs an explicit harness: --harness <${HARNESS_CHOICES}>.`);
    process.exitCode = 1;
    return;
  } else {
    const selected = await p.select({
      message: "Which harness is this skill for?",
      options: [
        ...HARNESSES.map((h) => ({
          value: h.key,
          label: h.label,
          hint: `${global ? "~" : "."}/${h.dir}/skills/${SKILL_NAME}/`,
        })),
        { value: "all", label: "All of the above" },
      ],
    });
    if (p.isCancel(selected)) {
      p.cancel("Cancelled.");
      process.exitCode = 1;
      return;
    }
    harnesses = selected === "all" ? HARNESSES : HARNESSES.filter((h) => h.key === selected);
  }

  // Resolve install root: home dir (--global) or repo working-tree root.
  let root: string;
  if (global) {
    root = homedir();
  } else if (await git.isGitRepo()) {
    root = await git.repoRoot();
  } else {
    p.log.error("Not inside a git repository. Run from a project, or use --global.");
    process.exitCode = 1;
    return;
  }

  const result = await installSkills({
    root,
    harnesses,
    content,
    global,
    force,
    autoYes,
    confirm: async (message) => {
      const ok = await p.confirm({ message });
      return p.isCancel(ok) ? "cancel" : ok;
    },
  });
  if (!result.ok) process.exitCode = 1;

  if (result.installed.length > 0) {
    p.log.info(
      `Stamped from gh-stack v${VERSION}. Refresh after upgrading with ${pc.dim(refreshCommand(harnesses, global))}.`,
    );
  }
}

/** The command that re-runs this install with the same scope, prompt-free. */
export function refreshCommand(harnesses: Harness[], global: boolean): string {
  const spec =
    harnesses.length === HARNESSES.length ? "all" : harnesses.map((h) => h.key).join(",");
  return `gh-stack learn --skill${global ? " --global" : ""} --harness ${spec}`;
}
