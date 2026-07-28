function textParts(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
    : "";
}

export function deterministicExecutorCommand(userText) {
  if (/^Allowed paths: README\.md$/m.test(userText)) {
    return "printf 'worker\\n' >> README.md && git add README.md && git commit -m 'test: 添加确定性 worker 标记'";
  }
  if (/^Allowed paths: worker\.txt$/m.test(userText)) {
    return "printf 'worker-2\\n' > worker.txt && git add worker.txt && git commit -m 'test: 添加第二个确定性 worker 标记'";
  }
  return undefined;
}

export function decideDeterministicTurn({ messages = [], toolNames = [] } = {}) {
  const userText = messages.filter((message) => message?.role === "user").map(textParts).join("\n");
  const toolInventory = toolNames.join(",");

  const toolResults = messages.filter((message) => message?.role === "toolResult");
  if (/^Allowed paths: decision\.txt$/m.test(userText)) {
    const supervisorReplied = toolResults.some((message) => message.toolName === "contact_supervisor");
    const committed = toolResults.some((message) => message.toolName === "bash");
    if (!supervisorReplied && toolNames.includes("contact_supervisor")) {
      return {
        tool: {
          name: "contact_supervisor",
          arguments: { reason: "need_decision", message: "Approve the deterministic Plan Harness change" },
        },
      };
    }
    if (!committed && toolNames.includes("bash")) {
      return {
        tool: {
          name: "bash",
          arguments: {
            command: "printf 'approved\\n' > decision.txt && git add decision.txt && git commit -m 'test: 记录 Attention 决策结果'",
          },
        },
      };
    }
    return { text: "PLAN_EXECUTOR_DECISION_DONE" };
  }

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
      if (waits.length === 0) {
        return { tool: { name: "subagent_wait", arguments: { all: true, timeoutMs: 30000 } } };
      }
      return { text: "COMPAT_PARENT_DONE" };
    }

    const statusObserved = toolResults.some((message) => message.toolName === "compat_status");
    if (!statusObserved) {
      return { tool: { name: "compat_status", arguments: {} } };
    }
    const nestedInspected = toolResults.some((message) => message.toolName === "compat_inspect_nested_events");
    if (!nestedInspected) {
      return { tool: { name: "compat_inspect_nested_events", arguments: {} } };
    }
    const supervisorResults = toolResults.filter((message) => message.toolName === "subagent_supervisor");
    const pauseCount = toolResults.filter((message) => message.toolName === "compat_pause").length;
    const pending = supervisorResults.find((message) => Array.isArray(message.details?.pending) && message.details.pending.length > 0);
    const replied = supervisorResults.some((message) => typeof message.details?.replyTo === "string");
    const emptyPendingCount = supervisorResults.filter((message) => Array.isArray(message.details?.pending) && message.details.pending.length === 0).length;
    if (!replied && !pending) {
      if (emptyPendingCount >= 5) return { text: "COMPAT_PARENT_PENDING_MISSING" };
      if (pauseCount <= emptyPendingCount) return { tool: { name: "compat_pause", arguments: {} } };
      return { tool: { name: "subagent_supervisor", arguments: { action: "pending" } } };
    }
    if (!replied) {
      const requestId = pending?.details.pending[0]?.id;
      if (typeof requestId === "string" && requestId) {
        return {
          tool: {
            name: "subagent_supervisor",
            arguments: { action: "reply", replyTo: requestId, message: "APPROVED" },
          },
        };
      }
    }
    if (waits.length === 0) {
      return { tool: { name: "subagent_wait", arguments: { all: true, timeoutMs: 30000 } } };
    }
    return { text: "COMPAT_PARENT_DONE" };
  }

  if (userText.includes("PI_PLAN_HARNESS_STANDALONE")) {
    const bootstrap = userText.match(/exact bootstrap JSON:\s*\n(\{[^\n]+\})/)?.[1];
    const resultsFor = (name) => toolResults.filter((message) => message.toolName === name);
    const customDurableReply = messages.find((message) => message?.role === "custom"
      && message.customType === "pi-plan-attention-reply-v1");
    const convertedDurableReply = [...messages].reverse().find((message) => message?.role === "user"
      && textParts(message).trim() === "APPROVED");
    const latestPending = [...toolResults].reverse().find((message) => message.toolName === "subagent_supervisor"
      && Array.isArray(message.details?.pending) && message.details.pending.length > 0);
    const durableRequestId = customDurableReply?.details?.requestId ?? latestPending?.details?.pending?.[0]?.id;
    const durableMessage = customDurableReply
      ? (typeof customDurableReply.content === "string" ? customDurableReply.content : textParts(customDurableReply))
      : textParts(convertedDurableReply);
    const delivered = typeof durableRequestId === "string" && durableRequestId
      ? resultsFor("subagent_supervisor").some((message) => message.details?.replyTo === durableRequestId)
      : false;
    if (typeof durableRequestId === "string" && durableRequestId && durableMessage.trim()
      && !delivered && toolNames.includes("subagent_supervisor")) {
      return {
        tool: {
          name: "subagent_supervisor",
          arguments: { action: "reply", replyTo: durableRequestId, message: durableMessage },
        },
      };
    }
    if (resultsFor("plan_open").length === 0 && bootstrap && toolNames.includes("plan_open")) {
      return { tool: { name: "plan_open", arguments: JSON.parse(bootstrap) } };
    }
    const continues = resultsFor("plan_continue");
    const verifies = resultsFor("plan_verify");
    if (verifies.length > 0) return { text: "PLAN_HARNESS_DONE" };
    if (continues.length === 0 && toolNames.includes("plan_continue")) {
      return { tool: { name: "plan_continue", arguments: { reason: "harness" } } };
    }
    const latestContinue = textParts(continues.at(-1));
    if (/ready-to-verify/.test(latestContinue) && toolNames.includes("plan_verify")) {
      return { tool: { name: "plan_verify", arguments: {} } };
    }
    const supervisorResults = resultsFor("subagent_supervisor");
    const waits = resultsFor("subagent_wait");
    const statuses = resultsFor("plan_status");
    const latestStatus = textParts(statuses.at(-1));
    if (/"status":\s*"waiting-attention"/.test(latestStatus) && !delivered) {
      return { text: "PLAN_HARNESS_WAITING_ATTENTION" };
    }
    if (/"status":\s*"validated"|"status":\s*"succeeded"/.test(latestStatus) && toolNames.includes("plan_continue")) {
      return { tool: { name: "plan_continue", arguments: { reason: "integrate" } } };
    }
    if (/"status":\s*"accepted"|"status":\s*"integrated"/.test(latestStatus) && toolNames.includes("plan_verify")) {
      return { tool: { name: "plan_verify", arguments: {} } };
    }
    const round = statuses.length;
    if (supervisorResults.length < round * 2 + 1 && toolNames.includes("subagent_supervisor")) {
      return { tool: { name: "subagent_supervisor", arguments: { action: "pending" } } };
    }
    if (waits.length < round + 1 && toolNames.includes("subagent_wait")) {
      return { tool: { name: "subagent_wait", arguments: { all: false, timeoutMs: 1000 } } };
    }
    if (supervisorResults.length < round * 2 + 2 && toolNames.includes("subagent_supervisor")) {
      return { tool: { name: "subagent_supervisor", arguments: { action: "pending" } } };
    }
    if (toolNames.includes("plan_status")) {
      return { tool: { name: "plan_status", arguments: {} } };
    }
    return { text: "PLAN_HARNESS_WAITING" };
  }

  if (userText.includes("PI_SUBAGENTS_COMPAT_CHILD_COMPLETE")) {
    return { text: `COMPAT_OK tools=${toolInventory}` };
  }
  if (userText.includes("PI_SUBAGENTS_COMPAT_CHILD_ATTENTION")) {
    const replied = messages.some((message) => message?.role === "toolResult" && message.toolName === "contact_supervisor");
    if (replied) return { text: `COMPAT_OK tools=${toolInventory}` };
    if (toolNames.includes("contact_supervisor")) {
      return {
        tool: {
          name: "contact_supervisor",
          arguments: {
            reason: "need_decision",
            message: "Approve compatibility probe",
          },
        },
      };
    }
  }

  return undefined;
}
