// gh-stack learn — teach agents how to drive gh-stack.
//
//   gh-stack learn            Print the canonical, version-stamped skill to stdout.
//   gh-stack learn --skill    Install it as a skill file for a coding harness.
//
// The skill text is compiled into the binary (src/lib/skill.ts), so it's always
// in lockstep with the installed version — no hand-maintained skill to drift.
import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import pc from "picocolors";
import * as p from "../lib/output.ts";
import * as git from "../lib/git.ts";
import { isAutoYes } from "../lib/ui.ts";
import { SKILL_NAME, skillContent } from "../lib/skill.ts";

const { version: VERSION } = await import("../../package.json");

interface Harness {
  key: string;
  label: string;
  dir: string; // the per-harness config dir, e.g. ".claude"
}

// Project-root install locations per harness. Global installs swap the repo
// root for the home directory (same `<dir>/skills/<name>/SKILL.md` shape).
const HARNESSES: Harness[] = [
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
): Promise<{ path: string; realPath: string } | undefined> {
  for (const path of [skillDir, target]) {
    try {
      if (!(await lstat(path)).isSymbolicLink()) continue;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined; // nothing below it either
      throw err;
    }
    let realPath: string;
    try {
      realPath = await realpath(path);
    } catch {
      realPath = resolve(dirname(path), await readlink(path)); // dangling link
    }
    return { path, realPath };
  }
  return undefined;
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
  Only --force writes through it; --yes / GH_STACK_YES does not.

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

  // Each target is checked and installed on its own: a refused symlink or a
  // declined overwrite skips that harness, and the rest still install. Any
  // refusal or write error makes the run exit non-zero.
  let installed = 0;
  for (const harness of harnesses) {
    const skillDir = join(root, harness.dir, "skills", SKILL_NAME);
    const target = join(skillDir, "SKILL.md");

    try {
      // Never write through a symlink unless --force says so explicitly.
      // Auto-yes accepts routine prompts; it must not overwrite a file that
      // lives somewhere else (often another repo) on the user's behalf.
      const link = await findSymlink(skillDir, target);
      if (link && !force) {
        const retry = `gh-stack learn --skill${global ? " --global" : ""} --harness ${harness.key} --force`;
        p.log.error(
          `${tildify(link.path)} is a symlink to ${tildify(link.realPath)}; not writing through it.\n` +
            `To overwrite the file it points to, run ${pc.dim(retry)}.`,
        );
        process.exitCode = 1;
        continue;
      }
      if (link) {
        p.log.warn(
          `${tildify(link.path)} is a symlink; writing through it to ${tildify(link.realPath)} (--force).`,
        );
      }

      // Confirm overwrite unless --force / auto-yes.
      if ((await Bun.file(target).exists()) && !force && !autoYes) {
        const ok = await p.confirm({
          message: `${pc.yellow(tildify(target))} already exists. Overwrite?`,
        });
        if (p.isCancel(ok)) {
          p.cancel("Cancelled.");
          return;
        }
        if (!ok) {
          p.log.info(`Left existing ${harness.label} skill in place.`);
          continue;
        }
      }

      await Bun.write(target, content); // creates parent dirs as needed
    } catch (err) {
      p.log.error(`Could not install ${harness.label} skill at ${tildify(target)}: ${err}`);
      process.exitCode = 1;
      continue;
    }

    installed++;
    p.log.success(`Installed ${harness.label} skill → ${pc.cyan(tildify(target))}`);
  }

  if (installed > 0) {
    p.log.info(
      `Stamped from gh-stack v${VERSION}. Refresh after upgrading with ${pc.dim("gh-stack learn --skill")}.`,
    );
  }
}
