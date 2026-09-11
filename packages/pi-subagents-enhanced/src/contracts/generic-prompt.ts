import { createHash } from "node:crypto";

const PROMPT_KEYS = ["task", "context", "constraints", "deliverable", "done"] as const;
const MAX_ARRAY_ITEMS = 32;
const MAX_STRING_BYTES = 4 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;

export interface GenericPromptContract {
  task: string;
  context: readonly string[];
  constraints: readonly string[];
  deliverable: string;
  done: readonly [string, ...string[]];
}

export interface CompiledGenericPrompt extends GenericPromptContract {
  hash: string;
}

export class GenericPromptContractError extends Error {
  code: string;
  detail: string;
  keypath?: string;

  constructor(code, message, detail = message, keypath?: string) {
    super(message);
    this.name = "GenericPromptContractError";
    this.code = code;
    this.detail = String(detail);
    if (keypath !== undefined) this.keypath = String(keypath);
  }
}

function fail(message, keypath) {
  throw new GenericPromptContractError("INVALID_GENERIC_PROMPT", `${message}; keypath=${keypath}`, keypath, keypath);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeString(value, keypath) {
  if (typeof value !== "string") fail(`${keypath} must be a string`, keypath);
  const normalized = value.trim();
  if (!normalized) fail(`${keypath} must not be empty`, keypath);
  if (Buffer.byteLength(normalized, "utf8") > MAX_STRING_BYTES) fail(`${keypath} exceeds ${MAX_STRING_BYTES} bytes`, keypath);
  return normalized;
}

function normalizeArray(value, keypath, minItems = 0) {
  if (!Array.isArray(value)) fail(`${keypath} must be an array`, keypath);
  if (value.length > MAX_ARRAY_ITEMS) fail(`${keypath} must contain at most ${MAX_ARRAY_ITEMS} items`, keypath);
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entry = normalizeString(value[index], `${keypath}[${index}]`);
    if (!seen.has(entry)) {
      seen.add(entry);
      normalized.push(entry);
    }
  }
  if (normalized.length < minItems) fail(`${keypath} must contain at least ${minItems} item(s)`, keypath);
  return normalized;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function compileGenericPrompt(input): CompiledGenericPrompt {
  if (!isPlainObject(input)) fail("generic prompt must be an object", "$");
  const allowed = new Set(PROMPT_KEYS);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key as typeof PROMPT_KEYS[number])) fail(`generic prompt contains unknown field ${key}`, key);
  }
  for (const key of PROMPT_KEYS) {
    if (!Object.hasOwn(input, key)) fail(`generic prompt is missing required field ${key}`, key);
  }
  const canonical = {
    task: normalizeString(input.task, "task"),
    context: normalizeArray(input.context, "context"),
    constraints: normalizeArray(input.constraints, "constraints"),
    deliverable: normalizeString(input.deliverable, "deliverable"),
    done: normalizeArray(input.done, "done", 1),
  };
  return deepFreeze({ ...canonical, hash: canonicalHash(canonical) }) as CompiledGenericPrompt;
}

function ordered(items) {
  return items.length === 0 ? "_None declared._" : items.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join("\n");
}

export function renderGenericPrompt(prompt: CompiledGenericPrompt) {
  const rendered = [
    "# Generic Subagent Prompt", "", "## Task", JSON.stringify(prompt.task),
    "", "## Context", ordered(prompt.context),
    "", "## Constraints", ordered(prompt.constraints),
    "", "## Deliverable", JSON.stringify(prompt.deliverable),
    "", "## Done", ordered(prompt.done),
  ].join("\n");
  const bytes = Buffer.byteLength(rendered, "utf8");
  if (bytes > MAX_PROMPT_BYTES) {
    throw new GenericPromptContractError("PROMPT_TOO_LARGE", `generic prompt exceeds ${MAX_PROMPT_BYTES} bytes`, String(bytes));
  }
  return rendered;
}
