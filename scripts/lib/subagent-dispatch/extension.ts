import { randomUUID } from "node:crypto";

import { compileCodingDispatchIR, CodingDispatchContractError } from "./ir.ts";
import { renderCodingDispatchPrompt } from "./prompt.ts";
import { createTypedSubagentRpcClient } from "./rpc-client.ts";
import { createHeadlessSubagentApi } from "./runtime-membrane.ts";
import { getTitleRegistry, normalizeSubagentTitle } from "./title-registry.ts";
import { createSupervisorAdapter, createSupervisorTool } from "./supervisor-adapter.ts";

const CLEANUP_KEY = "__typedSubagentRuntimeCleanup";
const CODING_AGENTS = new Set(["executor", "spark"]);
const CONTROL_ACTIONS = new Set(["status", "steer", "interrupt", "stop"]);

const stringList = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 4096 },
  maxItems: 32,
};
const pathList = { ...stringList, minItems: 0 };

const CODING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "taskId",
    "title",
    "agent",
    "risk",
    "objective",
    "workflow",
    "requirements",
    "context",
    "boundaries",
    "acceptance",
    "execution",
  ],
  properties: {
    version: { const: "dispatch-ir.v1" },
    taskId: { type: "string", pattern: "^[A-Za-z0-9._-]{1,160}$" },
    title: { type: "string", minLength: 1, maxLength: 4096 },
    agent: { enum: ["executor", "spark"] },
    risk: { enum: ["low", "normal", "high"] },
    objective: { type: "string", minLength: 1, maxLength: 4096 },
    requirements: { ...stringList, minItems: 1 },
    workflow: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { enum: ["tdd", "existing-tests", "docs-only"] },
        reason: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    context: {
      type: "object",
      additionalProperties: false,
      required: ["knownFacts", "decisions", "relevantFiles"],
      properties: {
        knownFacts: stringList,
        decisions: stringList,
        relevantFiles: pathList,
      },
    },
    boundaries: {
      type: "object",
      additionalProperties: false,
      required: ["writePaths", "excludedWork", "forbiddenActions"],
      properties: {
        writePaths: { ...pathList, minItems: 1 },
        excludedWork: stringList,
        forbiddenActions: stringList,
      },
    },
    acceptance: {
      type: "object",
      additionalProperties: false,
      required: ["criteria", "commands"],
      properties: {
        criteria: { ...stringList, minItems: 1 },
        commands: { ...stringList, minItems: 1 },
      },
    },
    execution: {
      type: "object",
      additionalProperties: false,
      required: ["timeoutMs"],
      properties: {
        cwd: { type: "string", minLength: 1, maxLength: 4096 },
        timeoutMs: { type: "integer", minimum: 1 },
      },
    },
  },
};

const GENERIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["agent", "title", "task"],
  properties: {
    agent: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      not: { enum: ["executor", "spark"] },
    },
    title: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\r\\n\\u0000-\\u001F\\u007F-\\u009F]+$" },
    task: { type: "string", minLength: 1, maxLength: 65536 },
    context: { enum: ["fresh", "fork"] },
    cwd: { type: "string", minLength: 1, maxLength: 4096 },
    model: { type: "string", minLength: 1, maxLength: 512 },
    timeoutMs: { type: "integer", minimum: 1 },
    output: { anyOf: [{ type: "string", minLength: 1 }, { const: false }] },
    outputMode: { enum: ["inline", "file-only"] },
    outputSchema: { type: "object", additionalProperties: true },
    acceptance: {},
    artifacts: { type: "boolean" },
    progress: { type: "boolean" },
    skill: {
      anyOf: [
        { type: "string", minLength: 1 },
        { type: "array", items: { type: "string", minLength: 1 } },
        { type: "boolean" },
      ],
    },
    reads: {
      anyOf: [
        { type: "array", items: { type: "string", minLength: 1 } },
        { type: "boolean" },
      ],
    },
  },
};

const CONTROL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { enum: ["status", "steer", "interrupt", "stop"] },
    id: { type: "string", minLength: 1, maxLength: 4096 },
    runId: { type: "string", minLength: 1, maxLength: 4096 },
    dir: { type: "string", minLength: 1, maxLength: 4096 },
    index: { type: "integer", minimum: 0 },
    message: { type: "string", minLength: 1, maxLength: 65536 },
  },
};

export const TYPED_SUBAGENT_PARAMETERS = Object.freeze({
  type: "object",
  anyOf: [CODING_SCHEMA, GENERIC_SCHEMA, CONTROL_SCHEMA],
});

export const TYPED_SUBAGENT_DESCRIPTION = `Delegate through the project-owned isolated subagent runtime.

For executor or spark, provide the complete dispatch-ir.v1 contract; free-form task dispatch is rejected. For any other agent, provide { agent, title, task } and optional execution fields; title is a concise single-line display label and task is forwarded unchanged. All spawns are detached through RPC. Completion notifications are delivered automatically. After a successful spawn, do not use sleep, status polling, or supervisor pending to wait for completion. Continue only work independent of the children; if none remains, end the turn. Use status only for explicit user requests, intervention, or diagnostics. Supported control actions are status, steer, interrupt, and stop.`;

const ASYNC_SPAWN_GUIDANCE = "Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0;
}

function failure(code, message, detail) {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    isError: true,
    details: {
      code,
      ...(detail !== undefined ? { detail } : {}),
    },
  };
}

function rpcResult(reply) {
  return {
    content: [{ type: "text", text: nonempty(reply?.text) ? reply.text : "Subagent RPC request completed." }],
    isError: reply?.isError === true,
    ...(reply?.details !== undefined ? { details: reply.details } : {}),
  };
}

function assertSpawnCapabilities(result, cwd) {
  const methods = new Set(Array.isArray(result?.methods) ? result.methods : []);
  const session = result?.session;
  if (
    result?.version !== 1
    || !methods.has("spawn")
    || !nonempty(session?.sessionId)
    || !nonempty(session?.sessionFile)
    || !nonempty(session?.cwd)
    || session.cwd !== cwd
  ) {
    const error = new Error("pi-subagents RPC v1 spawn capability or session identity mismatch");
    error.code = "CAPABILITY_MISMATCH";
    throw error;
  }
}

function spawnBinding(reply) {
  const details = reply?.details ?? reply;
  const runId = details?.runId ?? details?.asyncId;
  const asyncDir = details?.asyncDir;
  if (!nonempty(runId) || !nonempty(asyncDir)) {
    const error = new Error("pi-subagents spawn reply is missing runId or asyncDir");
    error.code = "SPAWN_REPLY_INVALID";
    throw error;
  }
  return { runId, asyncDir };
}

function codingSpawnParams(ir, prompt) {
  return {
    agent: ir.agent,
    title: ir.title,
    task: prompt,
    cwd: ir.execution.cwd,
    context: "fresh",
    async: true,
    clarify: false,
    artifacts: true,
    output: false,
    timeoutMs: ir.execution.timeoutMs,
    acceptance: {
      level: "verified",
      criteria: ir.acceptance.criteria,
      evidence: [
        "changed-files",
        "tests-added",
        "commands-run",
        "validation-output",
        "residual-risks",
        "no-staged-files",
      ],
      verify: ir.acceptance.commands.map((command, index) => ({
        id: `verify-${index + 1}`,
        command,
        cwd: ir.execution.cwd,
      })),
    },
  };
}

async function executeCoding(input, ctx, rpc, createId, titleRegistry) {
  const ir = compileCodingDispatchIR(input, { cwd: ctx.cwd });
  const prompt = renderCodingDispatchPrompt(ir);
  titleRegistry.prepare({ agent: ir.agent, task: prompt, title: ir.title });
  assertSpawnCapabilities(await rpc.ping(), ctx.cwd);
  const binding = spawnBinding(await rpc.spawn(codingSpawnParams(ir, prompt)));
  titleRegistry.remember(binding.runId, ir.title);
  const handle = {
    version: "coding-dispatch-handle.v1",
    dispatchId: createId(),
    taskId: ir.taskId,
    agent: ir.agent,
    title: ir.title,
    contractHash: ir.hash,
    ...binding,
  };
  return {
    content: [{ type: "text", text: `Started ${handle.agent}: ${handle.title} (${handle.runId}). ${ASYNC_SPAWN_GUIDANCE}` }],
    isError: false,
    details: handle,
  };
}

async function executeGeneric(input, ctx, rpc, titleRegistry) {
  if (CODING_AGENTS.has(input.agent)) {
    return failure(
      "CODING_CONTRACT_REQUIRED",
      `${input.agent} requires a complete dispatch-ir.v1 contract instead of task`,
    );
  }
  if (!nonempty(input.agent) || !nonempty(input.task) || !nonempty(input.title)) {
    return failure("INVALID_GENERIC_DISPATCH", "generic dispatch requires non-empty agent, title, and task");
  }
  const title = normalizeSubagentTitle(input.title);
  assertSpawnCapabilities(await rpc.ping(), ctx.cwd);
  titleRegistry.prepare({ agent: input.agent, task: input.task, title });
  const reply = await rpc.spawn({ ...input, title });
  const binding = spawnBinding(reply);
  titleRegistry.remember(binding.runId, title);
  return {
    content: [{ type: "text", text: `Started ${input.agent}: ${title} (${binding.runId}). ${ASYNC_SPAWN_GUIDANCE}` }],
    isError: false,
    details: { ...(reply?.details ?? reply ?? {}), ...binding, agent: input.agent, title },
  };
}

async function executeControl(input, rpc) {
  if (!CONTROL_ACTIONS.has(input.action)) {
    return failure("UNSUPPORTED_ACTION", `unsupported subagent RPC action: ${String(input.action)}`);
  }
  const { action, ...params } = input;
  return rpcResult(await rpc[action](params));
}

function cleanupRegistry(cleanupStore) {
  const current = cleanupStore[CLEANUP_KEY];
  if (current instanceof WeakMap) return current;
  if (current && typeof current.dispose === "function") current.dispose();
  const registry = new WeakMap();
  cleanupStore[CLEANUP_KEY] = registry;
  return registry;
}

function deactivateSupervisorTool(pi) {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const activeTools = pi.getActiveTools();
  if (!Array.isArray(activeTools) || !activeTools.includes("subagent_supervisor")) return;
  pi.setActiveTools(activeTools.filter((name) => name !== "subagent_supervisor"));
}

export function createTypedSubagentExtension(
  pi,
  {
    rpc = createTypedSubagentRpcClient(pi.events),
    supervisorAdapter,
    cleanupStore = globalThis,
    randomUUID: createId = randomUUID,
    titleRegistry = getTitleRegistry(cleanupStore),
    extraDisposables = [],
    renderSubagentResult,
  } = {},
) {
  const registry = cleanupRegistry(cleanupStore);
  const previous = registry.get(pi);
  if (previous && typeof previous.dispose === "function") previous.dispose();

  const token = Symbol("typed-subagent-runtime");
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    supervisorAdapter?.dispose();
    for (const disposable of extraDisposables) disposable?.dispose?.();
    rpc.dispose?.();
  };
  registry.set(pi, { token, dispose });

  const tool = {
    name: "subagent",
    label: "Subagent",
    description: TYPED_SUBAGENT_DESCRIPTION,
    parameters: TYPED_SUBAGENT_PARAMETERS,
    ...(typeof renderSubagentResult === "function" ? { renderResult: renderSubagentResult } : {}),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      try {
        if (!isRecord(input)) return failure("INVALID_DISPATCH", "subagent input must be an object");
        if (Object.hasOwn(input, "action")) return await executeControl(input, rpc);
        if (Object.hasOwn(input, "version")) return await executeCoding(input, ctx, rpc, createId, titleRegistry);
        return await executeGeneric(input, ctx, rpc, titleRegistry);
      } catch (error) {
        const code = error?.code
          ?? (error instanceof CodingDispatchContractError ? error.code : "SUBAGENT_RPC_FAILED");
        return failure(code, error instanceof Error ? error.message : String(error), error?.detail);
      }
    },
  };
  pi.registerTool(tool);

  const supervisorTool = supervisorAdapter ? createSupervisorTool(supervisorAdapter) : undefined;
  if (supervisorTool) {
    pi.registerTool(supervisorTool);
    pi.on("session_start", async () => {
      if (supervisorAdapter.isBound()) return;
      deactivateSupervisorTool(pi);
      const error = new Error("SUPERVISOR_TARGET_UNAVAILABLE");
      error.code = "SUPERVISOR_TARGET_UNAVAILABLE";
      throw error;
    });
  }

  pi.on("session_shutdown", async () => {
    if (registry.get(pi)?.token !== token) return;
    dispose();
    registry.delete(pi);
  });

  return Object.freeze({ tool, supervisorTool, dispose });
}

export function installHeadlessTypedSubagentRuntime(pi, {
  bootstrap,
  completionNotifierFactory,
  resolveSessionId,
  ...options
} = {}) {
  if (typeof bootstrap !== "function") {
    throw new TypeError("typed subagent runtime requires an upstream bootstrap function");
  }
  const supervisorAdapter = createSupervisorAdapter();
  const titleRegistry = options.titleRegistry ?? getTitleRegistry(options.cleanupStore ?? globalThis);
  titleRegistry.resetCompleted?.();
  bootstrap(createHeadlessSubagentApi(pi, {
    supervisorAdapter,
    titleRegistry,
    suppressCompletionNotifications: typeof completionNotifierFactory === "function",
  }));

  let completionNotifier;
  if (typeof completionNotifierFactory === "function") {
    if (typeof resolveSessionId !== "function") {
      throw new TypeError("title-aware completion notification requires a session identity resolver");
    }
    const notificationState = { currentSessionId: null };
    completionNotifier = completionNotifierFactory(
      createHeadlessSubagentApi(pi, { titleRegistry }),
      notificationState,
    );
    if (!completionNotifier || typeof completionNotifier.dispose !== "function") {
      throw new TypeError("completion notifier factory must return a disposable notifier");
    }
    pi.on("session_start", (_event, ctx) => {
      notificationState.currentSessionId = resolveSessionId(ctx.sessionManager);
    });
    pi.on("session_shutdown", () => {
      notificationState.currentSessionId = null;
    });
  }

  return createTypedSubagentExtension(pi, {
    ...options,
    supervisorAdapter,
    titleRegistry,
    extraDisposables: completionNotifier ? [completionNotifier] : [],
  });
}
