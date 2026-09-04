import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileCodingDispatchIR, CodingDispatchContractError, renderCodingDispatchPrompt } from "../contracts/dispatch-ir.ts";
import { createManagedWorkspaceRequest } from "../workspace/contract.ts";
import { findManagedWorkspaceService } from "../workspace/registry.ts";
import { executorModelForTier } from "./model-tier.ts";
import { createTypedSubagentRpcClient } from "./rpc-client.ts";
import { createHeadlessSubagentApi } from "./runtime-membrane.ts";
import { buildWorkflowSpawn, createWorkflowChildStartCollector, childStartTimeoutMs } from "./workflow-spawn.ts";
import { getTitleRegistry, normalizeSubagentTitle } from "./title-registry.ts";
import { createSupervisorAdapter, createSupervisorTool } from "./supervisor-adapter.ts";
import { findGoalExecutorCoordinator } from "./root-broker-registry.ts";

const CLEANUP_KEY = "__typedSubagentRuntimeCleanup";
const SHUTDOWN_DEBT_KEY = "__typedSubagentRuntimeShutdownDebt";
const CODING_AGENTS = new Set(["executor"]);
const CONTROL_ACTIONS = new Set(["status", "steer", "interrupt", "resume", "stop"]);

const stringList = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 4096 },
  maxItems: 32,
};
const pathList = { ...stringList, minItems: 0 };

// The detailed branches guide model calls. Narrow fallbacks allow malformed
// expected containers through to compileCodingDispatchIR(), which owns precise
// coding-contract coercion and keypath diagnostics.
const runtimeValidated = (schema, fallback) => ({ anyOf: [schema, fallback, { type: "string" }] });
const looseObject = { type: "object", additionalProperties: true };
const looseArray = { type: "array" };

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
    agent: { enum: ["executor"] },
    modelTier: { enum: ["luna", "terra"] },
    risk: { enum: ["low", "normal", "high"] },
    objective: { type: "string", minLength: 1, maxLength: 4096 },
    requirements: runtimeValidated({ ...stringList, minItems: 1 }, looseArray),
    workflow: runtimeValidated({
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { enum: ["tdd", "existing-tests", "docs-only"] },
        reason: { type: "string", minLength: 1, maxLength: 4096 },
      },
    }, looseObject),
    context: runtimeValidated({
      type: "object",
      additionalProperties: false,
      required: ["knownFacts", "decisions", "relevantFiles"],
      properties: {
        knownFacts: stringList,
        decisions: stringList,
        relevantFiles: pathList,
      },
    }, looseObject),
    boundaries: runtimeValidated({
      type: "object",
      additionalProperties: false,
      required: ["writePaths", "excludedWork", "forbiddenActions"],
      properties: {
        writePaths: { ...pathList, minItems: 1 },
        excludedWork: stringList,
        forbiddenActions: stringList,
      },
    }, looseObject),
    acceptance: runtimeValidated({
      type: "object",
      additionalProperties: false,
      required: ["criteria"],
      properties: {
        criteria: { ...stringList, minItems: 1 },
      },
    }, looseObject),
    execution: runtimeValidated({
      type: "object",
      additionalProperties: false,
      required: ["timeoutMs"],
      properties: {
        cwd: { type: "string", minLength: 1, maxLength: 4096 },
        timeoutMs: { type: "integer", minimum: 1 },
        worktree: { type: "boolean" },
      },
    }, looseObject),
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
      not: { enum: ["executor"] },
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
    worktree: { type: "boolean" },
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

const WORKSPACE_STATUS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["action", "workspace_id"],
  properties: { action: { const: "workspace_status" }, workspace_id: { type: "string", minLength: 1, maxLength: 4096 } },
};
const WORKSPACE_DISPOSITION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["action", "workspace_id", "disposition"],
  properties: { action: { const: "workspace_disposition" }, workspace_id: { type: "string", minLength: 1, maxLength: 4096 }, disposition: { enum: ["integrate", "preserve", "discard", "release"] }, strategy: { enum: ["cherry-pick", "merge"] }, action_token: { type: "string", minLength: 1, maxLength: 4096 } },
  allOf: [{ if: { properties: { disposition: { const: "release" } } }, then: {}, else: { required: ["action_token"] } }],
};

const CONTROL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { enum: ["status", "steer", "interrupt", "resume", "stop"] },
    id: { type: "string", minLength: 1, maxLength: 4096 },
    runId: { type: "string", minLength: 1, maxLength: 4096 },
    dir: { type: "string", minLength: 1, maxLength: 4096 },
    index: { type: "integer", minimum: 0 },
    message: { type: "string", minLength: 1, maxLength: 65536 },
  },
};

export const TYPED_SUBAGENT_PARAMETERS = Object.freeze({
  type: "object",
  anyOf: [CODING_SCHEMA, GENERIC_SCHEMA, CONTROL_SCHEMA, WORKSPACE_STATUS_SCHEMA, WORKSPACE_DISPOSITION_SCHEMA],
});

export const TYPED_SUBAGENT_DESCRIPTION = `Delegate through the project-owned isolated subagent runtime.

For executor, provide the complete dispatch-ir.v1 contract; free-form task dispatch is rejected. Without modelTier, executor candidates come from the ordered models field in its agent definition: first is primary and later entries follow in order. An explicit modelTier:"terra" or modelTier:"luna" selects the matching codex-pool model as a higher-priority primary override; every model in that tier is attempted in declared order before the remaining candidates. Run/status/artifact actual-model metadata is authoritative. Do not use generic dispatch for coding work just to choose a model. For any other agent, provide { agent, title, task } and optional execution fields; title is a concise single-line display label and task is forwarded unchanged. All spawns are detached through RPC. Completion notifications are delivered automatically. After a successful spawn, do not use sleep, status polling, or supervisor pending to wait for completion. Continue only work independent of the children; if none remains, end the turn. Use status only for explicit user requests, intervention, or diagnostics. Supported control actions are status, steer, interrupt, resume, and stop. interrupt pauses the current turn; then use resume with a new non-empty message to continue it with new instructions. A stopped subagent cannot be resumed. Optional worktree:true creates an isolated managed workspace. workspace_status and workspace_disposition are local workspace actions; use release to free a preserved workspace without an action token.`;

const ASYNC_SPAWN_GUIDANCE = "Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0;
}

function failure(code, message, detail, keypath) {
  const keypathSuffix = keypath === undefined || message.includes(`keypath=${keypath}`) ? "" : `; keypath=${keypath}`;
  const text = `${code}: ${message}${keypathSuffix}`;
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: {
      code,
      ...(detail !== undefined ? { detail } : {}),
      ...(keypath !== undefined ? { keypath } : {}),
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

function lifecycleSessionIdentity(session) {
  const sessionFile = session?.sessionFile;
  if (sessionFile !== null && sessionFile !== undefined && !nonempty(sessionFile)) return undefined;
  const identity = sessionFile ?? session?.sessionId;
  return nonempty(identity) ? identity : undefined;
}

function assertSpawnCapabilities(result, cwd) {
  const methods = new Set(Array.isArray(result?.methods) ? result.methods : []);
  const session = result?.session;
  if (
    result?.version !== 1
    || !methods.has("spawn")
    || !nonempty(session?.sessionId)
    || !lifecycleSessionIdentity(session)
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

function assertCodingSpawnIdentity(identity) {
  if (!isRecord(identity) || !nonempty(identity.requestId) || !nonempty(identity.spawnKey) || identity.requestId !== identity.spawnKey) {
    const error = new Error("coding spawn identity must provide matching non-empty requestId and spawnKey");
    error.code = "SPAWN_IDENTITY_INVALID";
    throw error;
  }
}

const CODING_ACCEPTANCE_EVIDENCE = Object.freeze([
  "changed-files",
  "tests-added",
  "commands-run",
  "validation-output",
  "residual-risks",
  "no-staged-files",
]);
const ROOT_SESSION_OWNER_EXTENSION = fileURLToPath(new URL("../../child-extensions/root-session-owner.ts", import.meta.url));
const ACCEPTANCE_EVIDENCE_EXTENSION = fileURLToPath(new URL("../../child-extensions/acceptance-evidence.ts", import.meta.url));

function codingWorkflowSpawnParams(ir, prompt, workflowKey, goalTicket) {
  return buildWorkflowSpawn({
    workflowKey,
    agent: ir.agent,
    task: prompt,
    cwd: ir.execution.cwd,
    context: "fresh",
    timeoutMs: ir.execution.timeoutMs,
    child: {
      output: false,
      subagentOnlyExtensions: [ROOT_SESSION_OWNER_EXTENSION, ...(goalTicket ? [ACCEPTANCE_EVIDENCE_EXTENSION] : [])],
      ...(ir.modelTier === undefined ? {} : { model: executorModelForTier(ir.modelTier) }),
    },
    acceptance: {
      criteria: ir.acceptance.criteria,
      evidence: CODING_ACCEPTANCE_EVIDENCE,
    },
  });
}

function genericWorkflowSpawnParams(input, ctx, workflowKey) {
  const child = {};
  for (const key of ["model", "output", "outputMode", "outputSchema", "skill", "reads", "progress", "acceptance"]) {
    if (input[key] !== undefined) child[key] = input[key];
  }
  return buildWorkflowSpawn({
    workflowKey,
    agent: input.agent,
    task: input.task,
    cwd: input.cwd ?? ctx.cwd,
    context: input.context ?? "fresh",
    timeoutMs: input.timeoutMs,
    artifacts: input.artifacts ?? true,
    child,
  });
}

async function spawnWorkflowLeaf(pi, rpc, {
  workflowKey,
  agent,
  sessionId,
  timeoutMs,
  params,
  identity,
  titleRegistry,
  onBinding,
}) {
  const collector = createWorkflowChildStartCollector(pi.events, {
    workflowKey,
    agent,
    sessionId,
    timeoutMs,
    onBinding,
  });
  try {
    const root = spawnBinding(await rpc.spawn(params, identity));
    titleRegistry.bindWorkflowRoot(root.runId);
    const leaf = await collector.waitFor(root);
    titleRegistry.bindWorkflowLeaf(root.runId, leaf.runId);
    return leaf;
  } finally {
    collector.cancel();
  }
}

function workspacePublic(value) {
  const workspace = value?.receipt ?? value;
  const allowed = value?.allowedDispositions;
  const blocked = value?.blockedReasons;
  const hasActionToken = workspace?.state === "active"
    && Array.isArray(allowed) && allowed.length > 0
    && typeof value?.actionToken === "string" && value.actionToken.length > 0;
  return {
    workspace_id: workspace.workspaceId,
    state: workspace.state,
    workspace_state: workspace.state,
    lease_id: workspace.leaseId,
    process_terminal: value?.terminalProof?.state ?? "unknown",
    ...(workspace.dispatchCwd ? { dispatch_cwd: workspace.dispatchCwd } : {}),
    ...(allowed ? { allowed_dispositions: allowed } : {}),
    ...(hasActionToken ? { action_token: value.actionToken } : {}),
    ...(blocked ? { integrate_blocked_reasons: blocked } : {}),
  };
}
function defaultCanonicalOrigin({ requestedCwd }) {
  const cwd = realpathSync(requestedCwd);
  return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim());
}
function defaultWorkspaceSource({ originRoot }) {
  return {
    originRef: execFileSync("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: originRoot, encoding: "utf8" }).trim(),
    baseCommit: execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: originRoot, encoding: "utf8" }).trim(),
  };
}

function genericContractHash(input, requestedCwd) {
  return createHash("sha256").update(JSON.stringify({
    agent: input.agent,
    title: input.title,
    task: input.task,
    context: input.context ?? "fresh",
    requestedCwd,
  })).digest("hex");
}

function requireWorkspaceService(pi, configured, rootSessionId) {
  const service = configured ?? findManagedWorkspaceService(pi, rootSessionId);
  if (!service) {
    const error = new Error("managed workspace service is unavailable");
    error.code = "WORKSPACE_SERVICE_UNAVAILABLE";
    throw error;
  }
  return service;
}

async function standaloneWorkspaceRequest({ input, ctx, toolCallId, kind, contractHash, createId, resolveCanonicalOrigin, resolveRootSessionId, inspectWorkspaceSource }) {
  if (typeof resolveRootSessionId !== "function") {
    const error = new Error("WORKSPACE_SESSION_ID_UNAVAILABLE"); error.code = "WORKSPACE_SESSION_ID_UNAVAILABLE"; throw error;
  }
  const rootSessionId = resolveRootSessionId(ctx.sessionManager);
  if (!nonempty(rootSessionId)) {
    const error = new Error("WORKSPACE_SESSION_ID_UNAVAILABLE"); error.code = "WORKSPACE_SESSION_ID_UNAVAILABLE"; throw error;
  }
  const rawCwd = kind === "generic" ? input.cwd ?? ctx.cwd : input.execution.cwd ?? ctx.cwd;
  const requestedCwd = path.resolve(ctx.cwd, rawCwd);
  let canonicalRequestedCwd = requestedCwd;
  try { canonicalRequestedCwd = realpathSync(requestedCwd); } catch { /* injected/fake origins may not exist until the service allocates them */ }
  const originRoot = await resolveCanonicalOrigin({ requestedCwd: canonicalRequestedCwd, ctx });
  const source = await inspectWorkspaceSource({ originRoot, requestedCwd, ctx });
  return createManagedWorkspaceRequest({
    workspaceId: createId(),
    owner: { kind: "standalone-subagent", rootSessionId, toolCallId },
    originRoot,
    requestedCwd: canonicalRequestedCwd,
    originRef: source.originRef,
    baseCommit: source.baseCommit,
    contractHash: contractHash ?? genericContractHash(input, requestedCwd),
    mode: kind,
    writePaths: kind === "coding" ? input.boundaries.writePaths : [],
  });
}

async function executeCoding(pi, toolCallId, input, ctx, rpc, createId, titleRegistry, prepareCodingSpawn, resolveCodingSpawnIdentity, configuredGoalCoordinator, workflowChildStartTimeoutMs, configuredWorkspaceService, resolveCanonicalOrigin, resolveRootSessionId, registerFacadeRun, inspectWorkspaceSource) {
  const ir = compileCodingDispatchIR(input, { cwd: ctx.cwd });
  const rootSessionId = typeof resolveRootSessionId === "function" ? resolveRootSessionId(ctx.sessionManager) : undefined;
  const goalCoordinator = configuredGoalCoordinator ?? findGoalExecutorCoordinator(pi, rootSessionId);
  const bindingRequest = { toolCallId, contract: input, contractHash: ir.hash, ctx };
  const ticket = await goalCoordinator?.prepareSpawn(bindingRequest);
  let workspaceRequest;
  if (ticket) {
    if (ir.execution.worktree !== true || !ticket.workspaceRequest) {
      const error = new Error("Goal executor ticket requires an explicit managed workspace request");
      error.code = "EXECUTOR_BINDING_MISMATCH";
      throw error;
    }
    workspaceRequest = createManagedWorkspaceRequest(ticket.workspaceRequest);
    if (workspaceRequest.owner.kind !== "goal-task" || workspaceRequest.contractHash !== ir.hash) {
      const error = new Error("Goal executor workspace request does not match the source contract");
      error.code = "EXECUTOR_BINDING_MISMATCH";
      throw error;
    }
  } else if (ir.execution.worktree === true) {
    workspaceRequest = await standaloneWorkspaceRequest({ input, ctx, toolCallId, kind: "coding", contractHash: ir.hash, createId, resolveCanonicalOrigin, resolveRootSessionId, inspectWorkspaceSource });
  }
  const workspaceService = workspaceRequest ? requireWorkspaceService(pi, configuredWorkspaceService, rootSessionId) : undefined;
  let workspace = workspaceRequest ? await workspaceService.ensureAllocated(workspaceRequest) : undefined;
  if (ticket) {
    await goalCoordinator.workspaceAllocated(ticket, workspace);
    await goalCoordinator.confirmSpawn(ticket, workspace);
  }
  const runtimeIr = workspace ? { ...ir, execution: { ...ir.execution, cwd: workspace.dispatchCwd, worktree: true } } : ir;
  const runtimePrompt = renderCodingDispatchPrompt(runtimeIr);
  const capabilities = await rpc.ping();
  assertSpawnCapabilities(capabilities, ctx.cwd);
  await prepareCodingSpawn(runtimeIr, ticket);
  titleRegistry.prepare({ agent: runtimeIr.agent, task: runtimePrompt, title: runtimeIr.title });
  const customIdentity = typeof resolveCodingSpawnIdentity === "function"
    ? await resolveCodingSpawnIdentity({ toolCallId, contract: input, contractHash: ir.hash })
    : undefined;
  if (customIdentity !== undefined) assertCodingSpawnIdentity(customIdentity);
  if (ticket?.spawnIdentity && customIdentity
      && (ticket.spawnIdentity.requestId !== customIdentity.requestId || ticket.spawnIdentity.spawnKey !== customIdentity.spawnKey)) {
    const error = new Error("Goal executor spawn identity conflicts with the configured resolver");
    error.code = "EXECUTOR_BINDING_MISMATCH";
    throw error;
  }
  const identity = ticket?.spawnIdentity ?? customIdentity;
  if (identity !== undefined) assertCodingSpawnIdentity(identity);
  const dispatchId = identity?.spawnKey ?? createId();
  const workflowKey = `typed-${dispatchId}`;
  let authoritativeBinding: any;
  const binding = await spawnWorkflowLeaf(pi, rpc, {
    workflowKey,
    agent: ir.agent,
    sessionId: lifecycleSessionIdentity(capabilities.session),
    timeoutMs: childStartTimeoutMs(workflowChildStartTimeoutMs, ir.execution.timeoutMs),
    params: codingWorkflowSpawnParams(runtimeIr, runtimePrompt, workflowKey, ticket),
    identity,
    titleRegistry,
    onBinding: (observed) => {
      authoritativeBinding = observed;
    },
  });
  if (workspace) {
    workspace = await workspaceService.bindRun({ workspaceId: workspace.workspaceId, run: binding });
    if (!ticket) {
      if (typeof registerFacadeRun !== "function" || !authoritativeBinding) {
        const error = new Error("FACADE_PROOF_UNAVAILABLE"); error.code = "FACADE_PROOF_UNAVAILABLE"; throw error;
      }
      registerFacadeRun(authoritativeBinding);
    }
  }
  if (ticket) {
    if (!authoritativeBinding || authoritativeBinding.runId !== binding.runId || authoritativeBinding.asyncDir !== binding.asyncDir) {
      const error = new Error("Goal executor authoritative lifecycle binding is unavailable");
      error.code = "EXECUTOR_BINDING_MISMATCH";
      throw error;
    }
    await goalCoordinator.bindSpawn(ticket, authoritativeBinding);
  }
  titleRegistry.remember(binding.runId, ir.title);
  const handle = {
    version: "coding-dispatch-handle.v1",
    dispatchId,
    taskId: ir.taskId,
    agent: ir.agent,
    title: ir.title,
    contractHash: ir.hash,
    ...binding,
    ...(workspace ? workspacePublic(workspace) : {}),
  };
  return {
    content: [{ type: "text", text: `Started ${handle.agent}: ${handle.title} (${handle.runId}). ${ASYNC_SPAWN_GUIDANCE}` }],
    isError: false,
    details: handle,
  };
}

async function executeGeneric(pi, toolCallId, input, ctx, rpc, createId, titleRegistry, workflowChildStartTimeoutMs, configuredWorkspaceService, resolveCanonicalOrigin, resolveRootSessionId, registerFacadeRun, inspectWorkspaceSource) {
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
  const workspaceRequest = input.worktree === true
    ? await standaloneWorkspaceRequest({ input, ctx, toolCallId, kind: "generic", createId, resolveCanonicalOrigin, resolveRootSessionId, inspectWorkspaceSource })
    : undefined;
  const rootSessionId = typeof resolveRootSessionId === "function" ? resolveRootSessionId(ctx.sessionManager) : undefined;
  const workspaceService = workspaceRequest ? requireWorkspaceService(pi, configuredWorkspaceService, rootSessionId) : undefined;
  let workspace = workspaceRequest ? await workspaceService.ensureAllocated(workspaceRequest) : undefined;
  const capabilities = await rpc.ping();
  assertSpawnCapabilities(capabilities, ctx.cwd);
  titleRegistry.prepare({ agent: input.agent, task: input.task, title });
  const workflowKey = `typed-${createId()}`;
  let authoritativeBinding: any;
  const binding = await spawnWorkflowLeaf(pi, rpc, {
    workflowKey,
    agent: input.agent,
    sessionId: lifecycleSessionIdentity(capabilities.session),
    timeoutMs: childStartTimeoutMs(workflowChildStartTimeoutMs, input.timeoutMs ?? 120_000),
    params: genericWorkflowSpawnParams(workspace ? { ...input, cwd: workspace.dispatchCwd } : input, ctx, workflowKey),
    titleRegistry,
    onBinding: (observed) => { authoritativeBinding = observed; },
  });
  if (workspace) {
    workspace = await workspaceService.bindRun({ workspaceId: workspace.workspaceId, run: binding });
    if (typeof registerFacadeRun !== "function" || !authoritativeBinding) {
      const error = new Error("FACADE_PROOF_UNAVAILABLE"); error.code = "FACADE_PROOF_UNAVAILABLE"; throw error;
    }
    registerFacadeRun(authoritativeBinding);
  }
  titleRegistry.remember(binding.runId, title);
  return {
    content: [{ type: "text", text: `Started ${input.agent}: ${title} (${binding.runId}). ${ASYNC_SPAWN_GUIDANCE}` }],
    isError: false,
    details: { ...binding, agent: input.agent, title, ...(workspace ? workspacePublic(workspace) : {}) },
  };
}
async function executeWorkspaceAction(input, service) {
  if (input.action === "workspace_disposition" && input.strategy !== undefined && input.disposition !== "integrate") {
    return failure("INVALID_WORKSPACE_STRATEGY", "strategy is only valid for integrate");
  }
  let value;
  if (input.action === "workspace_status") {
    const status = await service.status({ workspaceId: input.workspace_id });
    value = status.receipt?.state === "active" ? await service.issueDisposition({ workspaceId: input.workspace_id }) : status;
  } else if (input.disposition === "release") {
    value = await service.release({ workspaceId: input.workspace_id });
  } else {
    value = await service.dispose({
      workspaceId: input.workspace_id,
      disposition: input.disposition,
      strategy: input.strategy ?? "cherry-pick",
      reason: input.disposition === "preserve" ? "subagent workspace preserved" : undefined,
      actionToken: input.action_token,
    });
  }
  const publicWorkspace = workspacePublic(value);
  return { content: [{ type: "text", text: JSON.stringify(publicWorkspace) }], isError: false, details: publicWorkspace };
}

async function executeControl(input, rpc) {
  if (!CONTROL_ACTIONS.has(input.action)) {
    return failure("UNSUPPORTED_ACTION", `unsupported subagent RPC action: ${String(input.action)}`);
  }
  if (input.action === "resume" && !nonempty(input.message)) {
    return failure("INVALID_RESUME_MESSAGE", "resume requires a non-empty message", undefined, "$.message");
  }
  const { action, ...params } = input;
  return rpcResult(await rpc[action](params));
}

function shutdownDebtManager(cleanupStore) {
  const current = cleanupStore[SHUTDOWN_DEBT_KEY];
  if (current?.lanes instanceof WeakMap) {
    if (!(current.sessionLanes instanceof Set)) current.sessionLanes = new Set();
    return current;
  }
  const manager = {
    lanes: new WeakMap(),
    sessionLanes: new Set(),
    debts: current?.debts instanceof Array ? current.debts : (current ? [current] : []),
  };
  cleanupStore[SHUTDOWN_DEBT_KEY] = manager;
  return manager;
}

function shutdownDebtLane(manager, pi) {
  // ExtensionAPI objects change on reload; its event bus is only a fallback lineage.
  const identity = pi.events && (typeof pi.events === "object" || typeof pi.events === "function") ? pi.events : pi;
  let lane = manager.lanes.get(identity);
  if (!lane) {
    lane = { debts: [] };
    manager.lanes.set(identity, lane);
  }
  manager.debts = lane.debts;
  return lane;
}

function sessionDebtLane(manager, ctx) {
  // Pi reload recreates ExtensionAPI event facades; the live SessionManager is stable per session.
  const identity = ctx?.sessionManager;
  if (identity === null || (typeof identity !== "object" && typeof identity !== "function")) return undefined;
  let lane = manager.lanes.get(identity);
  if (!lane) {
    lane = { debts: [] };
    manager.lanes.set(identity, lane);
  }
  manager.sessionLanes.add(lane);
  manager.debts = lane.debts;
  return lane;
}

function hasPendingSessionDebt(manager) {
  for (const lane of manager.sessionLanes) {
    if (lane.debts.some((debt) => !debt.completed)) return true;
  }
  return false;
}

function releaseCompletedDebts(lane) {
  while (lane.debts[0]?.completed) lane.debts.shift();
}

async function repayDebts(lane, before, retryCtx) {
  for (const debt of [...lane.debts]) {
    if (debt === before) break;
    if (!debt.completed) await debt.run(debt.event, retryCtx ?? debt.ctx, true);
  }
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

export function createSupervisorRequestMailbox(route, { limit = 1024 } = {}) {
  if (typeof route !== "function") throw new TypeError("Supervisor request mailbox route must be a function");
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("Supervisor request mailbox limit must be a positive safe integer");
  }

  let active = false;
  let disposed = false;
  let draining;
  const queue = [];

  const drain = async () => {
    while (active && queue.length > 0) {
      const { message, context } = queue.shift();
      try {
        await route(message, context);
      } catch (error) {
        active = false;
        throw error;
      }
    }
  };

  return Object.freeze({
    handle(message, context) {
      if (disposed) return;
      if (active && !draining) return route(message, context);
      if (queue.length >= limit) {
        const error = new Error("SUPERVISOR_REQUEST_QUEUE_FULL: Supervisor startup mailbox is full");
        error.code = "SUPERVISOR_REQUEST_QUEUE_FULL";
        throw error;
      }
      queue.push({ message, context });
    },
    activate() {
      if (disposed) return Promise.resolve();
      active = true;
      if (draining) return draining;
      draining = drain().finally(() => { draining = undefined; });
      return draining;
    },
    deactivate() {
      active = false;
      queue.length = 0;
    },
    dispose() {
      disposed = true;
      active = false;
      queue.length = 0;
    },
  });
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
    renderSubagentCall,
    renderSubagentResult,
    renderSupervisorCall,
    renderSupervisorResult,
    prepareCodingSpawn = async () => {},
    resolveCodingSpawnIdentity,
    goalExecutorCoordinator,
    workflowChildStartTimeoutMs,
    beforeDispose = async () => {},
    retainOnBeforeDisposeFailure = false,
    afterBeforeDispose = async () => {},
    beforeSessionStart = async () => {},
    onSupervisorRequest,
    workspaceService,
    resolveRootSessionId,
    registerFacadeRun,
    resolveCanonicalOrigin = defaultCanonicalOrigin,
    inspectWorkspaceSource = defaultWorkspaceSource,
  } = {},
) {
  // Durable debt retention supersedes this legacy opt-in; retain it for callers on the old API.
  void retainOnBeforeDisposeFailure;
  if (workflowChildStartTimeoutMs !== undefined
      && (!Number.isSafeInteger(workflowChildStartTimeoutMs) || workflowChildStartTimeoutMs <= 0)) {
    throw new TypeError("workflow child start timeout must be a positive safe integer");
  }
  const registry = cleanupRegistry(cleanupStore);
  const debtManager = shutdownDebtManager(cleanupStore);
  let debtLane = shutdownDebtLane(debtManager, pi);
  let shutdownDebt;
  const bindSessionDebtLane = (ctx) => {
    const lane = sessionDebtLane(debtManager, ctx);
    if (!lane || lane === debtLane) return;
    if (shutdownDebt) {
      const debtIndex = debtLane.debts.indexOf(shutdownDebt);
      if (debtIndex >= 0) debtLane.debts.splice(debtIndex, 1);
      if (!lane.debts.includes(shutdownDebt)) lane.debts.push(shutdownDebt);
    }
    debtLane = lane;
    debtManager.debts = lane.debts;
  };
  const previous = registry.get(pi);
  if (previous?.debt && !previous.debt.completed) {
    Promise.resolve(previous.debt.run(previous.debt.event, previous.debt.ctx, true)).catch(() => {
      // The replacement generation's ready gate retains and retries this debt.
    });
  }

  const token = Symbol("typed-subagent-runtime");
  const resources = [
    { dispose: () => supervisorAdapter?.dispose?.(), done: !supervisorAdapter?.dispose },
    ...extraDisposables.map((disposable) => ({ dispose: () => disposable?.dispose?.(), done: !disposable?.dispose })),
    { dispose: () => rpc.dispose?.(), done: !rpc.dispose },
  ];
  let disposed = false;
  let disposeFlight;
  const dispose = async () => {
    if (disposed) return;
    if (disposeFlight) return disposeFlight;
    disposeFlight = (async () => {
      const errors = [];
      for (const resource of resources) {
        if (resource.done) continue;
        try { await resource.dispose(); resource.done = true; } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "typed subagent runtime disposal failed");
      disposed = true;
    })();
    try {
      return await disposeFlight;
    } finally {
      if (!disposed) disposeFlight = undefined;
    }
  };

  const tool = {
    name: "subagent",
    label: "Subagent",
    description: TYPED_SUBAGENT_DESCRIPTION,
    parameters: TYPED_SUBAGENT_PARAMETERS,
    ...(typeof renderSubagentCall === "function" ? { renderCall: renderSubagentCall } : {}),
    ...(typeof renderSubagentResult === "function" ? { renderResult: renderSubagentResult } : {}),
    async execute(toolCallId, input, _signal, _onUpdate, ctx) {
      try {
        if (!isRecord(input)) return failure("INVALID_DISPATCH", `subagent input must be an object; expected object; received ${input === null ? "null" : Array.isArray(input) ? "array" : typeof input}`, "$", "$");
        const rootSessionId = typeof resolveRootSessionId === "function" ? resolveRootSessionId(ctx.sessionManager) : undefined;
        if (input.action === "workspace_status" || input.action === "workspace_disposition") {
          return await executeWorkspaceAction(input, requireWorkspaceService(pi, workspaceService, rootSessionId));
        }
        if (Object.hasOwn(input, "action")) return await executeControl(input, rpc);
        if (Object.hasOwn(input, "version")) {
          return await executeCoding(pi, toolCallId, input, ctx, rpc, createId, titleRegistry, prepareCodingSpawn, resolveCodingSpawnIdentity, goalExecutorCoordinator, workflowChildStartTimeoutMs, workspaceService, resolveCanonicalOrigin, resolveRootSessionId, registerFacadeRun, inspectWorkspaceSource);
        }
        return await executeGeneric(pi, toolCallId, input, ctx, rpc, createId, titleRegistry, workflowChildStartTimeoutMs, workspaceService, resolveCanonicalOrigin, resolveRootSessionId, registerFacadeRun, inspectWorkspaceSource);
      } catch (error) {
        const code = error?.code
          ?? (error instanceof CodingDispatchContractError ? error.code : "SUBAGENT_RPC_FAILED");
        return failure(code, error instanceof Error ? error.message : String(error), error?.detail, error?.keypath);
      }
    },
  };
  const supervisorTool = supervisorAdapter ? createSupervisorTool(supervisorAdapter, {
    renderCall: renderSupervisorCall,
    renderResult: renderSupervisorResult,
  }) : undefined;
  let ready;
  try {
    pi.registerTool(tool);

    if (typeof onSupervisorRequest === "function") {
      pi.on("message_end", async (event, ctx) => {
        if (disposed || registry.get(pi)?.token !== token) return;
        const message = event?.message;
        if (message?.customType === "subagent_supervisor_request") await onSupervisorRequest(message, ctx);
      });
    }

    if (supervisorTool) pi.registerTool(supervisorTool);

    shutdownDebt = { attempted: false, completed: false, inFlight: undefined, run: undefined, event: undefined, ctx: undefined };
    shutdownDebt.run = async (event, ctx, force = false) => {
      if (shutdownDebt.completed || (!force && registry.get(pi)?.token !== token)) return;
      if (!shutdownDebt.attempted) {
        bindSessionDebtLane(ctx);
        shutdownDebt.event = event;
        shutdownDebt.ctx = ctx;
      }
      shutdownDebt.attempted = true;
      if (shutdownDebt.inFlight) return shutdownDebt.inFlight;
      // Pi invalidates the old ExtensionContext after reload, so retries use the new live context.
      const cleanupCtx = force && ctx !== undefined ? ctx : shutdownDebt.ctx;
      shutdownDebt.inFlight = (async () => {
        await repayDebts(debtLane, shutdownDebt, cleanupCtx);
        await beforeDispose(shutdownDebt.event, cleanupCtx);
        await afterBeforeDispose(shutdownDebt.event, cleanupCtx);
        await dispose();
        if (registry.get(pi)?.token === token) registry.delete(pi);
        shutdownDebt.completed = true;
        releaseCompletedDebts(debtLane);
      })();
      try {
        return await shutdownDebt.inFlight;
      } finally {
        if (!shutdownDebt.completed) shutdownDebt.inFlight = undefined;
      }
    };
    debtLane.debts.push(shutdownDebt);
    registry.set(pi, { token, dispose, debt: shutdownDebt, lane: debtLane });
    let startFlight;
    let started = false;
    ready = async (event, ctx) => {
      if (started) return;
      if (startFlight) return startFlight;
      startFlight = (async () => {
        bindSessionDebtLane(ctx);
        if (shutdownDebt.attempted && !shutdownDebt.completed) {
          await shutdownDebt.run(event, ctx, true);
          return;
        }
        await repayDebts(debtLane, shutdownDebt, ctx);
        await beforeSessionStart(event, ctx);
        started = true;
      })();
      try {
        return await startFlight;
      } finally {
        if (!started) startFlight = undefined;
      }
    };
    pi.on("session_start", async (event, ctx) => {
      if (registry.get(pi)?.token !== token) return;
      await ready(event, ctx);
    });
    pi.on("session_shutdown", shutdownDebt.run);
    if (supervisorTool) {
      pi.on("session_start", async (event, ctx) => {
        if (registry.get(pi)?.token !== token) return;
        await ready(event, ctx);
        if (registry.get(pi)?.token !== token || supervisorAdapter.isBound()) return;
        deactivateSupervisorTool(pi);
        const error = new Error("SUPERVISOR_TARGET_UNAVAILABLE");
        error.code = "SUPERVISOR_TARGET_UNAVAILABLE";
        throw error;
      });
    }
  } catch (error) {
    if (shutdownDebt) {
      const debtIndex = debtLane.debts.indexOf(shutdownDebt);
      if (debtIndex >= 0) debtLane.debts.splice(debtIndex, 1);
    }
    if (registry.get(pi)?.token === token) registry.delete(pi);
    void Promise.resolve(dispose()).catch(() => undefined);
    throw error;
  }

  const executeSupervisor = async (params, ctx) => supervisorAdapter.execute(randomUUID(), params, undefined, undefined, ctx);
  return Object.freeze({ tool, supervisorTool, executeSupervisor, dispose, ready });
}

export function installHeadlessTypedSubagentRuntime(pi, {
  bootstrap,
  completionNotifierFactory,
  resolveSessionId,
  beforeRuntimeDispose,
  beforeUpstreamSessionStart = async () => {},
  ...options
} = {}) {
  if (typeof bootstrap !== "function") {
    throw new TypeError("typed subagent runtime requires an upstream bootstrap function");
  }
  const supervisorAdapter = createSupervisorAdapter();
  const titleRegistry = options.titleRegistry ?? getTitleRegistry(options.cleanupStore ?? globalThis);
  titleRegistry.resetCompleted?.();
  const upstreamShutdownHandlers = [];
  const upstreamSessionStartHandlers = [];
  const deferredEventSubscriptions = [];
  const cleanupStore = options.cleanupStore ?? globalThis;
  const debtManager = shutdownDebtManager(cleanupStore);
  const debtLane = shutdownDebtLane(debtManager, pi);
  const globalStore = globalThis;
  const globalCleanupKeys = ["__piSubagentRuntimeCleanup", "__piSubagentEventUnsubscribes"];
  const globalOwnership = globalCleanupKeys.map((key) => ({ key, present: Object.hasOwn(globalStore, key), value: globalStore[key] }));
  const hiddenOwnership = debtLane.debts.some((debt) => !debt.completed) || hasPendingSessionDebt(debtManager);
  if (hiddenOwnership) {
    // Upstream performs best-effort global cleanup synchronously during bootstrap.
    // Hide the old generation until its ordered shutdown debt has been repaid.
    for (const { key } of globalOwnership) delete globalStore[key];
  }
  let generationOwnership;
  const rollbackOwnership = new Map();
  const snapshotOwnership = (key) => ({ present: Object.hasOwn(globalStore, key), value: globalStore[key] });
  const matchesOwnership = (key, ownership) => ownership
    && Object.hasOwn(globalStore, key) === ownership.present
    && (!ownership.present || globalStore[key] === ownership.value);
  const cleanupGenerationOwnership = () => {
    if (!generationOwnership) return;
    for (const { key } of globalOwnership) {
      const owned = generationOwnership.get(key);
      if (!matchesOwnership(key, owned)) continue;
      try {
        if (key === "__piSubagentRuntimeCleanup" && typeof owned.value === "function") owned.value();
        if (key === "__piSubagentEventUnsubscribes" && Array.isArray(owned.value)) {
          for (const unsubscribe of owned.value) if (typeof unsubscribe === "function") unsubscribe();
        }
      } catch {
        // Preserve the installation error while continuing best-effort rollback.
      }
      const released = snapshotOwnership(key);
      if (!released.present || matchesOwnership(key, owned)) rollbackOwnership.set(key, released);
    }
  };
  const restoreOwnership = () => {
    if (!hiddenOwnership) return;
    for (const { key, present, value } of globalOwnership) {
      const expected = rollbackOwnership.get(key) ?? generationOwnership?.get(key);
      if (generationOwnership && !matchesOwnership(key, expected)) continue;
      if (present) globalStore[key] = value;
      else delete globalStore[key];
    }
  };
  const captureEventSubscription = (type, handler) => {
    if (typeof handler !== "function") throw new TypeError("upstream event handler must be a function");
    const entry = { type, handler, active: false, cancelled: false, unsubscribe: undefined };
    deferredEventSubscriptions.push(entry);
    return () => {
      if (entry.cancelled) return;
      entry.cancelled = true;
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
    };
  };
  const activateEventSubscriptions = () => {
    for (const entry of deferredEventSubscriptions) {
      if (entry.cancelled || entry.active) continue;
      entry.unsubscribe = pi.events.on(entry.type, entry.handler);
      entry.active = true;
    }
  };
  try {
  bootstrap(createHeadlessSubagentApi(pi, {
    supervisorAdapter,
    titleRegistry,
    suppressCompletionNotifications: typeof completionNotifierFactory === "function",
    captureSessionStart(handler) {
      if (typeof handler !== "function") throw new TypeError("upstream session_start handler must be a function");
      upstreamSessionStartHandlers.push(handler);
      return () => {
        const index = upstreamSessionStartHandlers.indexOf(handler);
        if (index >= 0) upstreamSessionStartHandlers.splice(index, 1);
      };
    },
    captureSessionShutdown(handler) {
      if (typeof handler !== "function") throw new TypeError("upstream session_shutdown handler must be a function");
      upstreamShutdownHandlers.push({ handler, completed: false });
      return () => {
        const index = upstreamShutdownHandlers.findIndex((entry) => entry.handler === handler);
        if (index >= 0) upstreamShutdownHandlers.splice(index, 1);
      };
    },
    captureEventSubscription,
  }));
  } catch (error) {
    generationOwnership = new Map(globalCleanupKeys.map((key) => [key, snapshotOwnership(key)]));
    cleanupGenerationOwnership();
    restoreOwnership();
    throw error;
  }
  generationOwnership = new Map(globalCleanupKeys.map((key) => [key, snapshotOwnership(key)]));

  let completionNotifier;
  let notificationState;
  try {
    if (typeof completionNotifierFactory === "function") {
      if (typeof resolveSessionId !== "function") {
        throw new TypeError("title-aware completion notification requires a session identity resolver");
      }
      notificationState = { currentSessionId: null };
      completionNotifier = completionNotifierFactory(
        createHeadlessSubagentApi(pi, {
          titleRegistry,
          forceCompletionDisplay: true,
          suppressSuccessfulCompletion(event) { return titleRegistry.isFacadeWorkflowSuccess?.(event) === true; },
          captureEventSubscription,
        }),
        notificationState,
      );
      if (!completionNotifier || typeof completionNotifier.dispose !== "function") {
        throw new TypeError("completion notifier factory must return a disposable notifier");
      }
      pi.on("session_start", (_event, ctx) => {
        notificationState.currentSessionId = resolveSessionId(ctx.sessionManager);
      });
    }

    return createTypedSubagentExtension(pi, {
    ...options,
    supervisorAdapter,
    titleRegistry,
    extraDisposables: [
      ...(completionNotifier ? [completionNotifier, { dispose() { notificationState.currentSessionId = null; } }] : []),
      { dispose() { for (const entry of deferredEventSubscriptions) { entry.cancelled = true; entry.unsubscribe?.(); entry.unsubscribe = undefined; } } },
    ],
    beforeDispose: beforeRuntimeDispose,
    async beforeSessionStart(event, ctx) {
      await beforeUpstreamSessionStart(event, ctx);
      for (const handler of upstreamSessionStartHandlers) await handler(event, ctx);
      activateEventSubscriptions();
    },
    async afterBeforeDispose(event, ctx) {
      for (const entry of upstreamShutdownHandlers) {
        if (!Object.hasOwn(entry, "event")) {
          entry.event = event;
          entry.ctx = ctx;
        }
      }
      for (const entry of upstreamShutdownHandlers) {
        if (entry.completed) continue;
        await entry.handler(entry.event, entry.ctx);
        entry.completed = true;
      }
    },
    });
  } catch (error) {
    completionNotifier?.dispose?.();
    for (const entry of deferredEventSubscriptions) {
      entry.cancelled = true;
      entry.unsubscribe?.();
    }
    cleanupGenerationOwnership();
    restoreOwnership();
    throw error;
  }
}
