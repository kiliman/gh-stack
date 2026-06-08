// Canonical, version-stamped agent skill for gh-stack.
//
// The skill text is a plain Markdown file — `using-gh-stack.md` — bundled into
// the binary at build time via Bun's `type: "text"` import (it survives
// `bun build --compile`). Editing the skill means editing that .md file; this
// module only stamps the running version into the `{{VERSION}}` placeholder.
//
// It is the SINGLE SOURCE OF TRUTH for "how an agent should drive gh-stack":
// `gh-stack learn` prints it, `gh-stack learn --skill` installs it. Update the
// .md whenever a command or flag changes and the next release ships it.
import skillTemplate from "./using-gh-stack.md" with { type: "text" };

export const SKILL_NAME = "using-gh-stack";

/**
 * Build the full skill document, stamped with the running gh-stack version so
 * an installed copy always records which release generated it (and can be
 * refreshed with `gh-stack learn --skill`).
 */
export function skillContent(version: string): string {
  return skillTemplate.replaceAll("{{VERSION}}", version);
}
