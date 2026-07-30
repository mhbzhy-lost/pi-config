import { applyEvent, createProjection } from "./plan-events.mjs";

const STRING = { type: "string", minLength: 1 };
const EMPTY_OBJECT = { type: "object", properties: {}, additionalProperties: false };
const OPEN_KEYS = ["allowPlanCommits", "baseCommit", "manifestSha256", "planId", "planIrHash", "revision", "worktree"];
const PLAN_ACTIVE_TOOLS = [
  "plan_open", "plan_status", "plan_continue", "plan_verify", "plan_block", "plan_read_revision", "plan_amend",
  "subagent_wait", "subagent_supervisor", "read", "grep",
];

function result(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError,
  };
}

function eventsFrom(ctx) {
  const branch = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) throw new Error("Current session branch is unavailable.");
  return branch
    .filter((entry) => entry?.customType === "pi-plan-event-v1")
    .map((entry) => entry.data)
    .filter(Boolean);
}

function projectionFrom(ctx) {
  let projection = createProjection();
  for (const event of eventsFrom(ctx)) projection = applyEvent(projection, event);
  return projection;
}

function register(pi, tool) {
  pi.registerTool(tool);
}

function assertExactOpenInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(OPEN_KEYS)) throw new Error("Invalid plan_open input.");
  if (typeof input.planId !== "string" || typeof input.baseCommit !== "string" || typeof input.worktree !== "string"
    || !Number.isSafeInteger(input.revision) || input.revision < 1 || !/^[0-9a-f]{64}$/.test(input.manifestSha256)
    || !/^[0-9a-f]{64}$/.test(input.planIrHash) || input.allowPlanCommits !== true) throw new Error("Invalid plan_open input.");
}

export function createPlanCapsuleExtension(pi, options = {}) {
  let opened = false;
  let lifecycleRegistered = false;
  let runtimeCapabilitiesReady = false;
  let stopPlanControl;
  const authorizedSupervisorReplies = new Map();
  const resolvedSupervisorCalls = new Set();

  async function assertRuntimeCapabilities() {
    if (runtimeCapabilitiesReady) return;
    await options.assertRuntimeCapabilities?.();
    runtimeCapabilitiesReady = true;
  }

  function activateTools() {
    if (lifecycleRegistered) return;
    lifecycleRegistered = true;
    register(pi, {
      name: "plan_status",
      label: "Plan status",
      description: "Read the derived plan status.",
      parameters: EMPTY_OBJECT,
      async execute(_id, _params, _signal, _update, ctx) {
        if (typeof options.status !== "function") return result("Plan status capability is unavailable.", true);
        try {
          return result(await options.status({ projection: projectionFrom(ctx), ctx }));
        } catch (error) {
          return result(error instanceof Error ? error.message : "Plan status failed.", true);
        }
      },
    });
    register(pi, {
      name: "plan_continue",
      label: "Continue plan",
      description: "Request one safe coordinator step.",
      parameters: { type: "object", properties: { reason: STRING }, required: ["reason"], additionalProperties: false },
      async execute(_id, params, _signal, _update, ctx) {
        if (typeof options.continuePlan !== "function") return result("Plan continue capability is unavailable.", true);
        try {
          return result(await options.continuePlan(params, { projection: projectionFrom(ctx), ctx }));
        } catch (error) {
          return result(error instanceof Error ? error.message : "Plan continue failed.", true);
        }
      },
    });
    register(pi, {
      name: "plan_verify",
      label: "Verify plan",
      description: "Run the plan verification domain operation.",
      parameters: EMPTY_OBJECT,
      async execute(_id, _params, _signal, _update, ctx) {
        if (typeof options.verifyPlan !== "function") return result("Plan verify capability is unavailable.", true);
        try {
          return result(await options.verifyPlan({ projection: projectionFrom(ctx), ctx }));
        } catch (error) {
          return result(error instanceof Error ? error.message : "Plan verification failed.", true);
        }
      },
    });
    register(pi, {
      name: "plan_block",
      label: "Block plan",
      description: "Declare a plan blocker through the domain boundary.",
      parameters: { type: "object", properties: { reason: STRING }, required: ["reason"], additionalProperties: false },
      async execute(_id, params, _signal, _update, ctx) {
        if (typeof options.blockPlan !== "function") return result("Plan block capability is unavailable.", true);
        try {
          return result(await options.blockPlan(params, { projection: projectionFrom(ctx), ctx }));
        } catch (error) {
          return result(error instanceof Error ? error.message : "Plan block failed.", true);
        }
      },
    });
    register(pi, {
      name: "plan_read_revision", label: "Read current plan revision", description: "Read the current committed Plan source.", parameters: EMPTY_OBJECT,
      async execute(_id, _params, _signal, _update, ctx) {
        if (typeof options.readCurrentRevision !== "function") return result("Plan revision read capability is unavailable.", true);
        try { return result(await options.readCurrentRevision({ ctx })); } catch (error) { return result(error instanceof Error ? error.message : "Plan revision read failed.", true); }
      },
    });
    register(pi, {
      name: "plan_amend", label: "Amend plan", description: "Commit an authorized complete Plan revision.",
      parameters: { type: "object", properties: { expectedProjectionVersion: { type: "integer", minimum: 1 }, baseRevision: { type: "integer", minimum: 1 }, requestId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }, reason: { type: "string", minLength: 1, maxLength: 4096 }, source: { type: "string", minLength: 1, maxLength: 1048576 } }, required: ["expectedProjectionVersion", "baseRevision", "requestId", "reason", "source"], additionalProperties: false },
      async execute(_id, params, _signal, _update, ctx) {
        if (typeof options.amendPlan !== "function") return result("Plan amendment capability is unavailable.", true);
        try { return result(await options.amendPlan(params, { ctx })); } catch (error) { return result(error instanceof Error ? error.message : "Plan amendment failed.", true); }
      },
    });
    pi.setActiveTools([...PLAN_ACTIVE_TOOLS]);
  }

  async function restore(ctx) {
    const events = eventsFrom(ctx);
    const planIds = new Set(events.map((event) => event.planId).filter(Boolean));
    if (planIds.size > 1) throw new Error("multiple planId entries on current branch");
    const projection = projectionFrom(ctx);
    if (projection.planId) {
      opened = true;
      activateTools();
    }
    return projection;
  }

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("before_agent_start", async (_event, ctx) => {
    await assertRuntimeCapabilities();
    if (opened && typeof options.recoverSupersededAttempts === "function") await options.recoverSupersededAttempts({ ctx });
  });
  pi.on("session_shutdown", async () => {
    const control = stopPlanControl;
    stopPlanControl = undefined;
    await Promise.allSettled([
      Promise.resolve().then(() => control?.()),
      Promise.resolve().then(() => options.stopActiveRuns?.()),
    ]);
    await Promise.resolve().then(() => options.disposeExecutionBackend?.()).catch(() => {});
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!opened) return undefined;
    if (["subagent", "contact_supervisor", "bash"].includes(event?.toolName)) {
      return { block: true, reason: "Plan dispatch authorization boundary owns dispatch and supervision." };
    }
    if (event?.toolName !== "subagent_supervisor") return undefined;
    if (!["pending", "reply"].includes(event?.input?.action)) {
      return { block: true, reason: "Plan Runner Supervisor access is limited to pending and fenced reply operations." };
    }
    if (event.input.action === "pending") return undefined;
    if (typeof options.authorizeSupervisorReply !== "function") {
      return { block: true, reason: "Supervisor reply authorization is unavailable." };
    }
    const key = event.toolCallId ?? `${event.input.replyTo}:${event.input.to}`;
    if (authorizedSupervisorReplies.has(key) || resolvedSupervisorCalls.has(key)) {
      return { block: true, reason: "Supervisor reply tool call is duplicated." };
    }
    try {
      const authorization = await options.authorizeSupervisorReply(event.input, { projection: projectionFrom(ctx), ctx });
      authorizedSupervisorReplies.set(key, { ...authorization, message: event.input.message, to: event.input.to });
      return undefined;
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : "Supervisor reply is not authorized." };
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event?.toolName !== "subagent_supervisor" || event?.input?.action !== "reply") return;
    const key = event.toolCallId ?? `${event.input.replyTo}:${event.input.to}`;
    const authorization = authorizedSupervisorReplies.get(key);
    if (!authorization || resolvedSupervisorCalls.has(key)) return;
    if (event.isError) {
      authorizedSupervisorReplies.delete(key);
      return;
    }
    if (typeof options.resolveSupervisorReply !== "function") return;
    await options.resolveSupervisorReply(authorization, { projection: projectionFrom(ctx), ctx });
    authorizedSupervisorReplies.delete(key);
    resolvedSupervisorCalls.add(key);
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event?.message ?? event;
    if (message?.customType !== "subagent_supervisor_request") return;
    if (typeof options.recordSupervisorRequest !== "function") throw new Error("Supervisor Attention persistence is unavailable.");
    await options.recordSupervisorRequest(message, { projection: projectionFrom(ctx), ctx });
  });
  pi.on("session_tree", async (_event, ctx) => {
    const projection = await restore(ctx);
    if (!projection.planId) {
      await options.stopCoordinator?.();
      await options.markRecoveryNeeded?.();
    }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const projection = await restore(ctx);
    if (!projection.planId) return;
    if (projection.lifecycle === "validated") {
      pi.sendMessage({ customType: "pi-plan-summary-v1", content: `Plan ${projection.planId} validated.`, details: { planId: projection.planId, lifecycle: projection.lifecycle } });
      return;
    }
    if (["blocked", "cancelled"].includes(projection.lifecycle)) {
      pi.sendMessage({ customType: "pi-plan-summary-v1", content: `Plan ${projection.planId} ${projection.lifecycle}.`, details: { planId: projection.planId, lifecycle: projection.lifecycle } });
      return;
    }
    const hasActiveAttempt = [...projection.attempts.values()].some((attempt) => attempt.status === "active");
    const hasWaitingAttention = [...projection.attempts.values()].some((attempt) => attempt.status === "waiting-attention");
    if (hasActiveAttempt) {
      pi.sendMessage(
        {
          customType: "pi-plan-follow-up-v1",
          content: "Run the executor control loop: check Supervisor pending; when empty call subagent_wait with timeoutMs 1000ms; then check Supervisor pending again.",
          details: { planId: projection.planId, enforcement: "executor-control-loop" },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return;
    }
    if (hasWaitingAttention) return;
    if (options.canContinue?.(projection) === true) {
      pi.sendMessage(
        { customType: "pi-plan-follow-up-v1", content: "Continue the plan coordinator.", details: { planId: projection.planId } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return;
    }
    // Gate enforcement: if HEAD has advanced but lifecycle is still running,
    // the plan has work that was never verified. Force plan_verify.
    if (typeof options.getHeadCommit === "function" && projection.workspace?.headCommit) {
      let currentHead;
      let headCheckFailed = false;
      try {
        currentHead = await options.getHeadCommit();
      } catch {
        headCheckFailed = true;
      }
      if (headCheckFailed || (currentHead && currentHead !== projection.workspace.headCommit)) {
        const reason = headCheckFailed
          ? "Cannot determine worktree HEAD (git failed). Assuming work exists."
          : `Worktree HEAD advanced to ${currentHead} but plan lifecycle is still running.`;
        pi.sendMessage(
          { customType: "pi-plan-follow-up-v1", content: `${reason} You MUST call plan_verify now. If verification fails, call plan_block with the reason. You cannot exit without reaching a terminal lifecycle state (validated or blocked).`, details: { planId: projection.planId, enforcement: "gate-required" } },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        return;
      }
    }
    await options.appendPlanEvent?.(ctx, "plan.interrupted", { reason: "unsafe_to_continue" }, projection.version);
  });

  register(pi, {
    name: "plan_open",
    label: "Open plan",
    description: "Bind an approved plan to this Plan Session.",
    parameters: {
      type: "object",
      properties: { planId: STRING, revision: { type: "integer", minimum: 1 }, manifestSha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, planIrHash: { type: "string", pattern: "^[0-9a-f]{64}$" }, baseCommit: STRING, worktree: STRING, allowPlanCommits: { type: "boolean", const: true } },
      required: ["planId", "revision", "manifestSha256", "planIrHash", "baseCommit", "worktree", "allowPlanCommits"],
      additionalProperties: false,
    },
    async execute(_id, input, _signal, _update, ctx) {
      if (opened) return result("Plan is already open.", true);
      if (typeof options.validateBinding !== "function") return result("Plan binding validation is unavailable.", true);
      try {
        assertExactOpenInput(input);
        await assertRuntimeCapabilities();
        if (typeof options.appendPlanEvent !== "function" || typeof options.writeCurrentRevision !== "function") throw new Error("Plan revision persistence is unavailable.");
        const binding = await options.validateBinding(input, { ctx });
        if (!binding || binding.planId !== input.planId || !Array.isArray(binding.tasks) || binding.tasks.length === 0) {
          throw new Error("Invalid verified plan binding.");
        }
        const tasks = binding.tasks.map((task) => typeof task === "object" && task !== null ? task.id : task);
        if (tasks.some((taskId) => typeof taskId !== "string" || taskId.trim() === "")) throw new Error("Invalid verified plan binding.");
        if (typeof options.appendPlanEvent !== "function") throw new Error("Plan event writer is unavailable.");
        await options.appendPlanEvent(ctx, "plan.created", {
          workspace: {
            originRoot: binding.originRoot,
            worktree: binding.worktree,
            baseCommit: binding.baseCommit,
            headCommit: binding.headCommit,
          },
          tasks,
          revision: binding.revisionIdentity ?? binding.revision,
        }, 0, input.planId);
        await options.writeCurrentRevision(binding.revision);
        if (typeof options.startPlanControl === "function") {
          const stop = await options.startPlanControl({ binding, ctx });
          if (typeof stop !== "function") throw new Error("Plan control startup failed.");
          stopPlanControl = stop;
        }
        opened = true;
        activateTools();
        return result(`Plan ${binding.planId} opened.`);
      } catch (error) {
        return result(error instanceof Error ? error.message : "Plan binding validation failed.", true);
      }
    },
  });
}

createPlanCapsuleExtension.acceptanceVerify = function acceptanceVerify(status) {
  return status?.lifecycle === "validated" && status.validatedHead === status.headCommit ? 0 : 1;
};
