import { createHash } from "node:crypto";
import path from "node:path";

const MAX_ARRAY_ITEMS = 32;
const MAX_STRING_BYTES = 4 * 1024;
// task 是任务正文（文档级载荷），不得与 agent/title 等标识符共用 4 KiB 上界；
// pi/AGENTS.md 要求派发时必须携带完整信息。超限仍 fail-closed 拒绝。
// 见 docs/bugs/2026-09-30-dispatch-task-4k-limit.md。
export const MAX_TASK_BYTES = 32 * 1024;
// title 是展示字段，title-registry 只接受单行、非空、≤256 字节（合同以该模块为准）。
// 缺省回退若直接切片 task，多行任务会带换行，导致整次派发被 INVALID_TITLE 拒绝。
// 见 docs/bugs/2026-10-27-goal-dispatch-multiline-title.md。
const MAX_TITLE_BYTES = 256;
const FALLBACK_TITLE_CODEPOINTS = 50;
const DEFAULT_TITLE = "subagent dispatch";
// task 经 JSON.stringify 渲染进 prompt 会因转义膨胀，需为最大合法 task 留余量，
// 避免出现「task 通过校验却被 PROMPT_TOO_LARGE 拒绝」的不一致失败。
const MAX_PROMPT_BYTES = 128 * 1024;
const PUBLIC_KEYS = new Set(["agent", "task", "title", "model", "writePaths", "acceptance", "worktree", "cwd",
  // generic-only spawn parameters (only valid without writePaths)
  "context", "output", "outputMode", "outputSchema", "artifacts", "progress", "skill", "reads", "thinkingLevel",
]);

export class CodingDispatchContractError extends Error {
  code: string;
  detail: string;
  keypath?: string;
  constructor(code, message, detail = message, keypath?: string) {
    super(message); this.name = "CodingDispatchContractError"; this.code = code; this.detail = String(detail);
    if (keypath !== undefined) this.keypath = keypath;
  }
}

export const DEPRECATED_SCHEMA = Object.freeze({
  code: "DEPRECATED_SCHEMA",
  message: "This input uses dispatch-ir.v1. Migration: remove version/taskId/risk; merge requirements+context into task; move boundaries.writePaths to writePaths; move acceptance to acceptance; move execution.worktree/cwd to top-level; do not provide timeoutMs.",
  keypath: "version",
});

function fail(code, message, keypath?: string): never { throw new CodingDispatchContractError(code, `${message}${keypath ? `; keypath=${keypath}` : ""}`, keypath, keypath); }
function typeOf(value) { return value === null ? "null" : Array.isArray(value) ? "array" : typeof value; }
function plain(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const p = Object.getPrototypeOf(value); return p === Object.prototype || p === null; }
function json(value, key) {
  if (typeof value !== "string") return value;
  const text = value.trim(); if (!text.startsWith("{") && !text.startsWith("[")) return value;
  try { return JSON.parse(text); } catch { fail("INVALID_CONTRACT", `${key} contains malformed JSON string`, key); }
}
function string(value, key, maxBytes = MAX_STRING_BYTES) {
  if (typeof value !== "string") fail("INVALID_CONTRACT", `${key} must be a string; received ${typeOf(value)}`, key);
  const result = value.trim(); if (!result) fail("INVALID_CONTRACT", `${key} must not be empty`, key);
  if (Buffer.byteLength(result) > maxBytes) fail("INVALID_CONTRACT", `${key} exceeds ${maxBytes} bytes`, key);
  return result;
}
/** 折叠控制符与换行为空格并压缩空白；title 必须是单行文本。 */
function singleLine(value) { return value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim(); }
/** 按 UTF-8 字节截断且不切断码点，避免超出 title-registry 的字节上界。 */
function truncateBytes(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0, kept = "";
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size; kept += char;
  }
  return kept.trim();
}
/** 缺省回退：单行化 task 首段；极端全空白/全控制符输入退到 agent，再退到固定文案以保证非空。 */
function fallbackTitle(agent, task) {
  return truncateBytes(singleLine(task).slice(0, FALLBACK_TITLE_CODEPOINTS), MAX_TITLE_BYTES)
    || truncateBytes(singleLine(agent).slice(0, FALLBACK_TITLE_CODEPOINTS), MAX_TITLE_BYTES)
    || DEFAULT_TITLE;
}
function strings(value, key, min = 0, item = string) {
  if (!Array.isArray(value)) fail("INVALID_CONTRACT", `${key} must be an array`, key);
  if (value.length > MAX_ARRAY_ITEMS) fail("INVALID_CONTRACT", `${key} must contain at most ${MAX_ARRAY_ITEMS} items`, key);
  const out = [], seen = new Set();
  value.forEach((v, i) => { const x = item(v, `${key}[${i}]`); if (!seen.has(x)) { seen.add(x); out.push(x); } });
  if (out.length < min) fail("INVALID_CONTRACT", `${key} must contain at least ${min} item(s)`, key);
  return out;
}

// 合法文法：精确路径，或末尾带单个 /** 的递归目录范围。仅改错误分类，不放宽合法输入。
export const PATH_EXAMPLE = 'e.g. "src/a.ts" or "src/**"';
function normalizeRepoRelativePath(value, location) {
  const normalized = string(value, location); const echoed = JSON.stringify(normalized);
  if (normalized === "/**") fail("INVALID_PATH", `${location} must not be "/**"`, location);
  if (normalized.includes("\0")) fail("INVALID_PATH", `${location} must not contain NUL`, location);
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\")) fail("INVALID_PATH", `${location} must be repo-relative; got ${echoed}`, location);
  if (normalized.includes("\\")) fail("INVALID_PATH", `${location} must use POSIX separators`, location);
  const recursive = normalized.endsWith("/**"), base = recursive ? normalized.slice(0, -3) : normalized;
  if (base.endsWith("/") || /[*?[\]]/.test(base)) fail("INVALID_PATH", `${location} contains unsupported glob/path`, location);
  const segments = base.split("/"), unsafe = segments.find((s) => !s || s === "." || s === "..");
  if (unsafe !== undefined) fail("INVALID_PATH", `${location} contains unsafe path segment`, location);
  return recursive ? `${segments.join("/")}/**` : segments.join("/");
}

function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])); }
function hash(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }

export function isCodingDispatch(input) { return plain(input) && Object.hasOwn(input, "writePaths"); }

export function compileDispatchIR(input, options: { cwd?: string; timeoutMs?: number } = {}) {
  if (!plain(input)) fail("INVALID_CONTRACT", "input must be an object", "$ ");
  if (Object.hasOwn(input, "version")) throw new CodingDispatchContractError(DEPRECATED_SCHEMA.code, DEPRECATED_SCHEMA.message, DEPRECATED_SCHEMA.message, DEPRECATED_SCHEMA.keypath);
  const source = { ...input };
  for (const key of Object.keys(source)) if (!PUBLIC_KEYS.has(key)) fail("INVALID_CONTRACT", `unknown field ${key}`, key);
  const coding = isCodingDispatch(source);
  if (!coding && Object.hasOwn(source, "acceptance")) fail("CODING_FIELD_WITHOUT_WRITE_PATHS", "acceptance requires writePaths to make this a coding dispatch", "acceptance");
  if (Object.hasOwn(source, "timeoutMs")) fail("INVALID_CONTRACT", "timeoutMs is host-injected and must not be provided", "timeoutMs");
  const agent = string(source.agent, "agent"), task = string(source.task, "task", MAX_TASK_BYTES), title = source.title === undefined ? fallbackTitle(agent, task) : string(source.title, "title");
  const model = source.model === undefined ? undefined : string(source.model, "model", 512);
  const base = { agent, task, title, ...(model === undefined ? {} : { model }) };
  let value: any = { kind: coding ? "coding" : "generic", ...base };
  if (coding) {
    const writePaths = strings(json(source.writePaths, "writePaths"), "writePaths", 1, normalizeRepoRelativePath);
    const acceptance = json(source.acceptance, "acceptance");
    if (!plain(acceptance)) fail("INVALID_CONTRACT", "acceptance must be an object", "acceptance");
    const criteria = strings(acceptance.criteria, "acceptance.criteria", 1);
    const worktree = source.worktree === undefined ? undefined : source.worktree;
    if (worktree !== undefined && typeof worktree !== "boolean") fail("INVALID_CONTRACT", "worktree must be a boolean", "worktree");
    const cwd = source.cwd === undefined ? path.resolve(options.cwd ?? process.cwd()) : string(source.cwd, "cwd");
    if (!path.isAbsolute(cwd) || cwd.includes("\0")) fail("INVALID_PATH", "cwd must be an absolute path", "cwd");
    value = { ...value, writePaths, acceptance: { criteria }, ...(worktree ? { worktree: true } : {}), cwd, timeoutMs: options.timeoutMs ?? 30 * 60_000 };
  }
  const contract = { agent, task, title, ...(model === undefined ? {} : { model }), ...(coding ? { writePaths: value.writePaths, acceptance: value.acceptance, ...(value.worktree ? { worktree: true } : {}), cwd: value.cwd } : {}) };
  const contractHash = hash(contract);
  return freeze({ ...value, contractHash, taskId: `dispatch-${contractHash.slice(0, 8)}` });
}

export function renderDispatchPrompt(ir) {
  const sections = ["# Dispatch Contract", "", "## Identity", `- Agent: ${JSON.stringify(ir.agent)}`, `- Task ID: ${ir.taskId}`, `- Contract SHA-256: ${ir.contractHash}`, "", "## Task", JSON.stringify(ir.task)];
  if (ir.kind === "coding") sections.push("", "## Write Scope", ...ir.writePaths.map(p => `- ${JSON.stringify(p)}`), "", "## Acceptance Criteria", ...ir.acceptance.criteria.map(c => `- ${JSON.stringify(c)}`));
  sections.push("", "## Escalation", "If required information is missing, escalate before proceeding.");
  const prompt = sections.join("\n"); if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) fail("PROMPT_TOO_LARGE", "dispatch prompt exceeds size limit"); return prompt;
}

// Compatibility exports retained for downstream callers during migration.
export const renderCodingDispatchPrompt = renderDispatchPrompt;
export function compileCodingDispatchIR(input, options = {}) { return compileDispatchIR(input, options); }
export function splitDispatchEnvelope(ir) { return freeze({ contract: freeze({ ...ir }), contractHash: ir.contractHash ?? ir.hash }); }
export function projectCodingPrompt(ir) { return freeze({ task: ir.task ?? ir.objective, deliverable: ir.title, done: ir.acceptance?.criteria ?? [] }); }
