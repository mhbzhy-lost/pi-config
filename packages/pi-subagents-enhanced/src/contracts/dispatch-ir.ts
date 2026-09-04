import { createHash } from "node:crypto";
import path from "node:path";

const CONTRACT_VERSION = "dispatch-ir.v1";
const MAX_ARRAY_ITEMS = 32;
const MAX_STRING_BYTES = 4 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;
const AGENTS = new Set(["executor"]);
const MODEL_TIERS = new Set(["luna", "terra"]);
const RISKS = new Set(["low", "normal", "high"]);
const WORKFLOW_MODES = new Set(["tdd", "existing-tests", "docs-only"]);
const TOP_LEVEL_KEYS = [
  "version",
  "taskId",
  "title",
  "agent",
  "modelTier",
  "risk",
  "objective",
  "workflow",
  "requirements",
  "context",
  "boundaries",
  "acceptance",
  "execution",
];
const REQUIRED_TOP_LEVEL_KEYS = TOP_LEVEL_KEYS.filter((key) => key !== "modelTier");
const COERCIBLE_FIELDS = ["workflow", "requirements", "context", "boundaries", "acceptance", "execution"];

export class CodingDispatchContractError extends Error {
  constructor(code, message, detail = message, keypath) {
    super(message);
    this.name = "CodingDispatchContractError";
    this.code = code;
    this.detail = String(detail);
    if (keypath !== undefined) this.keypath = String(keypath);
  }
}

function fail(code, message, keypath) {
  throw new CodingDispatchContractError(code, `${message}; keypath=${keypath}`, keypath, keypath);
}

function runtimeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function failTypeMismatch(location, expected, value) {
  fail("INVALID_CONTRACT", `${location} must be a ${expected}; expected ${expected}; received ${runtimeType(value)}`, location);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function coerceStringifiedJson(value, location) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    fail("INVALID_CONTRACT", `${location} contains malformed JSON string`, location);
  }
}

function coerceContractFields(input) {
  if (!isPlainObject(input)) return input;
  const coerced = { ...input };
  for (const field of COERCIBLE_FIELDS) {
    if (Object.hasOwn(coerced, field)) coerced[field] = coerceStringifiedJson(coerced[field], field);
  }
  return coerced;
}

function validateObject(value, location, allowedKeys, requiredKeys = allowedKeys) {
  if (!isPlainObject(value)) failTypeMismatch(location, "object", value);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("INVALID_CONTRACT", `${location} contains unknown field ${key}`, `${location}.${key}`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) fail("INVALID_CONTRACT", `${location} is missing required field ${key}`, `${location}.${key}`);
  }
  return value;
}

function normalizeString(value, location, { maxBytes = MAX_STRING_BYTES } = {}) {
  if (typeof value !== "string") failTypeMismatch(location, "string", value);
  const normalized = value.trim();
  if (!normalized) fail("INVALID_CONTRACT", `${location} must not be empty`, location);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) fail("INVALID_CONTRACT", `${location} exceeds ${maxBytes} bytes`, location);
  return normalized;
}

function normalizeStringArray(value, location, { minItems = 0, item = normalizeString } = {}) {
  if (!Array.isArray(value)) failTypeMismatch(location, "array", value);
  if (value.length > MAX_ARRAY_ITEMS) fail("INVALID_CONTRACT", `${location} must contain at most ${MAX_ARRAY_ITEMS} items`, location);
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entry = item(value[index], `${location}[${index}]`);
    if (seen.has(entry)) continue;
    seen.add(entry);
    normalized.push(entry);
  }
  if (normalized.length < minItems) fail("INVALID_CONTRACT", `${location} must contain at least ${minItems} item(s)`, location);
  return normalized;
}

function normalizeRepoRelativePath(value, location) {
  const normalized = normalizeString(value, location);
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\");
  if (normalized.includes("\0") || normalized.includes("\\") || normalized.startsWith("/") || windowsAbsolute) {
    fail("INVALID_PATH", `${location} must be a repo-relative POSIX path`, location);
  }
  const recursive = normalized.endsWith("/**");
  const base = recursive ? normalized.slice(0, -3) : normalized;
  if (!base || base.endsWith("/") || /[*?\[\]]/.test(base)) fail("INVALID_PATH", `${location} contains an unsupported path pattern`, location);
  const segments = base.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("INVALID_PATH", `${location} contains an unsafe path segment`, location);
  }
  return recursive ? `${segments.join("/")}/**` : segments.join("/");
}

function normalizeWorkflow(value) {
  const workflow = validateObject(value, "workflow", ["mode", "reason"], ["mode"]);
  const mode = normalizeString(workflow.mode, "workflow.mode");
  if (!WORKFLOW_MODES.has(mode)) fail("INVALID_CONTRACT", `workflow.mode is not supported: ${mode}`, "workflow.mode");
  if (mode === "tdd") {
    if (Object.hasOwn(workflow, "reason")) fail("INVALID_CONTRACT", "workflow.reason is forbidden when mode is tdd", "workflow.reason");
    return { mode };
  }
  if (!Object.hasOwn(workflow, "reason")) fail("INVALID_CONTRACT", `workflow.reason is required when mode is ${mode}`, "workflow.reason");
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
  const acceptance = validateObject(value, "acceptance", ["criteria"]);
  return { criteria: normalizeStringArray(acceptance.criteria, "acceptance.criteria", { minItems: 1 }) };
}

function normalizeExecution(value, baseCwd) {
  const execution = validateObject(value, "execution", ["timeoutMs", "cwd", "worktree"], ["timeoutMs"]);
  if (!Number.isSafeInteger(execution.timeoutMs) || execution.timeoutMs <= 0) {
    fail("INVALID_CONTRACT", `execution.timeoutMs must be a positive safe integer; expected positive safe integer; received ${runtimeType(execution.timeoutMs)}`, "execution.timeoutMs");
  }
  const root = normalizeString(baseCwd, "options.cwd");
  if (!path.isAbsolute(root) || root.includes("\0")) fail("INVALID_PATH", "options.cwd must be an absolute path", "options.cwd");
  const requested = Object.hasOwn(execution, "cwd") ? normalizeString(execution.cwd, "execution.cwd") : root;
  if (requested.includes("\0")) fail("INVALID_PATH", "execution.cwd contains NUL", "execution.cwd");
  const normalized = { cwd: path.resolve(root, requested), timeoutMs: execution.timeoutMs };
  if (Object.hasOwn(execution, "worktree")) {
    if (typeof execution.worktree !== "boolean") failTypeMismatch("execution.worktree", "boolean", execution.worktree);
    if (execution.worktree) normalized.worktree = true;
  }
  return normalized;
}

function normalizeModelTier(value) {
  if (value === undefined) return undefined;
  const normalized = normalizeString(value, "modelTier");
  if (!MODEL_TIERS.has(normalized)) fail("INVALID_CONTRACT", `modelTier is not supported: ${normalized}`, "modelTier");
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
  const source = validateObject(coerceContractFields(input), "$", TOP_LEVEL_KEYS, REQUIRED_TOP_LEVEL_KEYS);
  const version = normalizeString(source.version, "version");
  if (version !== CONTRACT_VERSION) fail("UNSUPPORTED_VERSION", `unsupported coding dispatch contract version: ${version}`, "version");
  const agent = normalizeString(source.agent, "agent");
  if (!AGENTS.has(agent)) fail("INVALID_AGENT", `unsupported coding dispatch agent: ${agent}`, "agent");
  const risk = normalizeString(source.risk, "risk");
  if (!RISKS.has(risk)) fail("INVALID_CONTRACT", `unsupported coding dispatch risk: ${risk}`, "risk");
  const taskId = normalizeString(source.taskId, "taskId", { maxBytes: 160 });
  if (!TASK_ID_PATTERN.test(taskId)) fail("INVALID_CONTRACT", "taskId must match ^[A-Za-z0-9._-]{1,160}$", "taskId");
  const modelTier = normalizeModelTier(source.modelTier);
  const canonical = {
    version,
    taskId,
    title: normalizeString(source.title, "title"),
    agent,
    ...(modelTier === undefined ? {} : { modelTier }),
    risk,
    objective: normalizeString(source.objective, "objective"),
    requirements: normalizeStringArray(source.requirements, "requirements", { minItems: 1 }),
    context: normalizeContext(source.context),
    boundaries: normalizeBoundaries(source.boundaries),
    workflow: normalizeWorkflow(source.workflow),
    acceptance: normalizeAcceptance(source.acceptance),
    execution: normalizeExecution(source.execution, cwd),
  };
  return deepFreeze({ ...canonical, hash: hashCanonical(canonical) });
}

export function splitDispatchEnvelope(ir) {
  if (!isPlainObject(ir) || !/^[a-f0-9]{64}$/.test(ir.hash ?? "")) {
    fail("INVALID_CONTRACT", "compiled dispatch IR with SHA-256 hash is required", "hash");
  }
  const { hash: contractHash, ...transportContract } = ir;
  return deepFreeze({ contract: deepFreeze(transportContract), contractHash });
}

function ordered(items) {
  return items.length === 0 ? "_None declared._" : items.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join("\n");
}

export function renderCodingDispatchPrompt(ir) {
  const workflowReason = ir.workflow.reason === undefined ? "" : `\n- Exemption reason: ${JSON.stringify(ir.workflow.reason)}`;
  const prompt = [
    "# Coding Dispatch Contract v1", "", "## Identity",
    `- Version: \`${ir.version}\``, `- Task ID: ${JSON.stringify(ir.taskId)}`, `- Title: ${JSON.stringify(ir.title)}`,
    `- Agent: \`${ir.agent}\``, ...(ir.modelTier === undefined ? [] : [`- Requested model tier override: \`${ir.modelTier}\``]),
    `- Risk: \`${ir.risk}\``, `- Working directory: ${JSON.stringify(ir.execution.cwd)}`, `- Timeout: \`${ir.execution.timeoutMs}ms\``,
    ...(ir.execution.worktree === true ? ["- Managed worktree: `true`"] : []), `- Contract SHA-256: \`${ir.hash}\``,
    "", "## Objective", JSON.stringify(ir.objective), "", "## Requirements", ordered(ir.requirements),
    "", "## Authoritative Known Facts", ordered(ir.context.knownFacts), "", "## Decisions Already Made", ordered(ir.context.decisions),
    "", "## Relevant Files", ordered(ir.context.relevantFiles), "", "## Declared Write Scope", ordered(ir.boundaries.writePaths), "",
    "Modify only the declared write paths. They are a contract and acceptance boundary, not an OS sandbox. Escalate before changing any other path.",
    "", "## Excluded Work", ordered(ir.boundaries.excludedWork), "", "## Forbidden Actions", ordered(ir.boundaries.forbiddenActions),
    "", "## Workflow", `- Mode: \`${ir.workflow.mode}\`${workflowReason}`, "- Follow the selected workflow exactly and preserve its evidence.",
    "", "## Acceptance Criteria", ordered(ir.acceptance.criteria), "", "## Escalation",
    "If required information or an unapproved decision is missing, use `contact_supervisor` when available and return `NEEDS_CONTEXT`. Do not substitute broad exploration for missing context or revisit decisions already recorded above.",
    "", "## Required Report", "Return a compact final report containing:", "1. status (`completed` or `NEEDS_CONTEXT`)",
    "2. files changed", "3. RED/GREEN or exemption evidence", "4. commands and results", "5. residual risks",
  ].join("\n");
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_PROMPT_BYTES) throw new CodingDispatchContractError("PROMPT_TOO_LARGE", `coding dispatch prompt exceeds ${MAX_PROMPT_BYTES} bytes`, String(bytes));
  return prompt;
}

// Kept as the Goal codec's historical export name while callers migrate.
export const renderDispatchPrompt = renderCodingDispatchPrompt;
