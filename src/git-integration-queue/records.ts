export type QueueSource =
  | { kind: "commit"; commit: string }
  | { kind: "handoff-patch"; patchPath: string; handoffPath: string; baseCommit: string; patchDigest: string };

export type QueueState = "queued" | "integrating" | "completed" | "preserved" | "conflict";

export type QueueItem = {
  version: 1;
  requestId: string;
  sequence: number;
  repositoryRoot: string;
  repositoryId: string;
  targetRef: string;
  source: QueueSource;
  metadata?: Record<string, string>;
  state: QueueState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  previousTargetHead?: string;
  integratedHead?: string;
  candidateCommit?: string;
  reasonCode?: string;
  reason?: string;
};

export type QueueStatus = {
  repositoryRoot: string;
  repositoryId: string;
  items: QueueItem[];
};

export type WorktreeFacts = {
  repositoryRoot: string;
  repositoryId: string;
  worktreePath?: string;
  targetRef?: string;
  baseCommit?: string;
  headCommit?: string;
  clean: boolean | null;
  changedFiles: string[];
  sequencer: boolean;
  worktreeRemoved?: boolean;
  patchChanged?: boolean;
  patchPath?: string;
  handoffPath?: string;
  patchDigest?: string;
};

export type IntegrationOutcome = "no-change" | "enqueued" | "preserved" | "failed-closed";

export type WorktreeIntegrationReceipt = WorktreeFacts & {
  kind: "git-worktree-integration";
  outcome: IntegrationOutcome;
  queueRequestId?: string;
  reasonCode?: string;
  reason?: string;
  requiresOperator: boolean;
  suggestedAction?: string;
};
