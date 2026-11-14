export type QueueSource =
  | { kind: "commit"; commit: string; worktreePath: string }
  | { kind: "handoff-patch"; patchPath: string; handoffPath: string; baseCommit: string; patchDigest: string };

export type QueueState = "queued" | "admitted" | "integrating" | "completed" | "preserved" | "conflict";

export type QueueReasonCode =
  | "TARGET_DIRTY"
  | "TARGET_NOT_CHECKED_OUT"
  | "TARGET_DRIFTED"
  | "TARGET_NOT_CANONICAL"
  | "DETACHED_HEAD"
  | "SEQUENCER_ACTIVE"
  | "GIT_FACTS_UNAVAILABLE"
  | "SOURCE_REPOSITORY_MISMATCH"
  | "SOURCE_DIRTY"
  | "SOURCE_HEAD_MISMATCH"
  | "STALE_SOURCE"
  | "HANDOFF_UNREADABLE"
  | "HANDOFF_EMPTY"
  | "HANDOFF_UNVERIFIED"
  | "HANDOFF_DIGEST_MISMATCH"
  | "HANDOFF_PATCH_UNREADABLE"
  | "DAEMON_RESTART_DURING_INTEGRATION"
  | "DAEMON_LEASE_LOST"
  | "DAEMON_PROTOCOL_ERROR"
  | "INTEGRATION_FAILED";

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
  leaseEpoch: number;
  createdAt: string;
  updatedAt: string;
  previousTargetHead?: string;
  integratedHead?: string;
  candidateCommit?: string;
  reasonCode?: QueueReasonCode;
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
