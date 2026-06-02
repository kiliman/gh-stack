// gh-stack metadata schema.
//
// `StackMetadata` is the in-memory shape shared by every command. Its on-disk
// representation has evolved (v1 monolith → v2 monolith → v3 per-stack files +
// git branch config), but the in-memory object stays stable so commands never
// need to know which storage version produced it. `version` reflects the
// store the object was assembled from.

export interface StackMetadata {
  version: 2 | 3;
  current_stack: string | null;
  stacks: Record<string, Stack>;
  archive?: Record<string, Stack>;
  snapshots?: Snapshot[];
}

export interface Stack {
  description: string;
  last_branch: string | null;
  branches: Record<string, Branch>;
  // The ref this stack is rooted on. Usually the trunk ("main"), but for a
  // stack that was split off another (see `gh-stack split`), this is a branch
  // belonging to the parent stack. The stack's root branch is the one whose
  // `parent` equals this value. Optional on disk for back-compat; treat a
  // missing value as "main" via `stackBase()`.
  base?: string;
}

export interface Branch {
  parent: string; // "main" or another branch name
  pr?: number; // GitHub PR number
  description?: string; // Human-readable label

  // ── submit caches (v0.9.0, issue #16) ──
  // Let `submit` skip redundant network calls when nothing relevant changed.
  prTitle?: string; // last-known GitHub PR title, for rendering the stack viz without a fetch
  prBase?: string; // last base we set on the PR via `gh pr edit --base`; skip the edit when parent is unchanged
  vizHash?: string; // hash of the stack-viz block we last wrote to this PR; skip the PATCH when it would be identical
}

export interface Snapshot {
  timestamp: string; // ISO 8601
  operation: string; // "restack" | "merge" | "sync" | "remove"
  branches: Record<string, string>; // branch name -> commit SHA
  stack?: string; // owning stack (v3: drives per-stack retention + file naming)
}

// Resume state for restack --resume
export interface RestackState {
  current_index: number;
  stack_name: string;
  chain: string[];
}

// PR info from GitHub API
export interface PrInfo {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "PENDING" | null;
  isDraft: boolean;
  url: string;
  updatedAt?: string;
  headRefName?: string; // branch name
  statusCheckRollup?: CheckRun[];
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

// Parsed PR status for display
export interface PrStatus extends PrInfo {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  pendingChecks: number;
  failedNames: string[];
}

// v1 schema (for migration)
export interface StackMetadataV1 {
  current_stack: string | null;
  stacks: Record<string, Stack>;
}
