// Plain-mode-aware wrapper over @clack/prompts.
//
// In plain mode (--plain flag or GH_STACK_YES=1), we strip the decorative
// chrome that makes gh-stack output painful for agents/log consumers:
//   - no intro/outro boxes
//   - no spinners (start/stop lines collapse to plain prints)
//   - no ANSI colors (picocolors auto-disables via NO_COLOR; we also strip
//     any residual escapes defensively)
//
// Interactive prompts (text, confirm, select) are re-exported unchanged —
// plain mode is about output, not interactivity. Agents already pair --plain
// with --yes/GH_STACK_YES so the interactive paths aren't reached.
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

// ── Interactive prompts (unchanged) ──
export const isCancel = clack.isCancel;
export const text = clack.text;
export const confirm = clack.confirm;
export const select = clack.select;

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
