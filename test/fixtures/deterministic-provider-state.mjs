function textParts(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
    : "";
}

const lifecycleUpdateMarker = "A lifecycle update arrived. Call plan_status.";

export function deterministicContractKey(contract) {
  if (Array.isArray(contract)) return `[${contract.map(deterministicContractKey).join(",")}]`;
  if (contract && typeof contract === "object") {
    return `{${Object.keys(contract).sort().map((key) => `${JSON.stringify(key)}:${deterministicContractKey(contract[key])}`).join(",")}}`;
  }
  return JSON.stringify(contract);
}

export function deterministicExecutorAcceptanceReport(userText, command) {
  if (command !== deterministicExecutorCommand(userText)) return undefined;
  const path = command.match(/(?:README\.md|worker\.txt)/)?.[0];
  if (!path) return undefined;
  return `\`\`\`acceptance-report\n${JSON.stringify({
    criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: `${path} command completed.` }],
    changedFiles: [path],
    testsAddedOrUpdated: [],
    commandsRun: [{ command, result: "passed", summary: "completed" }],
    validationOutput: [`${path} command completed.`],
    residualRisks: [],
    noStagedFiles: true,
    diffSummary: `Applied deterministic ${path} command.`,
  }, null, 2)}\n\`\`\``;
}

export function deterministicExecutorCommand(userText) {
  const declaredWritePaths = (() => {
    const section = userText.match(/^## Declared Write Scope\n([\s\S]*?)(?:\n\n|$)/m)?.[1];
    if (!section) return [];
    return section.split("\n").flatMap((line) => {
      const scalar = line.match(/^\d+\. (.+)$/)?.[1];
      if (!scalar) return [];
      try {
        const path = JSON.parse(scalar);
        return typeof path === "string" ? [path] : [];
      } catch {
        return [];
      }
    });
  })();
  const allows = (path) => declaredWritePaths.includes(path)
    || new RegExp(`^Allowed paths: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(userText);
  if (allows("README.md")) {
    return "printf 'worker\\n' >> README.md && git add README.md && git commit -m 'test: 添加确定性 worker 标记'";
  }
  if (allows("worker.txt")) {
    return "printf 'worker-2\\n' > worker.txt && git add worker.txt && git commit -m 'test: 添加第二个确定性 worker 标记'";
  }
  return undefined;
}

function typedExecutorAttentionContract(userText, executorRunId) {
  const taskIdSource = userText.match(/^- Task ID: (.+)$/m)?.[1];
  let taskId;
  try { taskId = JSON.parse(taskIdSource); } catch {}
  const section = userText.match(/^## Declared Write Scope\n([\s\S]*?)(?:\n\n|$)/m)?.[1];
  const writePaths = section?.split("\n").flatMap((line) => {
    const source = line.match(/^\d+\. (.+)$/)?.[1];
    try {
      const path = JSON.parse(source);
      return typeof path === "string" ? [path] : [];
    } catch {
      return [];
    }
  }) ?? [];
  if (typeof taskId !== "string" || !taskId || typeof executorRunId !== "string" || !executorRunId
    || writePaths.length !== 1 || !deterministicExecutorCommand(userText)) return undefined;
  return { taskId, writePath: writePaths[0] };
}

function rootAttentionReplies(messages) {
  const marker = "PI_PLAN_FLAT_ATTENTION_REPLIES";
  const markerIndex = messages.findLastIndex((message) => message?.role === "user" && textParts(message).startsWith(`${marker}\n`));
  if (markerIndex < 0) return undefined;
  let replies;
  try { replies = JSON.parse(textParts(messages[markerIndex]).slice(marker.length).trim()).replies; } catch {}
  const exactReply = (reply) => reply && typeof reply === "object" && !Array.isArray(reply)
    && Object.keys(reply).length === 4
    && ["planId", "requestId", "expectedProjectionVersion", "message"].every((key) => Object.hasOwn(reply, key))
    && typeof reply.planId === "string" && reply.planId
    && typeof reply.requestId === "string" && reply.requestId
    && Number.isSafeInteger(reply.expectedProjectionVersion)
    && typeof reply.message === "string" && reply.message;
  if (!Array.isArray(replies) || replies.length === 0 || !replies.every(exactReply)) return { text: "PLAN_ROOT_ATTENTION_REPLIES_INVALID" };
  return { replies, results: messages.slice(markerIndex + 1).filter((message) => message?.role === "toolResult" && message.toolName === "plan_attention_reply") };
}

export function decideDeterministicTurn({ messages = [], toolNames = [], issuedDispatchContractKeys = new Set(), attentionMode = false, executorRunId } = {}) {
  const userText = messages.filter((message) => message?.role === "user").map(textParts).join("\n");
  const latestPrivateWakeIndex = messages.findLastIndex((message) => message?.role === "user"
    && textParts(message).split("\n").includes("A durable Root broker wake is pending."));
  const latestPrivateWake = latestPrivateWakeIndex >= 0;
  const toolInventory = toolNames.join(",");

  const toolResults = messages.filter((message) => message?.role === "toolResult");
  const attentionReplies = rootAttentionReplies(messages);
  if (attentionReplies) {
    if (attentionReplies.text) return attentionReplies;
    if (attentionReplies.results.some((message) => message.isError)) return { text: "PLAN_ROOT_ATTENTION_REPLY_FAILED" };
    if (attentionReplies.results.length >= attentionReplies.replies.length) return { text: "PLAN_ROOT_ATTENTION_REPLIES_DONE" };
    if (toolNames.includes("plan_attention_reply")) {
      return { tool: { name: "plan_attention_reply", arguments: attentionReplies.replies[attentionReplies.results.length] } };
    }
  }

  if (attentionMode && deterministicExecutorCommand(userText)) {
    const contract = typedExecutorAttentionContract(userText, executorRunId);
    if (!contract) return { text: "PLAN_EXECUTOR_ATTENTION_INVALID" };
    const supervisorResult = toolResults.find((message) => message.toolName === "contact_supervisor");
    if (!supervisorResult) {
      if (toolNames.includes("contact_supervisor")) {
        return {
          tool: {
            name: "contact_supervisor",
            arguments: {
              reason: "need_decision",
              message: `PI_PLAN_FLAT_ATTENTION ${JSON.stringify({ schemaVersion: "pi-plan-flat-attention-marker.v1", executorRunId, ...contract })}`,
            },
          },
        };
      }
      return { text: "PLAN_EXECUTOR_ATTENTION_SUPERVISOR_UNAVAILABLE" };
    }
    if (supervisorResult.isError) return { text: "PLAN_EXECUTOR_ATTENTION_REPLY_FAILED" };
    if (!toolResults.some((message) => message.toolName === "bash") && toolNames.includes("bash")) {
      return { tool: { name: "bash", arguments: { command: deterministicExecutorCommand(userText) } } };
    }
    return { text: "PLAN_EXECUTOR_DECISION_DONE" };
  }

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
    const latestPushIndex = messages.findLastIndex((message) => (message?.role === "custom"
      && ["pi-root-subagent-lifecycle-v1", "subagent_supervisor_request"].includes(message.customType))
      || (message?.role === "user" && textParts(message) === lifecycleUpdateMarker));
    const latestStatusIndex = messages.findLastIndex((message) => message?.role === "toolResult" && message.toolName === "plan_status");
    if (latestPrivateWakeIndex > latestStatusIndex && latestStatusIndex >= 0 && toolNames.includes("plan_status")) {
      return { tool: { name: "plan_status", arguments: {} } };
    }
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
      const waveMessages = messages.slice(latestContinueIndex + 1);
      const assistantDispatchKeys = waveMessages.filter((message) => message?.role === "assistant").flatMap((message) => message.content ?? [])
        .filter((part) => part?.type === "toolCall" && part.name === "subagent")
        .map((part) => deterministicContractKey(part.arguments));
      const authoritativeBoundKeys = new Set();
      if (latestStatusIndex > latestContinueIndex) {
        try {
          const status = JSON.parse(textParts(messages[latestStatusIndex]));
          if (status.schemaVersion === "pi-plan-status.v1" && Array.isArray(status.tasks)) {
            for (const dispatch of dispatches) {
              const matches = status.tasks.flatMap((task) => Array.isArray(task?.attempts)
                ? task.attempts.filter((attempt) => task.taskId === dispatch.contract?.taskId
                  && attempt?.attemptId === dispatch.attemptId
                  && attempt?.dispatchId === dispatch.dispatchId)
                : []);
              if (matches.length === 1 && typeof matches[0].runId === "string" && matches[0].runId.trim()) {
                authoritativeBoundKeys.add(deterministicContractKey(dispatch.contract));
              }
            }
          }
        } catch {}
      }
      let standaloneResultCount = Math.max(0, waveMessages.filter((message) => message?.role === "toolResult" && message.toolName === "subagent").length - assistantDispatchKeys.length);
      const attempted = new Set([...issuedDispatchContractKeys, ...assistantDispatchKeys, ...authoritativeBoundKeys]);
      for (const dispatch of dispatches) {
        if (standaloneResultCount === 0) break;
        const key = deterministicContractKey(dispatch.contract);
        if (!attempted.has(key)) {
          attempted.add(key);
          standaloneResultCount--;
        }
      }
      const nextDispatch = dispatches.find((dispatch) => !attempted.has(deterministicContractKey(dispatch.contract)));
      if (nextDispatch && toolNames.includes("subagent")) {
        return { tool: { name: "subagent", arguments: nextDispatch.contract } };
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
