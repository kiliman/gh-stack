// The saved state of a restack/sync/join run, read back: is a run still
// pending, where did it stop, and what did it do (#15, #29).
//
// The state itself is written by restack.ts as the run goes (see RestackState).
// This module only interprets it, so `restack`, `sync`, `merge`, `join` and
// `undo` agree on what "an interrupted run" means.
import pc from "picocolors";
import * as p from "./output.ts";
import { InvalidRunStateError, clearRestackState, loadRestackState } from "./metadata.ts";
import type { RestackState, RunLogEntry } from "../types.ts";

/**
 * The saved run state, or null. A state that can't be used (unreadable, or
 * from another gh-stack version) is never upgraded: with `discard` (the
 * `--fresh` path) it's deleted with a note, otherwise this exits 1 saying how
 * to discard it.
 */
export async function loadRunState(opts: { discard?: boolean } = {}): Promise<RestackState | null> {
  try {
    return await loadRestackState();
  } catch (err) {
    if (!(err instanceof InvalidRunStateError)) throw err;
    if (opts.discard) {
      p.log.warn(`Discarding the saved run state at ${err.path}: ${err.reason}.`);
      await clearRestackState();
      return null;
    }
    p.cancel(
      `${err.message}\n\n  Discard it and restack from the current branch:\n    ${pc.green("gh-stack restack --fresh")}`,
    );
    process.exit(1);
  }
}

/**
 * A saved run that hasn't finished: a conflict stop, a kill, failed or held
 * pushes, or a rebase that was saved as started but never ran (or was
 * aborted). All of them are resumable; nothing is inferred from the branch
 * position, since a kill before the rebase started looks just like an abort.
 */
export async function findPendingRun(
  opts: { discard?: boolean } = {},
): Promise<RestackState | null> {
  const state = await loadRunState(opts);
  return state && !state.finished_at ? state : null;
}

/** Branches whose push failed, was declined or held, and hasn't succeeded since. */
export function outstandingPushes(state: RestackState): string[] {
  const out = new Set<string>();
  for (const e of state.log) {
    if (e.action === "push-failed" || e.action === "push-declined" || e.action === "push-held") {
      out.add(e.branch);
    } else if (e.action === "pushed") {
      out.delete(e.branch);
    }
  }
  return [...out];
}

/** Where the run stopped, for "An interrupted sync was detected (stopped at …)". */
export function stoppedAt(state: RestackState): string {
  if (state.rebase) return `${state.rebase.branch}: rebasing onto ${state.rebase.onto}`;
  const next = state.chain[state.current_index];
  if (next) return next;
  const unpushed = outstandingPushes(state);
  if (unpushed.length > 0) return `${unpushed.join(", ")}: not pushed`;
  return "the end of its chain";
}

/** What's left for a resume to do, one line per item. */
export function remainingSteps(state: RestackState): string[] {
  const steps: string[] = [];
  for (const b of outstandingPushes(state)) steps.push(`push ${b}`);
  if (state.rebase) steps.push(`finish rebasing ${state.rebase.branch}, then push it`);
  const from = state.current_index + (state.rebase ? 1 : 0);
  const rest = state.chain.slice(from);
  if (rest.length > 0) steps.push(`restack and push ${rest.join(", ")}`);
  return steps;
}

export function formatLogEntry(e: RunLogEntry): string {
  const b = pc.yellow(e.branch);
  switch (e.action) {
    case "rebased":
      return `${pc.green("✓")} rebased ${b} onto ${e.onto ?? "its parent"}`;
    case "up-to-date":
      return `${pc.dim("·")} ${b} already on ${e.onto ?? "its parent"}`;
    case "rebase-declined":
      return `${pc.dim("–")} skipped rebasing ${b} (declined)`;
    case "pushed":
      return `${pc.green("✓")} pushed ${b}`;
    case "push-failed":
      return `${pc.red("✗")} push of ${b} failed`;
    case "push-declined":
      return `${pc.yellow("–")} push of ${b} declined`;
    case "push-held":
      return `${pc.yellow("⏸")} held ${b} back${e.detail ? ` (${e.detail})` : ""}`;
    case "local-only":
      return `${pc.dim("·")} ${b} is local-only (not submitted), not pushed`;
  }
}

/** The run's log as indented lines (empty when nothing happened yet). */
export function formatRunLog(state: RestackState): string[] {
  return state.log.map((e) => `  ${formatLogEntry(e)}`);
}

/** "sync, started 2026-10-27 14:03" (local time) */
const two = (n: number) => String(n).padStart(2, "0");

export function describeRun(state: RestackState): string {
  const at = state.started_at ? new Date(state.started_at) : null;
  if (!at || Number.isNaN(at.getTime())) return state.command;
  const when = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
  return `${state.command}, started ${when}`;
}
