// gh-stack metadata schema (v2)

export interface StackMetadata {
  version: 2;
  current_stack: string | null;
  stacks: Record<string, Stack>;
  archive?: Record<string, Stack>;
  snapshots?: Snapshot[];
}

export interface Stack {
  description: string;
  last_branch: string | null;
  branches: Record<string, Branch>;
}

export interface Branch {
  parent: string; // "main" or another branch name
  pr?: number; // GitHub PR number
  description?: string; // Human-readable label
}

export interface Snapshot {
  timestamp: string; // ISO 8601
  operation: string; // "restack" | "merge" | "sync" | "remove"
  branches: Record<string, string>; // branch name -> commit SHA
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
