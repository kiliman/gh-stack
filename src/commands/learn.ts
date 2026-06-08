// gh-stack learn — teach agents how to drive gh-stack.
//
//   gh-stack learn            Print the canonical, version-stamped skill to stdout.
//   gh-stack learn --skill    Install it as a skill file for a coding harness.
//
// The skill text is compiled into the binary (src/lib/skill.ts), so it's always
// in lockstep with the installed version — no hand-maintained skill to drift.
import { homedir } from "node:os";
import { join } from "node:path";
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

function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
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
  --harness <name>        Target harness: claude | codex | cursor
                          (skips the interactive prompt)
  --global, -g            Install under your home dir (~/.<harness>/skills/...)
                          instead of the project root
  --force                 Overwrite an existing skill file without confirming
  --help                  Show this help

INSTALL PATHS
  Claude Code   <root>/.claude/skills/${SKILL_NAME}/SKILL.md
  Codex         <root>/.codex/skills/${SKILL_NAME}/SKILL.md
  Cursor        <root>/.cursor/skills/${SKILL_NAME}/SKILL.md

EXAMPLES
  gh-stack learn                          # print the skill to stdout
  gh-stack learn > AGENTS.md              # capture it however you like
  gh-stack learn --skill                  # interactive install (pick harness)
  gh-stack learn --skill --harness claude # install for Claude Code, no prompt
  gh-stack learn --skill --global -g      # install into your home dir
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

  // Resolve harness: explicit flag, else interactive prompt.
  let harness: Harness | undefined;
  const harnessFlag = flagValue(args, "--harness");
  if (harnessFlag) {
    harness = HARNESSES.find((h) => h.key === harnessFlag.toLowerCase());
    if (!harness) {
      p.log.error(
        `Unknown harness "${harnessFlag}". Choose one of: ${HARNESSES.map((h) => h.key).join(", ")}.`,
      );
      process.exitCode = 1;
      return;
    }
  } else if (autoYes) {
    p.log.error("Non-interactive mode needs an explicit harness: --harness <claude|codex|cursor>.");
    process.exitCode = 1;
    return;
  } else {
    const selected = await p.select({
      message: "Which harness is this skill for?",
      options: HARNESSES.map((h) => ({
        value: h.key,
        label: h.label,
        hint: `${global ? "~" : "."}/${h.dir}/skills/${SKILL_NAME}/`,
      })),
    });
    if (p.isCancel(selected)) {
      p.cancel("Cancelled.");
      return;
    }
    harness = HARNESSES.find((h) => h.key === selected)!;
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
  const target = join(root, harness.dir, "skills", SKILL_NAME, "SKILL.md");

  // Confirm overwrite unless --force / auto-yes.
  if ((await Bun.file(target).exists()) && !force && !autoYes) {
    const ok = await p.confirm({
      message: `${pc.yellow(target)} already exists. Overwrite?`,
    });
    if (p.isCancel(ok) || !ok) {
      p.cancel("Left existing skill in place.");
      return;
    }
  }

  await Bun.write(target, content); // creates parent dirs as needed

  p.log.success(`Installed ${harness.label} skill → ${pc.cyan(target)}`);
  p.log.info(
    `Stamped from gh-stack v${VERSION}. Refresh after upgrading with ${pc.dim("gh-stack learn --skill")}.`,
  );
}
