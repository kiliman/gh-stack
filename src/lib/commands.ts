// Every command name the CLI accepts, aliases included, mapped to its module.
// Modules load lazily, so importing this table loads no command (and no
// picocolors). The help test runs every entry with --help, so a command added
// here without a help page fails it.

type CommandModule = { default: (args: string[]) => Promise<unknown> };

export const COMMANDS: Record<string, () => Promise<CommandModule>> = {
  log: () => import("../commands/log.ts"),
  init: () => import("../commands/init.ts"),
  create: () => import("../commands/create.ts"),
  add: () => import("../commands/add.ts"),
  submit: () => import("../commands/submit.ts"),
  checkout: () => import("../commands/checkout.ts"),
  co: () => import("../commands/checkout.ts"),
  up: () => import("../commands/up.ts"),
  down: () => import("../commands/down.ts"),
  top: () => import("../commands/top.ts"),
  bottom: () => import("../commands/bottom.ts"),
  ls: () => import("../commands/list.ts"),
  list: () => import("../commands/list.ts"),
  stacks: () => import("../commands/stacks.ts"),
  restack: () => import("../commands/restack.ts"),
  rebase: () => import("../commands/restack.ts"),
  sync: () => import("../commands/sync.ts"),
  merge: () => import("../commands/merge.ts"),
  split: () => import("../commands/split.ts"),
  join: () => import("../commands/join.ts"),
  rename: () => import("../commands/rename.ts"),
  delete: () => import("../commands/delete.ts"),
  untrack: () => import("../commands/untrack.ts"),
  status: () => import("../commands/status.ts"),
  undo: () => import("../commands/undo.ts"),
  archive: () => import("../commands/archive.ts"),
  "update-prs": () => import("../commands/update-prs.ts"),
  doctor: () => import("../commands/doctor.ts"),
  config: () => import("../commands/config.ts"),
  learn: () => import("../commands/learn.ts"),
};

/**
 * Commands that work outside a git repository: `learn` emits or installs the
 * agent skill (useful before cloning, or with --global), and `config` shows the
 * user and env layers anywhere.
 */
export const RUNS_OUTSIDE_REPO = new Set(["learn", "config"]);
