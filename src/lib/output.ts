// Plain-mode-aware wrapper over @clack/prompts.
//
// In plain mode (--plain flag or GH_STACK_YES=1), we strip the decorative
// chrome that makes gh-stack output painful for agents/log consumers:
//   - no intro/outro boxes
//   - no spinners (start/stop lines collapse to plain prints)
//   - no ANSI colors (picocolors auto-disables via NO_COLOR; we also strip
//     any residual escapes defensively)
//
// Interactive prompts (text, confirm, select) are unchanged by plain mode —
// plain mode is about output, not interactivity. Agents already pair --plain
// with --yes/GH_STACK_YES so the interactive paths aren't reached. If one IS
// reached with no TTY on stdin, nothing can ever answer it, so we fail fast
// instead of blocking forever (#33).
import * as clack from "@clack/prompts";

let _plain = false;

export function setPlain(enabled: boolean): void {
  _plain = enabled;
}

export function isPlain(): boolean {
  return _plain;
}

const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
function strip(s: string | undefined): string {
  return (s ?? "").replace(ANSI_RE, "");
}

// ── Interactive prompts ──
export const isCancel = clack.isCancel;

/**
 * Exit non-zero instead of prompting when stdin isn't a TTY. A prompt there
 * can never be answered, and it would otherwise hang (holding the repo) past
 * the caller's timeout. (#33)
 */
function ensureInteractive(message: string): void {
  if (process.stdin.isTTY) return;
  console.error(
    `gh-stack: refusing to prompt — stdin is not a TTY.\n` +
      `  Prompt: ${strip(message)}\n` +
      `  Pass --yes (or set GH_STACK_YES=1) to confirm automatically.`,
  );
  process.exit(1);
}

export const text: typeof clack.text = (opts) => {
  ensureInteractive(opts.message);
  return clack.text(opts);
};

export const confirm: typeof clack.confirm = (opts) => {
  ensureInteractive(opts.message);
  return clack.confirm(opts);
};

export const select: typeof clack.select = (opts) => {
  ensureInteractive(opts.message);
  return clack.select(opts);
};

// ── Banner / error ──
export function intro(message?: string): void {
  if (_plain) {
    if (message) console.log(strip(message));
  } else {
    clack.intro(message);
  }
}

export function outro(message?: string): void {
  if (_plain) {
    if (message) console.log(strip(message));
  } else {
    clack.outro(message);
  }
}

export function cancel(message?: string): void {
  if (_plain) {
    if (message) console.error(strip(message));
  } else {
    clack.cancel(message);
  }
}

// ── log.* ──
export const log = {
  info: (msg: string) => (_plain ? console.log(strip(msg)) : clack.log.info(msg)),
  success: (msg: string) => (_plain ? console.log(strip(msg)) : clack.log.success(msg)),
  warn: (msg: string) => (_plain ? console.warn(strip(msg)) : clack.log.warn(msg)),
  error: (msg: string) => (_plain ? console.error(strip(msg)) : clack.log.error(msg)),
  step: (msg: string) => (_plain ? console.log(strip(msg)) : clack.log.step(msg)),
};

// ── stdout reservation (for --json) ──

const toStderr = (...args: unknown[]) => console.error(...args);

/**
 * Route everything that would reach stdout to stderr instead, and return a
 * writer for the real stdout. `--json` modes use it so stdout carries the JSON
 * document and nothing else, even when they call into code that logs (a chained
 * `restack`, clack prompts, raw console.log). Both channels need patching: Bun's
 * console.log writes to fd 1 directly, not through process.stdout.write.
 * There is no undo: it lasts for the rest of the process (one CLI command), so
 * tests exercise it through a spawned CLI rather than in-process.
 */
export function reserveStdout(): (text: string) => void {
  const realWrite = process.stdout.write.bind(process.stdout);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  return (text) => {
    realWrite(text);
  };
}

// ── Spinner ──
export interface Spinner {
  start: (msg?: string) => void;
  stop: (msg?: string, code?: number) => void;
  message: (msg?: string) => void;
}

export function spinner(): Spinner {
  if (!_plain) return clack.spinner() as Spinner;
  return {
    start: (msg) => {
      if (msg) console.log(strip(msg));
    },
    stop: (msg) => {
      if (msg) console.log(strip(msg));
    },
    message: (msg) => {
      if (msg) console.log(strip(msg));
    },
  };
}
