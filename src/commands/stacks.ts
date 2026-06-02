// gh-stack stacks — List all stacks and their topology (network-free).
//
// This is the machine-readable interface to stack metadata: `--json` emits the
// full topology (stacks, ordered branches, PR numbers, base) so external tools
// never have to reach into `.git/.gh-stack/` and parse the storage format
// themselves. It performs NO network calls and does NOT mutate metadata.
import pc from "picocolors";
import * as git from "../lib/git.ts";
import {
  readMetadata,
  metadataExists,
  legacyMetadataExists,
  getOrderedBranches,
  findStackForBranch,
  stackBase,
} from "../lib/metadata.ts";

export default async function stacks(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack stacks — List all stacks and their topology

USAGE
  gh-stack stacks [options]

OPTIONS
  --json       Output topology as JSON (for tools/scripts; no network calls)
  --current    Only the stack containing the current branch

Read-only and network-free — emits stack membership straight from local
metadata. Use --json as a stable interface so scripts don't parse the
.git/.gh-stack/ store directly.
`);
    return;
  }

  const jsonMode = args.includes("--json");
  const currentOnly = args.includes("--current");

  // Read-only: don't hard-block on unmigrated v2 metadata — just note it to
  // stderr (keeps stdout/JSON clean) and emit an empty result.
  if (!(await metadataExists())) {
    if (await legacyMetadataExists()) {
      process.stderr.write("Note: stack metadata is unmigrated (v2). Run `gh-stack doctor`.\n");
    }
    if (jsonMode) {
      console.log(
        JSON.stringify({ current_stack: null, current_branch: null, stacks: [] }, null, 2),
      );
    } else {
      console.log("No stacks found.");
    }
    return;
  }

  const meta = await readMetadata();
  if (!meta) {
    if (jsonMode) {
      console.log(
        JSON.stringify({ current_stack: null, current_branch: null, stacks: [] }, null, 2),
      );
    } else {
      console.log("No stacks found.");
    }
    return;
  }

  let currentBranch: string | null = null;
  try {
    currentBranch = await git.currentBranch();
  } catch {
    // Detached HEAD or not on a branch — fine, just no "current" context.
  }

  const currentStackName = currentBranch ? findStackForBranch(meta, currentBranch) : null;

  const entries = Object.entries(meta.stacks)
    .filter(([name]) => !currentOnly || name === currentStackName)
    .map(([name, stack]) => {
      const ordered = getOrderedBranches(stack);
      return {
        name,
        description: stack.description || "",
        base: stackBase(stack),
        is_current: name === currentStackName,
        branches: ordered.map((branchName) => {
          const b = stack.branches[branchName]!;
          return {
            branch: branchName,
            parent: b.parent,
            pr: b.pr ?? null,
            description: b.description ?? null,
          };
        }),
      };
    });

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          current_stack: currentStackName ?? meta.current_stack ?? null,
          current_branch: currentBranch,
          stacks: entries,
        },
        null,
        2,
      ),
    );
    return;
  }

  // ── Human-readable ──
  if (entries.length === 0) {
    console.log(currentOnly ? "Current branch is not in a stack." : "No stacks found.");
    return;
  }

  console.log();
  for (const stack of entries) {
    const marker = stack.is_current ? pc.yellow(" (current)") : "";
    console.log(`${pc.blue("📚")} ${pc.yellow(stack.name)}${marker} ${pc.dim(`→ ${stack.base}`)}`);
    if (stack.description) {
      console.log(`   ${pc.dim(stack.description)}`);
    }
    for (let i = 0; i < stack.branches.length; i++) {
      const b = stack.branches[i]!;
      const isLast = i === stack.branches.length - 1;
      const tree = isLast ? "┗━" : "┣━";
      const prNum = b.pr ? pc.dim(`#${b.pr}`) : pc.dim("(no PR)");
      const cur = currentBranch === b.branch ? pc.yellow(" 👈") : "";
      console.log(`   ${tree} ${i + 1}. ${b.branch} ${prNum}${cur}`);
    }
    console.log();
  }
}
