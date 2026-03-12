// TUI helpers: tree rendering, formatting, prompts
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Stack, Branch, StackMetadata } from "../types.ts";
import { getOrderedBranches } from "./metadata.ts";

/**
 * Render a stack as a tree with branch numbers, PR info, and current marker.
 */
export function renderStackTree(
  stack: Stack,
  currentBranch: string,
  options?: { showNumbers?: boolean }
): string {
  const ordered = getOrderedBranches(stack);
  const showNumbers = options?.showNumbers ?? true;
  const lines: string[] = [];

  lines.push(`${pc.green("◯")} main`);

  for (let i = 0; i < ordered.length; i++) {
    const branchName = ordered[i]!;
    const branch = stack.branches[branchName]!;
    const isLast = i === ordered.length - 1;
    const isCurrent = branchName === currentBranch;

    // Tree characters
    const tree = isLast ? "┗━◯" : "┣━◯";

    // Branch number label
    const numLabel = showNumbers
      ? `[${pc.blue(String(i + 1))}] `
      : "";

    // Current marker
    const marker = isCurrent ? ` ${pc.yellow("(current)")}` : "";

    // PR info
    const prNum = branch.pr ? `#${branch.pr}` : "(no PR)";
    const desc = branch.description || branchName;

    // Separator
    lines.push("┃");

    if (isCurrent) {
      lines.push(`${tree} ${numLabel}${pc.yellow(branchName)}${marker}`);
      lines.push(`┃   ${pc.blue(prNum)}: ${desc}`);
    } else {
      lines.push(`${tree} ${numLabel}${branchName}`);
      lines.push(`┃   ${pc.dim(`${prNum}: ${desc}`)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Display a header banner.
 */
export function header(title: string): void {
  p.intro(pc.cyan(title));
}

/**
 * Display a footer banner.
 */
export function footer(title: string): void {
  p.outro(pc.green(title));
}

/**
 * Interactive branch selector for a stack.
 * Returns the selected branch name, or null if cancelled.
 */
export async function selectBranch(
  stack: Stack,
  message: string,
  currentBranch?: string
): Promise<string | null> {
  const ordered = getOrderedBranches(stack);

  if (ordered.length === 0) {
    p.log.warn("No branches in this stack");
    return null;
  }

  const options = ordered.map((name) => {
    const branch = stack.branches[name]!;
    const prNum = branch.pr ? `#${branch.pr}` : "";
    const desc = branch.description || "";
    const current = name === currentBranch ? pc.yellow(" (current)") : "";
    const label = `${name}${current}`;
    const hint = [prNum, desc].filter(Boolean).join(" — ");

    return { value: name, label, hint };
  });

  const result = await p.select({
    message,
    options,
  });

  if (p.isCancel(result)) return null;
  return result as string;
}

/**
 * Interactive stack selector.
 * Returns the selected stack name, or null if cancelled.
 */
export async function selectStack(
  meta: StackMetadata,
  message: string
): Promise<string | null> {
  const stackNames = Object.keys(meta.stacks);

  if (stackNames.length === 0) {
    p.log.warn("No stacks found");
    return null;
  }

  const options = stackNames.map((name) => {
    const stack = meta.stacks[name]!;
    const branchCount = Object.keys(stack.branches).length;
    const current = name === meta.current_stack ? pc.yellow(" (current)") : "";
    const label = `${name}${current}`;
    const hint = `${branchCount} branch${branchCount !== 1 ? "es" : ""}${stack.description ? ` — ${stack.description}` : ""}`;

    return { value: name, label, hint };
  });

  const result = await p.select({
    message,
    options,
  });

  if (p.isCancel(result)) return null;
  return result as string;
}

/**
 * Interactive parent branch selector.
 * Offers: branches in stack, "main", or custom input.
 */
export async function selectParent(
  stack: Stack | null,
  currentBranch: string
): Promise<string | null> {
  const options: { value: string; label: string; hint?: string }[] = [
    { value: "main", label: "main", hint: "Base branch" },
  ];

  // Add stack branches (if we have a stack)
  if (stack) {
    const ordered = getOrderedBranches(stack);
    for (const name of ordered) {
      if (name !== currentBranch) {
        const branch = stack.branches[name]!;
        const prNum = branch.pr ? `#${branch.pr}` : "";
        options.push({
          value: name,
          label: name,
          hint: [prNum, branch.description].filter(Boolean).join(" — "),
        });
      }
    }
  }

  const result = await p.select({
    message: `Select parent branch for ${pc.yellow(currentBranch)}`,
    options,
  });

  if (p.isCancel(result)) return null;
  return result as string;
}

/**
 * Confirm a destructive action.
 */
export async function confirmAction(message: string): Promise<boolean> {
  const result = await p.confirm({ message });
  if (p.isCancel(result)) return false;
  return result;
}

/**
 * Format a branch for inline display.
 */
export function branchLabel(name: string): string {
  return pc.yellow(name);
}

/**
 * Format a PR number for inline display.
 */
export function prLabel(num: number): string {
  return pc.blue(`#${num}`);
}
