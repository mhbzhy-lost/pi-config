function textParts(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
    : "";
}

export function deterministicExecutorAcceptanceReport(userText, command) {
  if (command !== deterministicExecutorCommand(userText)) return undefined;
  const changedPath = command.match(/(?:README\.md|worker\.txt)/)?.[0];
  if (!changedPath) return undefined;
  return `\`\`\`acceptance-report\n${JSON.stringify({
    criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: `${changedPath} command completed.` }],
    changedFiles: [changedPath],
    testsAddedOrUpdated: [],
    commandsRun: [{ command, result: "passed", summary: "completed" }],
    validationOutput: [`${changedPath} command completed.`],
    residualRisks: [],
    noStagedFiles: true,
    diffSummary: `Applied deterministic ${changedPath} command.`,
  }, null, 2)}\n\`\`\``;
}

export function deterministicExecutorAllowsPath(userText, candidatePath) {
  const section = userText.match(/^## Declared Write Scope\n([\s\S]*?)(?:\n\n|$)/m)?.[1];
  const declared = section?.split("\n").flatMap((line) => {
    const scalar = line.match(/^\d+\. (.+)$/)?.[1];
    if (!scalar) return [];
    try {
      const value = JSON.parse(scalar);
      return typeof value === "string" ? [value] : [];
    } catch {
      return [];
    }
  }) ?? [];
  return declared.includes(candidatePath)
    || new RegExp(`^Allowed paths: ${candidatePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(userText);
}

export function deterministicExecutorCommand(userText) {
  if (deterministicExecutorAllowsPath(userText, "README.md")) {
    return "printf 'worker\\n' >> README.md && git add README.md && git commit -m 'test: 添加确定性 worker 标记'";
  }
  if (deterministicExecutorAllowsPath(userText, "worker.txt")) {
    return "printf 'worker-2\\n' > worker.txt && git add worker.txt && git commit -m 'test: 添加第二个确定性 worker 标记'";
  }
  return undefined;
}

export function decideDeterministicTurn({ messages = [], toolNames = [] } = {}) {
  const userText = messages.filter((message) => message?.role === "user").map(textParts).join("\n");
  const toolResults = messages.filter((message) => message?.role === "toolResult");
  const inventory = toolNames.join(",");

  const parentMode = userText.includes("PI_SUBAGENTS_COMPAT_PARENT_ATTENTION")
    ? "attention"
    : userText.includes("PI_SUBAGENTS_COMPAT_PARENT_COMPLETE")
      ? "complete"
      : undefined;
  if (parentMode) {
    const spawned = toolResults.some((message) => message.toolName === "compat_spawn");
    if (!spawned) return { tool: { name: "compat_spawn", arguments: { mode: parentMode } } };
    const waits = toolResults.filter((message) => message.toolName === "subagent_wait");
    if (parentMode === "complete") {
      return waits.length === 0
        ? { tool: { name: "subagent_wait", arguments: { all: true, timeoutMs: 30000 } } }
        : { text: "COMPAT_PARENT_DONE" };
    }

    if (!toolResults.some((message) => message.toolName === "compat_status")) {
      return { tool: { name: "compat_status", arguments: {} } };
    }
    if (!toolResults.some((message) => message.toolName === "compat_inspect_nested_events")) {
      return { tool: { name: "compat_inspect_nested_events", arguments: {} } };
    }
    const supervisorResults = toolResults.filter((message) => message.toolName === "subagent_supervisor");
    const pending = supervisorResults.find((message) => Array.isArray(message.details?.pending) && message.details.pending.length > 0);
    const replied = supervisorResults.some((message) => typeof message.details?.replyTo === "string");
    const emptyPendingCount = supervisorResults.filter((message) => Array.isArray(message.details?.pending) && message.details.pending.length === 0).length;
    const pauseCount = toolResults.filter((message) => message.toolName === "compat_pause").length;
    if (!replied && !pending) {
      if (emptyPendingCount >= 5) return { text: "COMPAT_PARENT_PENDING_MISSING" };
      if (pauseCount <= emptyPendingCount) return { tool: { name: "compat_pause", arguments: {} } };
      return { tool: { name: "subagent_supervisor", arguments: { action: "pending" } } };
    }
    if (!replied) {
      const requestId = pending?.details.pending[0]?.id;
      if (typeof requestId === "string" && requestId) {
        return { tool: { name: "subagent_supervisor", arguments: { action: "reply", replyTo: requestId, message: "APPROVED" } } };
      }
    }
    return waits.length === 0
      ? { tool: { name: "subagent_wait", arguments: { all: true, timeoutMs: 30000 } } }
      : { text: "COMPAT_PARENT_DONE" };
  }

  if (userText.includes("PI_SUBAGENTS_COMPAT_CHILD_COMPLETE")) {
    return { text: `COMPAT_OK tools=${inventory}` };
  }
  if (userText.includes("PI_SUBAGENTS_COMPAT_CHILD_ATTENTION")) {
    const replied = toolResults.some((message) => message.toolName === "contact_supervisor");
    if (replied) return { text: `COMPAT_OK tools=${inventory}` };
    if (toolNames.includes("contact_supervisor")) {
      return { tool: { name: "contact_supervisor", arguments: { reason: "need_decision", message: "Approve compatibility probe" } } };
    }
  }
  return undefined;
}
