import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeRepoRelativePosixPath } from "./repo-path.mjs";
import { MAX_CONTRACT_ARRAY_ITEMS, MAX_CONTRACT_STRING_BYTES } from "./contract-limits.mjs";
import { normalizeModelTier } from "../subagent-dispatch/model-tier.ts";

const CONTRACT_VERSION = "dispatch-ir.v1";
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;
const AGENTS = new Set(["executor"]);
const RISKS = new Set(["low", "normal", "high"]);
const WORKFLOW_MODES = new Set(["tdd", "existing-tests", "docs-only"]);

const TOP_LEVEL_KEYS = [
  "version", "taskId", "title", "agent", "modelTier", "risk", "objective",
  "workflow", "requirements", "context", "boundaries", "acceptance", "execution",
];
const REQUIRED_TOP_LEVEL_KEYS = TOP_LEVEL_KEYS.filter((key) => key !== "modelTier");

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateObject(value, location, allowedKeys, requiredKeys = allowedKeys) {
  if (!isPlainObject(value)) fail(`${location} must be an object`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${location} contains unknown field ${key}`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) fail(`${location} is missing required field ${key}`);
  }
  return value;
}

function normalizeString(value, location, { maxBytes = MAX_CONTRACT_STRING_BYTES } = {}) {
  if (typeof value !== "string") fail(`${location} must be a string`);
  const normalized = value.trim();
  if (!normalized) fail(`${location} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) fail(`${location} exceeds ${maxBytes} bytes`);
  return normalized;
}

function normalizeStringArray(value, location, { minItems = 0, item = normalizeString } = {}) {
  if (!Array.isArray(value)) fail(`${location} must be an array`);
  if (value.length > MAX_CONTRACT_ARRAY_ITEMS) fail(`${location} must contain at most ${MAX_CONTRACT_ARRAY_ITEMS} items`);
  const normalized = [];
  const seen = new Set();
  for (let i = 0; i < value.length; i++) {
    const entry = item(value[i], `${location}[${i}]`);
    if (seen.has(entry)) continue;
    seen.add(entry);
    normalized.push(entry);
  }
  if (normalized.length < minItems) fail(`${location} must contain at least ${minItems} item(s)`);
  return normalized;
}

function normalizeRepoRelativePath(value, location) {
  return normalizeRepoRelativePosixPath(normalizeString(value, location), location);
}

function normalizeWorkflow(value) {
  const workflow = validateObject(value, "workflow", ["mode", "reason"], ["mode"]);
  const mode = normalizeString(workflow.mode, "workflow.mode");
  if (!WORKFLOW_MODES.has(mode)) fail(`workflow.mode is not supported: ${mode}`);
  if (mode === "tdd") {
    if (Object.hasOwn(workflow, "reason")) fail("workflow.reason is forbidden when mode is tdd");
    return { mode };
  }
  if (!Object.hasOwn(workflow, "reason")) fail(`workflow.reason is required when mode is ${mode}`);
  return { mode, reason: normalizeString(workflow.reason, "workflow.reason") };
}

function normalizeContext(value) {
  const context = validateObject(value, "context", ["knownFacts", "decisions", "relevantFiles"]);
  return {
    knownFacts: normalizeStringArray(context.knownFacts, "context.knownFacts"),
    decisions: normalizeStringArray(context.decisions, "context.decisions"),
    relevantFiles: normalizeStringArray(context.relevantFiles, "context.relevantFiles", { item: normalizeRepoRelativePath }),
  };
}

function normalizeBoundaries(value) {
  const boundaries = validateObject(value, "boundaries", ["writePaths", "excludedWork", "forbiddenActions"]);
  return {
    writePaths: normalizeStringArray(boundaries.writePaths, "boundaries.writePaths", { minItems: 1, item: normalizeRepoRelativePath }),
    excludedWork: normalizeStringArray(boundaries.excludedWork, "boundaries.excludedWork"),
    forbiddenActions: normalizeStringArray(boundaries.forbiddenActions, "boundaries.forbiddenActions"),
  };
}

function normalizeAcceptance(value) {
  const acceptance = validateObject(value, "acceptance", ["criteria", "commands"], ["criteria"]);
  const normalized = { criteria: normalizeStringArray(acceptance.criteria, "acceptance.criteria", { minItems: 1 }) };
  if (Object.hasOwn(acceptance, "commands")) normalized.commands = normalizeStringArray(acceptance.commands, "acceptance.commands", { minItems: 1 });
  return normalized;
}

function normalizeExecution(value, baseCwd) {
  const execution = validateObject(value, "execution", ["timeoutMs", "cwd", "worktree"], ["timeoutMs"]);
  if (!Number.isSafeInteger(execution.timeoutMs) || execution.timeoutMs <= 0) fail("execution.timeoutMs must be a positive safe integer");
  const root = normalizeString(baseCwd, "options.cwd");
  if (!path.isAbsolute(root) || root.includes("\0")) fail("options.cwd must be an absolute path");
  const requested = Object.hasOwn(execution, "cwd") ? normalizeString(execution.cwd, "execution.cwd") : root;
  if (requested.includes("\0")) fail("execution.cwd contains NUL");
  const normalized = { cwd: path.resolve(root, requested), timeoutMs: execution.timeoutMs };
  if (Object.hasOwn(execution, "worktree")) {
    if (typeof execution.worktree !== "boolean") fail("execution.worktree must be a boolean");
    if (execution.worktree) normalized.worktree = true;
  }
  return normalized;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function hashCanonical(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function compileCodingDispatchIR(input, { cwd } = {}) {
  const source = validateObject(input, "contract", TOP_LEVEL_KEYS, REQUIRED_TOP_LEVEL_KEYS);
  const version = normalizeString(source.version, "version");
  if (version !== CONTRACT_VERSION) fail(`unsupported coding dispatch contract version: ${version}`);

  const agent = normalizeString(source.agent, "agent");
  if (!AGENTS.has(agent)) fail(`unsupported coding dispatch agent: ${agent}`);

  const risk = normalizeString(source.risk, "risk");
  if (!RISKS.has(risk)) fail(`unsupported coding dispatch risk: ${risk}`);

  const taskId = normalizeString(source.taskId, "taskId", { maxBytes: 160 });
  if (!TASK_ID_PATTERN.test(taskId)) fail("taskId must match ^[A-Za-z0-9._-]{1,160}$");

  const requirements = normalizeStringArray(source.requirements, "requirements", { minItems: 1 });
  const boundaries = normalizeBoundaries(source.boundaries);

  const canonical = {
    version,
    taskId,
    title: normalizeString(source.title, "title"),
    agent,
    modelTier: normalizeModelTier(source.modelTier),
    risk,
    objective: normalizeString(source.objective, "objective"),
    requirements,
    context: normalizeContext(source.context),
    boundaries,
    workflow: normalizeWorkflow(source.workflow),
    acceptance: normalizeAcceptance(source.acceptance),
    execution: normalizeExecution(source.execution, cwd),
  };
  const ir = { ...canonical, hash: hashCanonical(canonical) };
  return deepFreeze(ir);
}

export function splitDispatchEnvelope(ir) {
  if (!isPlainObject(ir) || !/^[a-f0-9]{64}$/.test(ir.hash ?? "")) {
    fail("compiled dispatch IR with SHA-256 hash is required");
  }
  const { hash: contractHash, ...transportContract } = ir;
  return deepFreeze({ contract: deepFreeze(transportContract), contractHash });
}

export function renderDispatchPrompt(ir) {
  const ordered = (items) => items.length === 0 ? "_None declared._" : items.map((item, i) => `${i + 1}. ${JSON.stringify(item)}`).join("\n");
  const workflowReason = ir.workflow.reason === undefined ? "" : `\n- Exemption reason: ${JSON.stringify(ir.workflow.reason)}`;
  const prompt = [
    "# Coding Dispatch Contract v1",
    "",
    "## Identity",
    `- Version: \`${ir.version}\``,
    `- Task ID: ${JSON.stringify(ir.taskId)}`,
    `- Title: ${JSON.stringify(ir.title)}`,
    `- Agent: \`${ir.agent}\``,
    `- Requested model tier: \`${ir.modelTier}\``,
    `- Risk: \`${ir.risk}\``,
    `- Working directory: ${JSON.stringify(ir.execution.cwd)}`,
    `- Timeout: \`${ir.execution.timeoutMs}ms\``,
    ...(ir.execution.worktree === true ? ["- Managed worktree: `true`"] : []),
    `- Contract SHA-256: \`${ir.hash}\``,
    "",
    "## Objective",
    JSON.stringify(ir.objective),
    "",
    "## Requirements",
    ordered(ir.requirements),
    "",
    "## Authoritative Known Facts",
    ordered(ir.context.knownFacts),
    "",
    "## Decisions Already Made",
    ordered(ir.context.decisions),
    "",
    "## Relevant Files",
    ordered(ir.context.relevantFiles),
    "",
    "## Declared Write Scope",
    ordered(ir.boundaries.writePaths),
    "",
    "Modify only the declared write paths. They are a contract and acceptance boundary, not an OS sandbox. Escalate before changing any other path.",
    "",
    "## Excluded Work",
    ordered(ir.boundaries.excludedWork),
    "",
    "## Forbidden Actions",
    ordered(ir.boundaries.forbiddenActions),
    "",
    "## Workflow",
    `- Mode: \`${ir.workflow.mode}\`${workflowReason}`,
    "- Follow the selected workflow exactly and preserve its evidence.",
    "",
    "## Acceptance Criteria",
    ordered(ir.acceptance.criteria),
    "",
    "## Verification Commands",
    ordered(ir.acceptance.commands),
    "",
    "## Escalation",
    "If required information or an unapproved decision is missing, use `contact_supervisor` when available and return `NEEDS_CONTEXT`. Do not substitute broad exploration for missing context or revisit decisions already recorded above.",
    "",
    "## Required Report",
    "Return a compact final report containing:",
    "1. status (`completed` or `NEEDS_CONTEXT`)",
    "2. files changed",
    "3. RED/GREEN or exemption evidence",
    "4. commands and results",
    "5. residual risks",
  ].join("\n");

  if (Buffer.byteLength(prompt, "utf8") > 64 * 1024) fail("coding dispatch prompt exceeds 64KB");
  return prompt;
}
