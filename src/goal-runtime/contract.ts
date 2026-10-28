/**
 * Goal Runtime v1：计划内契约的冻结类型、严格解码、唯一区块读取与语义 hash。
 *
 * 权威来源：`docs/plans/2026-10-26-goal-runtime-v1.md` §4.1。
 * 本模块只做「文件 → 纯结构」的确定性工作：读取计划 Markdown 中唯一的契约区块、
 * JSON 解码、跨引用与 DAG 校验、canonical JSON + SHA-256。它不读业务状态、
 * 不产生副作用、不扫描整篇正文猜测条件，也不从模型输出补全缺失字段。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExtensionToolContext, FileEntry } from "@earendil-works/pi-coding-agent";

/* ------------------------------------------------------------------ */
/* 冻结类型（§4.1，名称与字段形状不可由下游重新定义）                   */
/* ------------------------------------------------------------------ */

/** 一条可机械执行的终态/任务级检查；命令由契约固定，调用方不得覆盖。 */
export type GoalCheck = {
  id: string;
  statement: string;
  command: { executable: string; args: string[]; timeoutSeconds: number };
  repairTaskIds: string[];
};

/** 一个 coding 任务；`task` 保存完整任务正文，不接受只写任务编号。 */
export type GoalTask = {
  id: string;
  agent: string;
  task: string;
  deps: string[];
  writePaths: string[];
  resources: string[];
  acceptance: { criteria: string[] };
  checkIds: string[];
};

/** 计划契约（机器执行权威）；`schema` 为唯一合法版本字面量。 */
export type PlanContract = {
  schema: "goal-runtime.plan.v1";
  objective: string;
  constraints: string[];
  resources: Array<{ id: string; capacity: number }>;
  checks: GoalCheck[];
  tasks: GoalTask[];
  terminalCheckIds: string[];
};

/** 计划与真实 Host session 的绑定；`sessionFile` 只能由 Host 提供。 */
export type PlanBinding = {
  planPath: string;
  contractHash: string;
  repositoryRoot: string;
  sessionId: string;
  sessionFile: string;
};

/** 候选版本标识：HEAD、Git 可见路径集合与内容摘要的统一 hash。 */
export type RepositorySubject = {
  repositoryRoot: string;
  head: string;
  contentHash: string;
};

/** 多仓库仅聚合固定参与集合；成员按 repoId 排序，旧单仓库无封套。 */
export type GoalSubject = RepositorySubject | {
  kind: "multi-repository";
  repositories: Array<RepositorySubject & { repoId: string }>;
};

/** 结构化交接记录；不用于设置任务通过的资格。 */
export type GoalCheckpoint = {
  taskId?: string;
  decisions: string[];
  sourceRefs: string[];
  nextAction: string;
};

/** 单条检查回执；只有真实执行结果才能形成。 */
export type CheckReceipt = {
  checkId: string;
  contractHash: string;
  subject: GoalSubject;
  command: GoalCheck["command"];
  outcome: "passed" | "failed" | "stale" | "blocked";
  exitCode: number | null;
  toolCallId: string;
  resultRef: string;
  outputHash: string;
};

/** 单任务状态；不扩展第二套生命周期枚举。 */
export type TaskState = {
  status: "pending" | "running" | "verifying" | "accepted" | "blocked";
  attempt: number;
  dispatchKey: string | null;
  workspaceId: string | null;
  run: { runId: string; workspaceId: string; rootSessionId: string } | null;
  terminalProofRef: string | null;
  integrationReceiptRef: string | null;
  blocker: string | null;
};

/** 业务状态快照（session custom entry 内容）。 */
export type GoalState = {
  planId: string;
  revision: number;
  binding: PlanBinding;
  contract: PlanContract;
  status: "active" | "paused" | "blocked" | "completed" | "cancelled";
  tasks: Record<string, TaskState>;
  receipts: CheckReceipt[];
  checkpoint: GoalCheckpoint;
  pauseReason: string | null;
  lastProgressHash: string;
  noProgressTurns: number;
};

/** 一批检查的原始证据；由 T5 生成、经注入的 writer 落到 session custom entry。 */
export type GoalCheckEvidence = {
  evidenceId: string;
  sessionId: string;
  contractHash: string;
  subjectBefore: GoalSubject;
  subjectAfter: GoalSubject;
  results: Array<{
    checkId: string;
    command: GoalCheck["command"];
    toolOutcome: Awaited<ReturnType<ExtensionToolContext["executeTool"]>> | null;
    blockedReason: string | null;
  }>;
};

/** 只读读取同一 session JSONL 的解码入口；不提供写入能力。 */
export type GoalSessionDiskReader = (
  sessionFile: string,
) => Promise<readonly FileEntry[]>;

/** 证据写入器；返回真实 entry ID，写入未确认时不得提交通过状态。 */
export type EvidenceWriter = (
  evidence: GoalCheckEvidence,
) => Promise<{ entryId: string }>;

/** 候选版本捕获；只在验证批次与完成判定时运行。 */
export type CaptureSubject = (repositoryRoot: string) => Promise<RepositorySubject>;

/** 检查批次执行入口；`writeEvidence` 由 Host 注入，T5 不依赖 T2 实现。 */
export type VerifyChecks = (input: {
  contract: PlanContract;
  binding: PlanBinding;
  checkIds: string[];
  toolCallId: string;
  ctx: ExtensionToolContext;
  writeEvidence: EvidenceWriter;
}) => Promise<CheckReceipt[]>;

/* ------------------------------------------------------------------ */
/* 公开常量                                                            */
/* ------------------------------------------------------------------ */

/** 唯一合法 schema 字面量；未知版本一律拒绝，不做跨版本兼容推断。 */
export const PLAN_CONTRACT_SCHEMA = "goal-runtime.plan.v1";

/** 契约区块开始标记；计划文件内必须恰好出现一次。 */
export const PLAN_CONTRACT_START_MARKER = "<!-- goal-runtime-contract:start -->";

/** 契约区块结束标记；计划文件内必须恰好出现一次且在开始标记之后。 */
export const PLAN_CONTRACT_END_MARKER = "<!-- goal-runtime-contract:end -->";

/* ------------------------------------------------------------------ */
/* 拒绝诊断                                                            */
/* ------------------------------------------------------------------ */

/** 解码失败的精确分类；下游按 code 判定，不匹配错误文案。 */
export type PlanContractErrorCode =
  | "INVALID_CONTRACT"
  | "INVALID_VALUE"
  | "UNKNOWN_FIELD"
  | "UNKNOWN_SCHEMA"
  | "DUPLICATE_ID"
  | "DUPLICATE_REFERENCE"
  | "DUPLICATE_PATH"
  | "UNKNOWN_TASK_REF"
  | "UNKNOWN_CHECK_REF"
  | "UNKNOWN_RESOURCE_REF"
  | "MISSING_REPAIR_OWNER"
  | "EMPTY_REPAIR_OWNERS"
  | "SELF_DEPENDENCY"
  | "DEPENDENCY_CYCLE"
  | "EMPTY_TERMINAL_CHECKS"
  | "ORPHAN_CHECK"
  | "INVALID_PATH"
  | "INVALID_CAPACITY"
  | "INVALID_COMMAND"
  | "MISSING_CONTRACT_BLOCK"
  | "DUPLICATE_CONTRACT_BLOCK"
  | "INVALID_CONTRACT_BLOCK"
  | "INVALID_JSON"
  | "PLAN_TOO_LARGE"
  | "UNREADABLE_PLAN";

/** 契约错误：带稳定 code、出错位置 keypath 与可追踪 detail。 */
export class PlanContractError extends Error {
  readonly code: PlanContractErrorCode;
  readonly keypath: string;
  readonly detail: string;

  constructor(code: PlanContractErrorCode, message: string, keypath: string, detail = message) {
    super(keypath ? `${message}（位置：${keypath}）` : message);
    this.name = "PlanContractError";
    this.code = code;
    this.keypath = keypath;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ */
/* 上限（超限一律拒绝，不静默截断）                                     */
/* ------------------------------------------------------------------ */

const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_OBJECTIVE_BYTES = 8 * 1024;
const MAX_CONSTRAINT_BYTES = 4 * 1024;
// 与 packages/pi-subagents-enhanced 的 dispatch-ir.v2 `MAX_TASK_BYTES` 保持同一上界。
const MAX_TASK_BYTES = 32 * 1024;
const MAX_STRING_BYTES = 4 * 1024;
const MAX_EXECUTABLE_BYTES = 1024;
const MAX_AGENT_BYTES = 256;
const MAX_ID_BYTES = 128;
const MAX_LIST_ITEMS = 64;
const MAX_ARGS = 64;
const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_CAPACITY = 1_000_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

const CONTRACT_KEYS = [
  "schema",
  "objective",
  "constraints",
  "resources",
  "checks",
  "tasks",
  "terminalCheckIds",
] as const;
const RESOURCE_KEYS = ["id", "capacity"] as const;
const CHECK_KEYS = ["id", "statement", "command", "repairTaskIds"] as const;
const COMMAND_KEYS = ["executable", "args", "timeoutSeconds"] as const;
const TASK_KEYS = [
  "id",
  "agent",
  "task",
  "deps",
  "writePaths",
  "resources",
  "acceptance",
  "checkIds",
] as const;
const ACCEPTANCE_KEYS = ["criteria"] as const;

/* ------------------------------------------------------------------ */
/* 基础校验工具                                                        */
/* ------------------------------------------------------------------ */

type PlainObject = Record<string, unknown>;

function fail(code: PlanContractErrorCode, message: string, keypath: string): never {
  throw new PlanContractError(code, message, keypath);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function plainObject(value: unknown, keypath: string): PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_CONTRACT", `${keypath} 必须是对象，实际为 ${typeOf(value)}`, keypath);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INVALID_CONTRACT", `${keypath} 必须是纯 JSON 对象`, keypath);
  }
  return value as PlainObject;
}

/** 字段集合精确匹配：未知字段与缺少字段都在产生副作用前拒绝。 */
function exactKeys(value: PlainObject, allowed: readonly string[], keypath: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail("UNKNOWN_FIELD", `未知字段 ${key}`, `${keypath}.${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) fail("INVALID_CONTRACT", `缺少必需字段 ${key}`, `${keypath}.${key}`);
  }
}

function noControl(value: string, keypath: string): string {
  if (CONTROL_PATTERN.test(value)) fail("INVALID_VALUE", `${keypath} 不得包含控制字符`, keypath);
  return value;
}

/** 人类可读文本：去除首尾空白后必须非空。 */
function text(value: unknown, keypath: string, maxBytes: number): string {
  if (typeof value !== "string") {
    fail("INVALID_CONTRACT", `${keypath} 必须是字符串，实际为 ${typeOf(value)}`, keypath);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) fail("INVALID_CONTRACT", `${keypath} 不得为空`, keypath);
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    fail("INVALID_CONTRACT", `${keypath} 超过 ${maxBytes} 字节上限`, keypath);
  }
  return trimmed;
}

/** 机械字符串（如命令参数）：保留原始内容，只做类型/上限/控制字符校验。 */
function rawString(value: unknown, keypath: string, maxBytes: number): string {
  if (typeof value !== "string") {
    fail("INVALID_CONTRACT", `${keypath} 必须是字符串，实际为 ${typeOf(value)}`, keypath);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("INVALID_CONTRACT", `${keypath} 超过 ${maxBytes} 字节上限`, keypath);
  }
  return noControl(value, keypath);
}

function list(value: unknown, keypath: string, maxItems = MAX_LIST_ITEMS): unknown[] {
  if (!Array.isArray(value)) {
    fail("INVALID_CONTRACT", `${keypath} 必须是数组，实际为 ${typeOf(value)}`, keypath);
  }
  if (value.length > maxItems) {
    fail("INVALID_CONTRACT", `${keypath} 最多 ${maxItems} 项，实际 ${value.length} 项`, keypath);
  }
  return value;
}

type StringListOptions = {
  min?: number;
  maxItems?: number;
  maxBytes?: number;
  unique?: boolean;
  uniqueCode?: PlanContractErrorCode;
  pattern?: RegExp;
  minCode?: PlanContractErrorCode;
  item?: (value: unknown, keypath: string) => string;
};

function stringList(value: unknown, keypath: string, options: StringListOptions = {}): string[] {
  const items = list(value, keypath, options.maxItems ?? MAX_LIST_ITEMS);
  const unique = options.unique !== false;
  const seen = new Set<string>();
  const out: string[] = [];
  items.forEach((item, index) => {
    const itemKeypath = `${keypath}[${index}]`;
    const parsed = options.item
      ? options.item(item, itemKeypath)
      : text(item, itemKeypath, options.maxBytes ?? MAX_STRING_BYTES);
    if (options.pattern && !options.pattern.test(parsed)) {
      fail("INVALID_VALUE", `${itemKeypath} 不符合允许的 ID 形式：${parsed}`, itemKeypath);
    }
    if (unique) {
      if (seen.has(parsed)) {
        fail(options.uniqueCode ?? "DUPLICATE_REFERENCE", `${itemKeypath} 与前面的项重复：${parsed}`, itemKeypath);
      }
      seen.add(parsed);
    }
    out.push(parsed);
  });
  const min = options.min ?? 0;
  if (out.length < min) {
    fail(options.minCode ?? "INVALID_CONTRACT", `${keypath} 至少需要 ${min} 项，实际 ${out.length} 项`, keypath);
  }
  return out;
}

function idText(value: unknown, keypath: string): string {
  const id = noControl(text(value, keypath, MAX_ID_BYTES), keypath);
  if (!ID_PATTERN.test(id)) fail("INVALID_VALUE", `${keypath} 不符合允许的 ID 形式：${id}`, keypath);
  return id;
}

function assertUniqueIds(ids: readonly string[], keypathBase: string): void {
  const firstIndex = new Map<string, number>();
  ids.forEach((id, index) => {
    const seenAt = firstIndex.get(id);
    if (seenAt !== undefined) {
      fail("DUPLICATE_ID", `${keypathBase}[${index}].id 与 ${keypathBase}[${seenAt}].id 重复：${id}`, `${keypathBase}[${index}].id`);
    }
    firstIndex.set(id, index);
  });
}

/**
 * writePaths 文法与 dispatch-ir.v2 一致：仓库相对 POSIX 路径，
 * 或末尾带单个 `/**` 的递归目录范围；不允许 glob、绝对路径、`..` 段与反斜杠。
 */
function writePath(value: unknown, keypath: string): string {
  const normalized = noControl(text(value, keypath, MAX_STRING_BYTES), keypath);
  if (normalized === "/**") fail("INVALID_PATH", `${keypath} 不得为 "/**"`, keypath);
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\")) {
    fail("INVALID_PATH", `${keypath} 必须是仓库相对路径：${normalized}`, keypath);
  }
  if (normalized.includes("\\")) fail("INVALID_PATH", `${keypath} 必须使用 POSIX 分隔符`, keypath);
  const recursive = normalized.endsWith("/**");
  const base = recursive ? normalized.slice(0, -3) : normalized;
  if (base.endsWith("/") || /[*?[\]]/.test(base)) {
    fail("INVALID_PATH", `${keypath} 含不支持的 glob 或路径形式：${normalized}`, keypath);
  }
  const segments = base.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("INVALID_PATH", `${keypath} 含不安全路径段：${normalized}`, keypath);
  }
  return recursive ? `${segments.join("/")}/**` : segments.join("/");
}

/* ------------------------------------------------------------------ */
/* 结构解码                                                            */
/* ------------------------------------------------------------------ */

function parseResource(value: unknown, keypath: string): PlanContract["resources"][number] {
  const record = plainObject(value, keypath);
  exactKeys(record, RESOURCE_KEYS, keypath);
  const id = idText(record.id, `${keypath}.id`);
  const capacity = record.capacity;
  if (typeof capacity !== "number" || !Number.isInteger(capacity)) {
    fail("INVALID_CAPACITY", `${keypath}.capacity 必须是整数，实际为 ${JSON.stringify(capacity)}`, `${keypath}.capacity`);
  }
  if (capacity < 0) fail("INVALID_CAPACITY", `${keypath}.capacity 不得为负：${capacity}`, `${keypath}.capacity`);
  if (capacity > MAX_CAPACITY) {
    fail("INVALID_CAPACITY", `${keypath}.capacity 超过上限 ${MAX_CAPACITY}：${capacity}`, `${keypath}.capacity`);
  }
  return { id, capacity };
}

function parseCommand(value: unknown, keypath: string): GoalCheck["command"] {
  const record = plainObject(value, keypath);
  exactKeys(record, COMMAND_KEYS, keypath);
  const executable = noControl(text(record.executable, `${keypath}.executable`, MAX_EXECUTABLE_BYTES), `${keypath}.executable`);
  const args = list(record.args, `${keypath}.args`, MAX_ARGS).map((arg, index) =>
    rawString(arg, `${keypath}.args[${index}]`, MAX_STRING_BYTES),
  );
  const timeoutSeconds = record.timeoutSeconds;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    fail(
      "INVALID_COMMAND",
      `${keypath}.timeoutSeconds 必须是 1..${MAX_TIMEOUT_SECONDS} 的整数，实际为 ${JSON.stringify(timeoutSeconds)}`,
      `${keypath}.timeoutSeconds`,
    );
  }
  return { executable, args, timeoutSeconds };
}

function parseCheck(value: unknown, keypath: string): GoalCheck {
  const record = plainObject(value, keypath);
  exactKeys(record, CHECK_KEYS, keypath);
  return {
    id: idText(record.id, `${keypath}.id`),
    statement: text(record.statement, `${keypath}.statement`, MAX_STRING_BYTES),
    command: parseCommand(record.command, `${keypath}.command`),
    // 空修复归属在 §4.1 明确拒绝：必要条件必须至少有一个可达的修复入口。
    repairTaskIds: stringList(record.repairTaskIds, `${keypath}.repairTaskIds`, {
      min: 1,
      minCode: "EMPTY_REPAIR_OWNERS",
      pattern: ID_PATTERN,
    }),
  };
}

function parseTask(value: unknown, keypath: string): GoalTask {
  const record = plainObject(value, keypath);
  exactKeys(record, TASK_KEYS, keypath);
  const acceptancePath = `${keypath}.acceptance`;
  const acceptance = plainObject(record.acceptance, acceptancePath);
  exactKeys(acceptance, ACCEPTANCE_KEYS, acceptancePath);
  return {
    id: idText(record.id, `${keypath}.id`),
    agent: noControl(text(record.agent, `${keypath}.agent`, MAX_AGENT_BYTES), `${keypath}.agent`),
    task: text(record.task, `${keypath}.task`, MAX_TASK_BYTES),
    deps: stringList(record.deps, `${keypath}.deps`, { pattern: ID_PATTERN }),
    writePaths: stringList(record.writePaths, `${keypath}.writePaths`, {
      min: 1,
      uniqueCode: "DUPLICATE_PATH",
      item: writePath,
    }),
    resources: stringList(record.resources, `${keypath}.resources`, { pattern: ID_PATTERN }),
    acceptance: {
      criteria: stringList(acceptance.criteria, `${acceptancePath}.criteria`, { min: 1, unique: false }),
    },
    checkIds: stringList(record.checkIds, `${keypath}.checkIds`, { pattern: ID_PATTERN }),
  };
}

/* ------------------------------------------------------------------ */
/* 跨引用与 DAG 校验                                                   */
/* ------------------------------------------------------------------ */

function assertAcyclic(tasks: readonly GoalTask[], keypathById: ReadonlyMap<string, string>): void {
  const depsById = new Map(tasks.map((task) => [task.id, task.deps]));
  const state = new Map<string, "visiting" | "settled">();
  const stack: string[] = [];
  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === "settled") return;
    if (current === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(" → ");
      fail("DEPENDENCY_CYCLE", `任务依赖存在环：${cycle}`, keypathById.get(id) ?? id);
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of depsById.get(id) ?? []) visit(dep);
    stack.pop();
    state.set(id, "settled");
  };
  for (const task of tasks) visit(task.id);
}

/* ------------------------------------------------------------------ */
/* 公开解码入口                                                        */
/* ------------------------------------------------------------------ */

/**
 * 严格解码一个计划契约。只接受 §4.1 的精确字段集合与 schema 版本；
 * 结构、跨引用、DAG、终态与修复归属任一不成立即在返回前抛错。
 */
export function decodePlanContract(value: unknown): PlanContract {
  const root = plainObject(value, "$");
  exactKeys(root, CONTRACT_KEYS, "$");

  const schema = text(root.schema, "$.schema", MAX_ID_BYTES);
  if (schema !== PLAN_CONTRACT_SCHEMA) {
    fail("UNKNOWN_SCHEMA", `不支持的契约版本 ${JSON.stringify(schema)}，仅接受 ${PLAN_CONTRACT_SCHEMA}`, "$.schema");
  }
  const objective = text(root.objective, "$.objective", MAX_OBJECTIVE_BYTES);
  const constraints = stringList(root.constraints, "$.constraints", {
    maxBytes: MAX_CONSTRAINT_BYTES,
    unique: false,
  });

  const resources = list(root.resources, "$.resources").map((item, index) =>
    parseResource(item, `$.resources[${index}]`),
  );
  const checks = list(root.checks, "$.checks").map((item, index) => parseCheck(item, `$.checks[${index}]`));
  const tasks = list(root.tasks, "$.tasks").map((item, index) => parseTask(item, `$.tasks[${index}]`));
  const terminalCheckIds = stringList(root.terminalCheckIds, "$.terminalCheckIds", { pattern: ID_PATTERN });

  if (tasks.length === 0) fail("INVALID_CONTRACT", "$.tasks 不得为空", "$.tasks");
  if (terminalCheckIds.length === 0) {
    fail(
      "EMPTY_TERMINAL_CHECKS",
      "$.terminalCheckIds 不得为空：每个终态必要条件都必须有实际 check 与修复归属",
      "$.terminalCheckIds",
    );
  }

  assertUniqueIds(resources.map((resource) => resource.id), "$.resources");
  assertUniqueIds(checks.map((check) => check.id), "$.checks");
  assertUniqueIds(tasks.map((task) => task.id), "$.tasks");

  const resourceIds = new Set(resources.map((resource) => resource.id));
  const checkIds = new Set(checks.map((check) => check.id));
  const taskIds = new Set(tasks.map((task) => task.id));
  const keypathById = new Map(tasks.map((task, index) => [task.id, `$.tasks[${index}]`]));
  const checkById = new Map(checks.map((check, index) => [check.id, { check, index }]));

  // 检查的修复归属必须落在契约内任务上。
  checks.forEach((check, checkIndex) => {
    check.repairTaskIds.forEach((taskId, refIndex) => {
      if (!taskIds.has(taskId)) {
        fail(
          "UNKNOWN_TASK_REF",
          `$.checks[${checkIndex}].repairTaskIds[${refIndex}] 引用了未定义任务 ${taskId}`,
          `$.checks[${checkIndex}].repairTaskIds[${refIndex}]`,
        );
      }
    });
  });

  tasks.forEach((task, taskIndex) => {
    const taskPath = `$.tasks[${taskIndex}]`;
    task.deps.forEach((dep, refIndex) => {
      if (!taskIds.has(dep)) {
        fail("UNKNOWN_TASK_REF", `${taskPath}.deps[${refIndex}] 引用了未定义任务 ${dep}`, `${taskPath}.deps[${refIndex}]`);
      }
      if (dep === task.id) {
        fail("SELF_DEPENDENCY", `${taskPath}.deps[${refIndex}] 不得依赖任务自身 ${dep}`, `${taskPath}.deps[${refIndex}]`);
      }
    });
    task.resources.forEach((resourceId, refIndex) => {
      if (!resourceIds.has(resourceId)) {
        fail(
          "UNKNOWN_RESOURCE_REF",
          `${taskPath}.resources[${refIndex}] 引用了未声明资源 ${resourceId}`,
          `${taskPath}.resources[${refIndex}]`,
        );
      }
    });
    task.checkIds.forEach((checkId, refIndex) => {
      const entry = checkById.get(checkId);
      if (!entry) {
        fail(
          "UNKNOWN_CHECK_REF",
          `${taskPath}.checkIds[${refIndex}] 引用了未定义检查 ${checkId}`,
          `${taskPath}.checkIds[${refIndex}]`,
        );
      }
      // 任务级检查必须能由该任务自身修复，不能只依赖等待下游 accepted 后修复。
      if (!entry.check.repairTaskIds.includes(task.id)) {
        fail(
          "MISSING_REPAIR_OWNER",
          `${taskPath}.checkIds[${refIndex}] 的检查 ${checkId} 的 repairTaskIds 必须包含任务自身 ${task.id}`,
          `${taskPath}.checkIds[${refIndex}]`,
        );
      }
    });
  });

  terminalCheckIds.forEach((checkId, refIndex) => {
    if (!checkIds.has(checkId)) {
      fail(
        "UNKNOWN_CHECK_REF",
        `$.terminalCheckIds[${refIndex}] 引用了未定义检查 ${checkId}`,
        `$.terminalCheckIds[${refIndex}]`,
      );
    }
  });

  assertAcyclic(tasks, keypathById);

  // 未被任何任务或终态引用的检查永远不会执行，属于契约自相矛盾。
  const referencedChecks = new Set<string>(terminalCheckIds);
  tasks.forEach((task) => task.checkIds.forEach((checkId) => referencedChecks.add(checkId)));
  checks.forEach((check, checkIndex) => {
    if (!referencedChecks.has(check.id)) {
      fail(
        "ORPHAN_CHECK",
        `$.checks[${checkIndex}] 的检查 ${check.id} 未被任何任务或终态引用，永远不会执行`,
        `$.checks[${checkIndex}].id`,
      );
    }
  });

  return deepFreeze({
    schema: PLAN_CONTRACT_SCHEMA,
    objective,
    constraints,
    resources,
    checks,
    tasks,
    terminalCheckIds,
  });
}

/* ------------------------------------------------------------------ */
/* 语义 hash：canonical JSON + SHA-256                                 */
/* ------------------------------------------------------------------ */

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashDecodedContract(contract: PlanContract): string {
  return createHash("sha256").update(canonicalJson(contract), "utf8").digest("hex");
}

/**
 * 对完整解码契约做 canonical JSON + SHA-256。
 *
 * 入参先经 `decodePlanContract` 归一化，因此：`hashPlanContract(contract)`
 * 与 `readPlanContract()` 返回的 `contractHash` 对同一语义契约恒等；
 * Markdown 正文排版、checkbox 与空白差异不参与 hash，契约语义（含数组顺序）参与。
 */
export function hashPlanContract(contract: PlanContract): string {
  return hashDecodedContract(decodePlanContract(contract));
}

/* ------------------------------------------------------------------ */
/* 唯一契约区块读取                                                    */
/* ------------------------------------------------------------------ */

function indexOfSingleMarker(text: string, marker: string): number {
  const first = text.indexOf(marker);
  if (first < 0) return -1;
  if (text.indexOf(marker, first + marker.length) >= 0) {
    fail("DUPLICATE_CONTRACT_BLOCK", `契约标记 ${marker} 出现多次；v1 只允许一个契约区块`, "markers");
  }
  return first;
}

/** 区块内必须恰好是一个 ```json fence，不允许夹带正文或第二个 fence。 */
function extractFenceJson(body: string): string {
  const lines = body.split(/\r?\n/);
  let first = 0;
  let last = lines.length - 1;
  while (first <= last && lines[first].trim() === "") first += 1;
  while (last >= first && lines[last].trim() === "") last -= 1;
  if (first > last) fail("INVALID_CONTRACT_BLOCK", "契约区块内没有 JSON fence", "contract");
  if (lines[first].trim() !== "```json") {
    fail(
      "INVALID_CONTRACT_BLOCK",
      `契约区块必须以 \`\`\`json fence 开始，实际为 ${JSON.stringify(lines[first])}`,
      "contract",
    );
  }
  if (lines[last].trim() !== "```") {
    fail("INVALID_CONTRACT_BLOCK", `契约区块必须以 \`\`\` 结束，实际为 ${JSON.stringify(lines[last])}`, "contract");
  }
  for (let index = first + 1; index < last; index += 1) {
    if (lines[index].trim().startsWith("```")) {
      fail("INVALID_CONTRACT_BLOCK", "契约区块内只允许一个 JSON fence", `contract:line-${index + 1}`);
    }
  }
  if (last - first < 2) fail("INVALID_CONTRACT_BLOCK", "契约区块的 JSON 主体为空", "contract");
  return lines.slice(first + 1, last).join("\n");
}

function decodeContractBlock(content: string): unknown {
  const startIndex = indexOfSingleMarker(content, PLAN_CONTRACT_START_MARKER);
  const endIndex = indexOfSingleMarker(content, PLAN_CONTRACT_END_MARKER);
  if (startIndex < 0 || endIndex < 0) {
    fail(
      "MISSING_CONTRACT_BLOCK",
      `计划文件必须包含唯一的 ${PLAN_CONTRACT_START_MARKER} … ${PLAN_CONTRACT_END_MARKER} 契约区块`,
      "markers",
    );
  }
  if (endIndex < startIndex) {
    fail("INVALID_CONTRACT_BLOCK", "契约区块的结束标记出现在开始标记之前", "markers");
  }
  const body = content.slice(startIndex + PLAN_CONTRACT_START_MARKER.length, endIndex);
  const jsonText = extractFenceJson(body);
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    fail("INVALID_JSON", `契约区块不是合法 JSON：${describeError(error)}`, "contract");
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 读取计划文件并解码唯一契约区块。
 *
 * 只做文件读取与纯结构验证：不扫描正文推断任务，不修改入参，
 * 不写任何状态。正文与契约冲突时由计划审阅指出差异，这里不选择较宽松的一边。
 */
export async function readPlanContract(
  filePath: string,
): Promise<{ contract: PlanContract; contractHash: string }> {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    fail("INVALID_VALUE", "计划文件路径不得为空", "filePath");
  }
  let content: string;
  try {
    const buffer = await readFile(filePath);
    if (buffer.byteLength > MAX_PLAN_BYTES) {
      fail("PLAN_TOO_LARGE", `计划文件超过 ${MAX_PLAN_BYTES} 字节上限：${filePath}`, "filePath");
    }
    content = buffer.toString("utf8");
  } catch (error) {
    if (error instanceof PlanContractError) throw error;
    throw new PlanContractError(
      "UNREADABLE_PLAN",
      `无法读取计划文件：${filePath}`,
      "filePath",
      describeError(error),
    );
  }
  const contract = decodePlanContract(decodeContractBlock(content));
  return { contract, contractHash: hashDecodedContract(contract) };
}

/* ------------------------------------------------------------------ */
/* 冻结                                                                */
/* ------------------------------------------------------------------ */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}
