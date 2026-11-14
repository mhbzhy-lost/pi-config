import { readHandoff } from "./repository.ts";
import type { QueueSource, WorktreeIntegrationReceipt } from "./records.ts";

export function classifyHandoff(handoffPath: string): Array<{ receipt: WorktreeIntegrationReceipt; source?: QueueSource }> {
  let facts;
  try { facts = readHandoff(handoffPath); }
  catch (error) {
    return [{ receipt: { kind: "git-worktree-integration", outcome: "failed-closed", repositoryRoot: "unknown", repositoryId: "unknown", worktreePath: handoffPath, clean: null, changedFiles: [], sequencer: false, handoffPath, requiresOperator: true, reasonCode: "HANDOFF_UNREADABLE", reason: error instanceof Error ? error.message : String(error), suggestedAction: "保留 handoff 文件并检查 upstream handoff 文件" } }];
  }
  if (facts.length === 0) return [{ receipt: { kind: "git-worktree-integration", outcome: "failed-closed", repositoryRoot: "unknown", repositoryId: "unknown", worktreePath: handoffPath, clean: null, changedFiles: [], sequencer: false, handoffPath, requiresOperator: true, reasonCode: "HANDOFF_EMPTY", reason: "handoff manifest 没有可处理的 child patch", suggestedAction: "保留 handoff 文件并检查 manifest 与 cleanup evidence" } }];
  return facts.map((fact) => {
    if (fact.patchChanged === false && fact.worktreeRemoved === true) return { receipt: { ...fact, kind: "git-worktree-integration", outcome: "no-change", requiresOperator: false } };
    if (fact.patchChanged === true && fact.worktreeRemoved === true && fact.patchPath && fact.patchDigest && fact.baseCommit && fact.handoffPath) {
      return { receipt: { ...fact, kind: "git-worktree-integration", outcome: "enqueued", requiresOperator: false, suggestedAction: "提交 handoff patch 到 Git queue" }, source: { kind: "handoff-patch", patchPath: fact.patchPath, handoffPath: fact.handoffPath, baseCommit: fact.baseCommit, patchDigest: fact.patchDigest } };
    }
    if (fact.worktreeRemoved !== true || fact.clean === false) return { receipt: { ...fact, kind: "git-worktree-integration", outcome: "preserved", requiresOperator: true, reasonCode: "WORKTREE_PRESERVED", reason: "upstream 保留了 worktree，不能自动集成", suggestedAction: "使用 git_queue_inspect 检查 worktree 后由主 agent 处理" } };
    return { receipt: { ...fact, kind: "git-worktree-integration", outcome: "failed-closed", requiresOperator: true, reasonCode: "HANDOFF_UNVERIFIED", reason: "handoff cleanup/patch 事实不足以安全集成", suggestedAction: "保留证据并人工复核" } };
  });
}
