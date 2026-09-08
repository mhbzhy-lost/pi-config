type WorkspaceReceipt = {
  workspaceId?: unknown;
  state?: unknown;
  mode?: unknown;
  run?: { runId?: unknown } | null;
};

type ReminderContext = {
  rootSessionId?: unknown;
  lifecycleSessionId?: unknown;
  service?: { listOwned(input: { ownerScope: { kind: "standalone-subagent"; rootSessionId: string }; runId: string }): WorkspaceReceipt[] };
};

type CompletionReminderOptions = {
  events: { on(type: string, listener: (event: unknown) => unknown): (() => unknown) | undefined };
  sendMessage(message: unknown, options: { deliverAs: "followUp"; triggerTurn: false }): unknown;
  getContext(): ReminderContext | undefined;
  onDiagnostic?: (diagnostic: { code: "SUBAGENT_WORKSPACE_REMINDER_AMBIGUOUS"; rootSessionId: string; runId: string; count: number }) => void;
};

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function terminalWorkspace(receipt: WorkspaceReceipt | undefined) {
  return receipt && text(receipt.workspaceId)
    && (receipt.state === "active" || receipt.state === "preserved")
    && text(receipt.run?.runId) ? receipt : undefined;
}

export function createWorkspaceCompletionReminder({ events, sendMessage, getContext, onDiagnostic }: CompletionReminderOptions) {
  const delivered = new Set<string>();
  const unsubscribe = events.on("subagent:async-complete", (event: unknown) => {
    const completion = event as { runId?: unknown; sessionId?: unknown; agent?: unknown };
    if (!text(completion.runId)) return;
    const context = getContext();
    if (!text(context?.rootSessionId) || !text(context?.lifecycleSessionId) || !context.service
        || !text(completion.sessionId) || completion.sessionId !== context.lifecycleSessionId) return;
    const ownerScope = Object.freeze({ kind: "standalone-subagent" as const, rootSessionId: context.rootSessionId });
    const matches = context.service.listOwned({ ownerScope, runId: completion.runId })
      .filter((receipt) => receipt?.run?.runId === completion.runId)
      .map(terminalWorkspace)
      .filter((receipt): receipt is WorkspaceReceipt & { workspaceId: string; state: "active" | "preserved"; run: { runId: string } } => Boolean(receipt));
    if (matches.length === 0) return;
    if (matches.length !== 1) {
      onDiagnostic?.({ code: "SUBAGENT_WORKSPACE_REMINDER_AMBIGUOUS", rootSessionId: context.rootSessionId, runId: completion.runId, count: matches.length });
      return;
    }
    const receipt = matches[0];
    const key = `${context.rootSessionId}\u0000${completion.runId}\u0000${receipt.workspaceId}\u0000${receipt.state}`;
    if (delivered.has(key)) return;
    delivered.add(key);
    sendMessage({
      customType: "subagent-workspace-reminder",
      content: `Subagent workspace awaiting disposition: ${receipt.workspaceId}. Call subagent_worktree({action:"status",workspace_id:"${receipt.workspaceId}"}), then integrate, discard, or preserve according to the returned allowed_dispositions. After preserve, use release when the workspace is no longer needed.`,
      display: true,
      details: {
        schemaVersion: "subagent-workspace-reminder.v1",
        rootSessionId: context.rootSessionId,
        runId: completion.runId,
        workspaceId: receipt.workspaceId,
        workspaceState: receipt.state,
        mode: text(receipt.mode) ? receipt.mode : "standalone-subagent",
      },
    }, { deliverAs: "followUp", triggerTurn: false });
  });
  return Object.freeze({ dispose() { delivered.clear(); unsubscribe?.(); } });
}
