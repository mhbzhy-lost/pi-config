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
  const latestUserMessage = [...messages].reverse().find((message) => message?.role === "user");
  const latestUserText = textParts(latestUserMessage);
  const latestPrivateWake = latestUserText.split("\n").includes("A durable Root broker wake is pending.");
  const toolInventory = toolNames.join(",");

  const toolResults = messages.filter((message) => message?.role === "toolResult");
  const rootHarnessMarker = "PI_PLAN_FLAT_ROOT_HARNESS";
  const rootHarnessMarkerIndex = userText.indexOf(rootHarnessMarker);
  if (rootHarnessMarkerIndex >= 0) {
    const rootHarnessLines = userText.slice(rootHarnessMarkerIndex + rootHarnessMarker.length).split("\n");
    const rootHarnessJson = rootHarnessLines[1];
    let planPaths;
    try {
      planPaths = JSON.parse(rootHarnessJson).planPaths;
    } catch {}
    if (Array.isArray(planPaths) && planPaths.length > 0 && planPaths.every((planPath) => typeof planPath === "string" && planPath)) {
      const planRunResults = toolResults.filter((message) => message.toolName === "plan_run");
      if (planRunResults.some((message) => message.isError)) return { text: "PLAN_ROOT_LAUNCH_FAILED" };
      if (planRunResults.length >= planPaths.length) return { text: "PLAN_ROOT_WAITING" };
      if (toolNames.includes("plan_run")) {
        return { tool: { name: "plan_run", arguments: { planPath: planPaths[planRunResults.length] } } };
      }
    }
  }

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

  const bootstrap = userText.match(/Open the approved Plan revision by calling plan_open exactly once with (\{[^\n]+\})\./)?.[1];
  if (bootstrap || latestPrivateWake) {
    const resultsFor = (name) => toolResults.filter((message) => message.toolName === name);
    const customDurableReply = [...messages].reverse().find((message) => message?.role === "custom"
      && message.customType === "pi-plan-attention-reply-v1");
    const durableRequestId = customDurableReply?.details?.requestId;
    const durableRunId = customDurableReply?.details?.runId;
    const durableMessage = typeof customDurableReply?.content === "string"
      ? customDurableReply.content : textParts(customDurableReply);
    const delivered = typeof durableRequestId === "string" && durableRequestId
      ? resultsFor("plan_executor_supervisor").some((message) => message.details?.replyTo === durableRequestId)
      : false;
    if (typeof durableRequestId === "string" && durableRequestId && typeof durableRunId === "string" && durableRunId
      && durableMessage.trim() && !delivered && toolNames.includes("plan_executor_supervisor")) {
      return {
        tool: {
          name: "plan_executor_supervisor",
          arguments: { action: "reply", replyTo: durableRequestId, to: durableRunId, message: durableMessage },
        },
      };
    }
    if (!latestPrivateWake && resultsFor("plan_open").length === 0 && toolNames.includes("plan_open")) {
      return { tool: { name: "plan_open", arguments: JSON.parse(bootstrap) } };
    }
    const latestPushIndex = messages.findLastIndex((message) => message?.role === "custom"
      && ["pi-root-subagent-lifecycle-v1", "subagent_supervisor_request"].includes(message.customType));
    const latestStatusIndex = messages.findLastIndex((message) => message?.role === "toolResult" && message.toolName === "plan_status");
    if (latestPushIndex > latestStatusIndex && toolNames.includes("plan_status")) {
      return { tool: { name: "plan_status", arguments: {} } };
    }
    const continues = resultsFor("plan_continue");
    const verifies = resultsFor("plan_verify");
    if (verifies.length > 0) return { text: "PLAN_RUNNER_DONE" };
    if (continues.length === 0 && toolNames.includes("plan_continue")) {
      return { tool: { name: "plan_continue", arguments: { reason: "harness" } } };
    }
    const latestContinueIndex = messages.findLastIndex((message) => message?.role === "toolResult" && message.toolName === "plan_continue");
    const latestContinue = textParts(messages[latestContinueIndex]);
    let continueState;
    let dispatches = [];
    try {
      const parsed = JSON.parse(latestContinue);
      continueState = parsed.state;
      dispatches = parsed.dispatches ?? [];
    } catch {}
    if (continueState === "ready-to-verify" && toolNames.includes("plan_verify")) {
      return { tool: { name: "plan_verify", arguments: {} } };
    }
    if (continueState === "dispatch-required") {
      const dispatched = messages.filter((message, index) => index > latestContinueIndex
        && message?.role === "toolResult" && message.toolName === "subagent").length;
      if (dispatched < dispatches.length && toolNames.includes("subagent")) {
        return { tool: { name: "subagent", arguments: dispatches[dispatched].contract } };
      }
      if (latestStatusIndex <= latestContinueIndex) return { text: "PLAN_RUNNER_WAITING_LIFECYCLE" };
    }
    const latestStatus = latestStatusIndex >= 0 ? textParts(messages[latestStatusIndex]) : "";
    if (/"status":\s*"waiting-attention"/.test(latestStatus)) return { text: "PLAN_RUNNER_WAITING_ATTENTION" };
    if (/"status":\s*"active"|"status":\s*"started"/.test(latestStatus)) return { text: "PLAN_RUNNER_WAITING_LIFECYCLE" };
    if (/"status":\s*"validated"|"status":\s*"succeeded"/.test(latestStatus) && latestStatusIndex > latestContinueIndex && toolNames.includes("plan_continue")) {
      return { tool: { name: "plan_continue", arguments: { reason: "integrate" } } };
    }
    if (/"status":\s*"accepted"|"status":\s*"integrated"/.test(latestStatus) && toolNames.includes("plan_verify")) {
      return { tool: { name: "plan_verify", arguments: {} } };
    }
    return { text: "PLAN_RUNNER_WAITING_LIFECYCLE" };
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
