import { applyEvent, createProjection } from "./plan-events.mjs";

const STRING = { type: "string", minLength: 1 };
const EMPTY_OBJECT = { type: "object", properties: {}, additionalProperties: false };

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

export function createPlanCapsuleExtension(pi, options = {}) {
  let opened = false;
  let lifecycleRegistered = false;
  let stopPlanControl;
  const authorizedNestedCalls = new Set();

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
    const active = pi.getActiveTools();
    pi.setActiveTools([...new Set([...active, "plan_open", "plan_status", "plan_continue", "plan_verify", "plan_block"])]);
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
  pi.on("session_shutdown", async () => {
    const control = stopPlanControl;
    stopPlanControl = undefined;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => control?.()),
      Promise.resolve().then(() => options.stopActiveRuns?.()),
    ]);
    const errors = results.filter((entry) => entry.status === "rejected").map((entry) => entry.reason);
    if (errors.length) throw new AggregateError(errors, "Plan session shutdown failed");
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event?.toolName !== "subagent") return undefined;
    if (typeof event?.input?.action === "string") return undefined;
    if (!opened || typeof options.authorizeNestedSubagent !== "function") {
      return { block: true, reason: "No nested subagent dispatch is authorized." };
    }
    try {
      const authorized = options.authorizeNestedSubagent(event.input, { ctx });
      if (authorized !== true) return { block: true, reason: "Nested subagent dispatch was not authorized." };
      authorizedNestedCalls.add(JSON.stringify(event.input));
      return undefined;
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : "Nested subagent dispatch was not authorized." };
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event?.toolName !== "subagent" || event?.isError === true) return undefined;
    if (!event?.details || typeof event.details.runId !== "string" || event.details.runId === "") return undefined;
    const key = JSON.stringify(event.input);
    if (!authorizedNestedCalls.delete(key) || typeof options.handleNestedResult !== "function") return undefined;
    const outcome = await options.handleNestedResult(event, { ctx });
    if (outcome?.state !== "ignored") {
      const current = projectionFrom(ctx);
      if (current.planId) {
        pi.sendMessage(
          { customType: "pi-plan-follow-up-v1", content: "Continue the plan coordinator.", details: { planId: current.planId } },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    }
    return undefined;
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
    if (options.canContinue?.(projection) === true) {
      pi.sendMessage(
        { customType: "pi-plan-follow-up-v1", content: "Continue the plan coordinator.", details: { planId: projection.planId } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return;
    }
    pi.appendEntry("pi-plan-event-v1", {
      schemaVersion: "pi-plan-event.v1",
      eventId: options.id?.() ?? crypto.randomUUID(),
      planId: projection.planId,
      occurredAt: options.now?.() ?? new Date().toISOString(),
      type: "plan.interrupted",
      data: { reason: "unsafe_to_continue" },
    });
  });

  register(pi, {
    name: "plan_open",
    label: "Open plan",
    description: "Bind an approved plan to this Plan Session.",
    parameters: {
      type: "object",
      properties: { planId: STRING, planPath: STRING, planHash: STRING, baseCommit: STRING, worktree: STRING, allowPlanCommits: { type: "boolean", const: true } },
      required: ["planId", "planPath", "planHash", "baseCommit", "worktree", "allowPlanCommits"],
      additionalProperties: false,
    },
    async execute(_id, input, _signal, _update, ctx) {
      if (opened) return result("Plan is already open.", true);
      if (typeof options.validateBinding !== "function") return result("Plan binding validation is unavailable.", true);
      try {
        const binding = await options.validateBinding(input, { ctx });
        if (!binding || binding.planId !== input.planId || !Array.isArray(binding.tasks) || binding.tasks.length === 0) {
          throw new Error("Invalid verified plan binding.");
        }
        const tasks = binding.tasks.map((task) => typeof task === "object" && task !== null ? task.id : task);
        if (tasks.some((taskId) => typeof taskId !== "string" || taskId.trim() === "")) throw new Error("Invalid verified plan binding.");
        pi.appendEntry("pi-plan-event-v1", {
          schemaVersion: "pi-plan-event.v1",
          eventId: options.id?.() ?? crypto.randomUUID(),
          planId: binding.planId,
          occurredAt: options.now?.() ?? new Date().toISOString(),
          type: "plan.created",
          data: {
            workspace: {
              originRoot: binding.originRoot,
              worktree: binding.worktree,
              baseCommit: binding.baseCommit,
              headCommit: binding.headCommit,
              planPath: binding.planPath,
              planHash: binding.planHash,
            },
            tasks,
          },
        });
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
