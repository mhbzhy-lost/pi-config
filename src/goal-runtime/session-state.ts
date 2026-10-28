/**
 * Goal Runtime v1：复用 Pi session 的持久化业务状态（Task T2）。
 *
 * 权威来源：`docs/plans/2026-10-26-goal-runtime-v1.md` Task T2、§4.1、§5.3、§6。
 *
 * 本模块是 v1 唯一的业务状态载体：把 `GoalState` 快照与 `GoalCheckEvidence` 证据写成同一
 * Pi session 的 custom entry，并只从**当前分支 + 同一 session 文件**恢复。
 *
 * 关键边界（不可放宽）：
 * - `appendEntry()` 返回 `void`，Pi 1.4 可能先更新 SessionManager 内存索引再落盘（甚至因尚无
 *   conversation 而完全不落盘）。所以「branch 上出现条目」只证明身份，不证明写盘：
 *   必须先唯一匹配到条目 ID，再读同一 session 文件确认该 ID/内容/父链存在，才发布新快照。
 * - append 或核验失败即对**本实例**设置不可写 latch，`assertWritable()` 拒绝派发/修复/完成；
 *   不通过重读同一 branch 清除 latch，不改写 SessionManager 内部状态，不补写补偿记录，
 *   不新建 journal/index/第二状态文件、全局 registry 或进程锁。新实例只能凭实际文件重新核验。
 * - 正常「无 Goal 且未落盘的新空会话」返回 `null`，不锁死首次 `plan_execute`；
 *   corrupt/foreign/unreadable 一律抛出明确 blocked 原因，和「不存在」严格区分。
 * - `change` 是类型化纯状态转换（函数），不是任意 JSON patch；revision 由本模块串行发放，
 *   契约与 binding 在本代内不可改写（v1 不支持原地 amendment）。
 * - 证据引用只来自当前 branch 中唯一匹配的 entry ID，并由同一 session 文件再次确认。
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { FileEntry, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import {
  decodePlanContract,
  hashPlanContract,
  type CheckReceipt,
  type EvidenceWriter,
  type GoalCheck,
  type GoalCheckEvidence,
  type GoalCheckpoint,
  type GoalSessionDiskReader,
  type GoalState,
  type GoalSubject,
  type PlanBinding,
  type TaskState,
} from "./contract.ts";
import { isMultiRepositoryBinding, resolveParticipatingRepositories, validateBoundRepositories,
  type MultiRepositoryBinding } from "./repository-resolution.ts";

/* ------------------------------------------------------------------ */
/* 公开常量                                                            */
/* ------------------------------------------------------------------ */

/** Goal 业务状态快照的 custom type（§4.3，v1 唯一状态载体）。 */
export const GOAL_STATE_CUSTOM_TYPE = "goal-runtime.state.v1";

/** 检查批次证据的 custom type（§5.3，由 T5 生成、经本模块写入）。 */
export const GOAL_CHECK_EVIDENCE_CUSTOM_TYPE = "goal-runtime.check-result.v1";

const MAX_TEXT_BYTES = 4 * 1024;
const MAX_ID_BYTES = 256;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

/* ------------------------------------------------------------------ */
/* 失败诊断                                                            */
/* ------------------------------------------------------------------ */

/**
 * 状态层失败分类。`blocking` 表示该失败使本实例不可再写（含恢复未完成），
 * 或本身就是一个必须上报给用户的 blocked 终态。
 */
export type GoalStateErrorCode =
  /** 尚未完成 restore 核验，拒绝业务副作用。 */
  | "STORE_NOT_RESTORED"
  /** 持久化失败 latch 已生效；后续写入全部拒绝。 */
  | "STORE_NOT_WRITABLE"
  /** 当前没有 Goal 状态（普通会话），不接受需要状态的写入。 */
  | "NO_GOAL_STATE"
  /** 期望 revision 与当前不一致：调用方需重新读取后重试。 */
  | "REVISION_CONFLICT"
  /** change 未返回可解码的状态，或试图改写不可变身份字段。 */
  | "INVALID_STATE_CHANGE"
  /** 证据内容/契约绑定不合法，拒绝写入。 */
  | "INVALID_EVIDENCE"
  /** session 分支结构损坏或不再是单链。 */
  | "SESSION_STATE_CORRUPT"
  /** 分支上的状态/证据不属于本 session 或本 session 文件。 */
  | "SESSION_STATE_FOREIGN"
  /** 分支上存在 Goal 条目，但同一 session 文件中没有唯一匹配记录。 */
  | "SESSION_STATE_NOT_PERSISTED"
  /** 匹配到多个候选条目，无法确定真实身份。 */
  | "SESSION_STATE_AMBIGUOUS"
  /** 当前分支已不含本实例最后核验的 Goal 状态（session/分支已切换）。 */
  | "SESSION_STATE_DIVERGED"
  /** 当前 session 没有持久文件（内存会话/--no-session 不支持 Goal）。 */
  | "SESSION_FILE_UNAVAILABLE"
  /** session 文件不存在：分支有 Goal 事实但文件缺失。 */
  | "SESSION_FILE_MISSING"
  /** session 文件不可读（权限、IO、解码异常）。 */
  | "SESSION_FILE_UNREADABLE"
  /** 读取 session 分支失败。 */
  | "BRANCH_READ_FAILED"
  /** appendEntry 抛错；Pi 可能已更新内存索引，因此一律 latch。 */
  | "APPEND_FAILED"
  /** append 后无法在 branch 上唯一定位本次写入的条目。 */
  | "ENTRY_NOT_FOUND"
  /** append 后 branch 上出现多个匹配条目，拒绝猜测。 */
  | "ENTRY_AMBIGUOUS";

/** 状态层错误：带稳定 code、可追踪 detail 与是否 blocking 的判定。 */
export class GoalStateError extends Error {
  readonly code: GoalStateErrorCode;
  readonly detail: string;
  readonly blocking: boolean;

  constructor(code: GoalStateErrorCode, message: string, detail = message, blocking = true) {
    super(message);
    this.name = "GoalStateError";
    this.code = code;
    this.detail = detail;
    this.blocking = blocking;
  }
}

/** 判断一个错误是否代表「必须停写并上报」的 blocked 状态。 */
export function isGoalStateBlockingError(error: unknown): error is GoalStateError {
  return error instanceof GoalStateError && error.blocking;
}

function fail(code: GoalStateErrorCode, message: string, detail = message, blocking = true): never {
  throw new GoalStateError(code, message, detail, blocking);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 把「调用方入参不合法」引发的解码错误统一归类为可重试的 caller 错误。
 *
 * 同一套解码器既用于读盘事实（corrupt = blocking），也用于调用方入参（可拒绝后重试），
 * 因此后者必须显式降级为非 blocking，避免把一次坏参数当成持久化阻塞。
 */
function asCallerError(code: GoalStateErrorCode, error: unknown): GoalStateError {
  if (error instanceof GoalStateError && !error.blocking) return error;
  const detail = error instanceof GoalStateError ? error.detail : describeError(error);
  return new GoalStateError(code, describeError(error), detail, false);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/* ------------------------------------------------------------------ */
/* 基础校验与 canonical 序列化                                          */
/* ------------------------------------------------------------------ */

type PlainObject = Record<string, unknown>;

function plainObject(value: unknown, keypath: string): PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("SESSION_STATE_CORRUPT", `${keypath} 必须是对象，实际为 ${typeOf(value)}`);
  }
  return value as PlainObject;
}

/** 字段集合精确匹配：未知字段与缺少字段都在写入/发布前拒绝。 */
function exactKeys(
  record: PlainObject,
  allowed: readonly string[],
  keypath: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) fail("SESSION_STATE_CORRUPT", `${keypath} 含未知字段 ${key}`);
  }
  for (const key of allowed) {
    if (!optionalSet.has(key) && !Object.hasOwn(record, key)) {
      fail("SESSION_STATE_CORRUPT", `${keypath} 缺少必需字段 ${key}`);
    }
  }
}

/** 非空文本：只做校验，不改写入参（避免静默改写已持久化事实）。 */
function text(value: unknown, keypath: string, maxBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== "string") {
    fail("SESSION_STATE_CORRUPT", `${keypath} 必须是字符串，实际为 ${typeOf(value)}`);
  }
  if (value.trim() === "") fail("SESSION_STATE_CORRUPT", `${keypath} 不得为空`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("SESSION_STATE_CORRUPT", `${keypath} 超过 ${maxBytes} 字节上限`);
  }
  if (CONTROL_PATTERN.test(value)) fail("SESSION_STATE_CORRUPT", `${keypath} 不得包含控制字符`);
  return value;
}

/** 允许为空的受控文本（例如尚未产生 HEAD 的候选版本摘要）。 */
function freeText(value: unknown, keypath: string, maxBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== "string") {
    fail("SESSION_STATE_CORRUPT", `${keypath} 必须是字符串，实际为 ${typeOf(value)}`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("SESSION_STATE_CORRUPT", `${keypath} 超过 ${maxBytes} 字节上限`);
  }
  if (CONTROL_PATTERN.test(value)) fail("SESSION_STATE_CORRUPT", `${keypath} 不得包含控制字符`);
  return value;
}

function nullableText(value: unknown, keypath: string): string | null {
  if (value === null) return null;
  return text(value, keypath);
}

function list(value: unknown, keypath: string): unknown[] {
  if (!Array.isArray(value)) {
    fail("SESSION_STATE_CORRUPT", `${keypath} 必须是数组，实际为 ${typeOf(value)}`);
  }
  return value;
}

function stringList(value: unknown, keypath: string, unique = false): string[] {
  const items = list(value, keypath);
  const out: string[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const parsed = text(item, `${keypath}[${index}]`);
    if (unique) {
      if (seen.has(parsed)) fail("SESSION_STATE_CORRUPT", `${keypath}[${index}] 与前面的项重复：${parsed}`);
      seen.add(parsed);
    }
    out.push(parsed);
  });
  return out;
}

function integer(value: unknown, keypath: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail("SESSION_STATE_CORRUPT", `${keypath} 必须是整数，实际为 ${JSON.stringify(value)}`);
  }
  if (value < min) fail("SESSION_STATE_CORRUPT", `${keypath} 不得小于 ${min}：${value}`);
  return value;
}

function enumText<T extends string>(value: unknown, keypath: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(
      "SESSION_STATE_CORRUPT",
      `${keypath} 必须是 ${allowed.join(" | ")} 之一，实际为 ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

/**
 * canonical JSON：对象键排序、丢弃 undefined（与 `JSON.stringify` 的落盘语义一致）。
 * 用于 payload hash 与不可变字段比较，不用于持久化文本。
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as PlainObject;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/**
 * 计算将要落盘的 payload 摘要。
 *
 * 先做一次 `JSON.stringify` 往返，使「内存对象」与「从 JSONL 读回的对象」得到同一摘要：
 * 内存里被省略的 undefined 字段不算内容差异，不会把成功写入误判成不一致。
 */
function payloadHash(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch (error) {
    fail("INVALID_STATE_CHANGE", `payload 无法序列化为 JSON：${describeError(error)}`, describeError(error), false);
  }
  if (serialized === undefined) serialized = "null";
  return createHash("sha256").update(canonicalJson(JSON.parse(serialized)), "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* 快照严格解码                                                        */
/* ------------------------------------------------------------------ */

type SessionEntryRecord = {
  id: string;
  parentId: string | null;
  type: string;
  customType: string | null;
  data: unknown;
};

const GOAL_STATE_KEYS = [
  "planId",
  "revision",
  "binding",
  "contract",
  "status",
  "tasks",
  "receipts",
  "checkpoint",
  "pauseReason",
  "lastProgressHash",
  "noProgressTurns",
] as const;
const BINDING_KEYS = ["planPath", "contractHash", "repositoryRoot", "sessionId", "sessionFile"] as const;
const TASK_KEYS = [
  "status",
  "attempt",
  "dispatchKey",
  "workspaceId",
  "run",
  "terminalProofRef",
  "integrationReceiptRef",
  "blocker",
] as const;
const RUN_KEYS = ["runId", "workspaceId", "rootSessionId"] as const;
const RECEIPT_KEYS = [
  "checkId",
  "contractHash",
  "subject",
  "command",
  "outcome",
  "exitCode",
  "toolCallId",
  "resultRef",
  "outputHash",
] as const;
const SUBJECT_KEYS = ["repositoryRoot", "head", "contentHash"] as const;
const CHECKPOINT_KEYS = ["taskId", "decisions", "sourceRefs", "nextAction"] as const;
const EVIDENCE_KEYS = [
  "evidenceId",
  "sessionId",
  "contractHash",
  "subjectBefore",
  "subjectAfter",
  "results",
] as const;
const EVIDENCE_RESULT_KEYS = ["checkId", "command", "toolOutcome", "blockedReason"] as const;
const COMMAND_KEYS = ["executable", "args", "timeoutSeconds"] as const;

const TASK_STATUSES = ["pending", "running", "verifying", "accepted", "blocked"] as const;
const GOAL_STATUSES = ["active", "paused", "blocked", "completed", "cancelled"] as const;
const RECEIPT_OUTCOMES = ["passed", "failed", "stale", "blocked"] as const;

export function decodePlanBinding(value: unknown, keypath = "$binding"): PlanBinding | MultiRepositoryBinding {
  const record = plainObject(value, keypath);
  const multi = Object.hasOwn(record, "repositories");
  exactKeys(record, multi ? [...BINDING_KEYS, "repositories"] : BINDING_KEYS, keypath);
  const contractHash = text(record.contractHash, `${keypath}.contractHash`, MAX_TEXT_BYTES);
  if (!HASH_PATTERN.test(contractHash)) {
    fail("SESSION_STATE_CORRUPT", `${keypath}.contractHash 必须是 64 位小写十六进制摘要`);
  }
  const binding: PlanBinding = {
    planPath: text(record.planPath, `${keypath}.planPath`),
    contractHash,
    repositoryRoot: text(record.repositoryRoot, `${keypath}.repositoryRoot`),
    sessionId: text(record.sessionId, `${keypath}.sessionId`, MAX_ID_BYTES),
    sessionFile: text(record.sessionFile, `${keypath}.sessionFile`),
  };
  if (!multi) return binding;
  const repositories = list(record.repositories, `${keypath}.repositories`).map((value, index) => {
    const at = `${keypath}.repositories[${index}]`;
    const repository = plainObject(value, at);
    exactKeys(repository, ["repoId", "root", "repositoryId", "storageRepositoryId"], at);
    return { repoId: text(repository.repoId, `${at}.repoId`), root: text(repository.root, `${at}.root`),
      repositoryId: text(repository.repositoryId, `${at}.repositoryId`), storageRepositoryId: text(repository.storageRepositoryId, `${at}.storageRepositoryId`) };
  });
  try { validateBoundRepositories(binding.repositoryRoot, repositories); }
  catch (error) { fail("SESSION_STATE_CORRUPT", describeError(error)); }
  return { ...binding, repositories };
}

function decodeSubject(value: unknown, keypath: string): GoalSubject {
  const record = plainObject(value, keypath);
  if (Object.hasOwn(record, "kind")) {
    exactKeys(record, ["kind", "repositories"], keypath);
    if (record.kind !== "multi-repository") fail("SESSION_STATE_CORRUPT", `${keypath}.kind 不是已知 subject 变体`);
    let previous = "";
    const repositories = list(record.repositories, `${keypath}.repositories`).map((value, index) => {
      const at = `${keypath}.repositories[${index}]`;
      const member = plainObject(value, at);
      exactKeys(member, ["repoId", ...SUBJECT_KEYS], at);
      const repoId = text(member.repoId, `${at}.repoId`);
      if (/[\\/\u0000-\u001f\u007f*?[\]]/.test(repoId) || repoId === "." || repoId === ".." || repoId <= previous) {
        fail("SESSION_STATE_CORRUPT", `${at}.repoId 必须为合法目录名且严格升序、不重复`);
      }
      previous = repoId;
      return { repoId, repositoryRoot: text(member.repositoryRoot, `${at}.repositoryRoot`),
        head: freeText(member.head, `${at}.head`), contentHash: text(member.contentHash, `${at}.contentHash`) };
    });
    if (!repositories.length) fail("SESSION_STATE_CORRUPT", `${keypath}.repositories 不得为空`);
    return { kind: "multi-repository", repositories };
  }
  exactKeys(record, SUBJECT_KEYS, keypath);
  return {
    repositoryRoot: text(record.repositoryRoot, `${keypath}.repositoryRoot`),
    head: freeText(record.head, `${keypath}.head`),
    contentHash: text(record.contentHash, `${keypath}.contentHash`),
  };
}

/** 形状解码后核对固定参与集合，拒绝库存、漏仓库或跨根证据。 */
function assertSubjectBinding(subject: GoalSubject, binding: PlanBinding, keypath: string): void {
  if (isMultiRepositoryBinding(binding)) {
    if (!("kind" in subject) || subject.repositories.length !== binding.repositories.length
      || subject.repositories.some(member => !binding.repositories.some(repository =>
        repository.repoId === member.repoId && repository.root === member.repositoryRoot))) {
      fail("SESSION_STATE_CORRUPT", `${keypath} 与 binding 固定参与仓库不一致`);
    }
  } else if ("kind" in subject || subject.repositoryRoot !== binding.repositoryRoot) {
    fail("SESSION_STATE_CORRUPT", `${keypath} 与绑定的单仓库根不一致`);
  }
}

function decodeCommand(value: unknown, keypath: string): GoalCheck["command"] {
  const record = plainObject(value, keypath);
  exactKeys(record, COMMAND_KEYS, keypath);
  return {
    executable: text(record.executable, `${keypath}.executable`),
    args: list(record.args, `${keypath}.args`).map((arg, index) => freeText(arg, `${keypath}.args[${index}]`)),
    timeoutSeconds: integer(record.timeoutSeconds, `${keypath}.timeoutSeconds`, 1),
  };
}

function decodeCheckpoint(value: unknown, keypath: string): GoalCheckpoint {
  const record = plainObject(value, keypath);
  exactKeys(record, CHECKPOINT_KEYS, keypath, ["taskId"]);
  const checkpoint: GoalCheckpoint = {
    decisions: stringList(record.decisions, `${keypath}.decisions`),
    sourceRefs: stringList(record.sourceRefs, `${keypath}.sourceRefs`),
    nextAction: text(record.nextAction, `${keypath}.nextAction`),
  };
  if (record.taskId !== undefined) {
    checkpoint.taskId = text(record.taskId, `${keypath}.taskId`, MAX_ID_BYTES);
  }
  return checkpoint;
}

function decodeTaskState(value: unknown, keypath: string): TaskState {
  const record = plainObject(value, keypath);
  exactKeys(record, TASK_KEYS, keypath);
  let run: TaskState["run"] = null;
  if (record.run !== null) {
    const runRecord = plainObject(record.run, `${keypath}.run`);
    exactKeys(runRecord, RUN_KEYS, `${keypath}.run`);
    run = {
      runId: text(runRecord.runId, `${keypath}.run.runId`, MAX_ID_BYTES),
      workspaceId: text(runRecord.workspaceId, `${keypath}.run.workspaceId`, MAX_ID_BYTES),
      rootSessionId: text(runRecord.rootSessionId, `${keypath}.run.rootSessionId`, MAX_ID_BYTES),
    };
  }
  return {
    status: enumText(record.status, `${keypath}.status`, TASK_STATUSES),
    attempt: integer(record.attempt, `${keypath}.attempt`, 0),
    dispatchKey: nullableText(record.dispatchKey, `${keypath}.dispatchKey`),
    workspaceId: nullableText(record.workspaceId, `${keypath}.workspaceId`),
    run,
    terminalProofRef: nullableText(record.terminalProofRef, `${keypath}.terminalProofRef`),
    integrationReceiptRef: nullableText(record.integrationReceiptRef, `${keypath}.integrationReceiptRef`),
    blocker: nullableText(record.blocker, `${keypath}.blocker`),
  };
}

/**
 * 严格解码一条检查回执。
 *
 * `command` 必须与契约中同一 check 的命令逐字一致（canonical JSON 相等），
 * 否则回执属于不同契约/被篡改，不能用于通过判定。
 */
function decodeReceipt(
  value: unknown,
  keypath: string,
  contractChecks: ReadonlyMap<string, GoalCheck>,
  contractHash: string,
  binding: PlanBinding,
): CheckReceipt {
  const record = plainObject(value, keypath);
  exactKeys(record, RECEIPT_KEYS, keypath);
  const checkId = text(record.checkId, `${keypath}.checkId`, MAX_ID_BYTES);
  const check = contractChecks.get(checkId);
  if (!check) fail("SESSION_STATE_CORRUPT", `${keypath}.checkId 引用了契约外检查 ${checkId}`);
  const command = decodeCommand(record.command, `${keypath}.command`);
  if (canonicalJson(command) !== canonicalJson(check.command)) {
    fail("SESSION_STATE_CORRUPT", `${keypath}.command 与契约中检查 ${checkId} 的命令不一致`);
  }
  const receiptHash = text(record.contractHash, `${keypath}.contractHash`);
  if (receiptHash !== contractHash) {
    fail("SESSION_STATE_CORRUPT", `${keypath}.contractHash 与当前状态绑定的契约不一致`);
  }
  const subject = decodeSubject(record.subject, `${keypath}.subject`);
  assertSubjectBinding(subject, binding, `${keypath}.subject`);
  const exitCode = record.exitCode === null ? null : integer(record.exitCode, `${keypath}.exitCode`, -1);
  return {
    checkId,
    contractHash: receiptHash,
    subject,
    command: check.command,
    outcome: enumText(record.outcome, `${keypath}.outcome`, RECEIPT_OUTCOMES),
    exitCode,
    toolCallId: text(record.toolCallId, `${keypath}.toolCallId`, MAX_ID_BYTES),
    resultRef: text(record.resultRef, `${keypath}.resultRef`, MAX_ID_BYTES),
    outputHash: text(record.outputHash, `${keypath}.outputHash`),
  };
}

/**
 * 严格解码并交叉校验一个状态快照。
 *
 * 除字段形状外还核对：契约可被 T1 严格解码、`binding.contractHash` 与契约语义 hash 相等、
 * 任务/回执/checkpoint 只引用契约内 ID、回执命令与契约一致。任一项不成立即视为 corrupt，
 * 不做「跳过坏字段」的宽松恢复。
 */
export function decodeGoalStateSnapshot(value: unknown): GoalState {
  const record = plainObject(value, "$state");
  exactKeys(record, GOAL_STATE_KEYS, "$state");
  const binding = decodePlanBinding(record.binding, "$state.binding");

  let contract: GoalState["contract"];
  try {
    contract = decodePlanContract(record.contract);
  } catch (error) {
    fail("SESSION_STATE_CORRUPT", `状态内契约未通过严格解码：${describeError(error)}`, describeError(error));
  }
  if (hashPlanContract(contract) !== binding.contractHash) {
    fail("SESSION_STATE_CORRUPT", "状态内契约的语义 hash 与 binding.contractHash 不一致");
  }
  if (isMultiRepositoryBinding(binding)) {
    try {
      const participating = resolveParticipatingRepositories(contract, binding.repositories);
      if (participating.length !== binding.repositories.length) throw new Error("binding 含计划未参与的仓库");
    } catch (error) { fail("SESSION_STATE_CORRUPT", describeError(error)); }
  }

  const contractTaskIds = new Set(contract.tasks.map((task) => task.id));
  const contractChecks = new Map(contract.checks.map((check) => [check.id, check]));

  const tasksRecord = plainObject(record.tasks, "$state.tasks");
  const tasks: Record<string, TaskState> = {};
  for (const taskId of Object.keys(tasksRecord)) {
    if (!contractTaskIds.has(taskId)) {
      fail("SESSION_STATE_CORRUPT", `$state.tasks 含契约外任务 ${taskId}`);
    }
    tasks[taskId] = decodeTaskState(tasksRecord[taskId], `$state.tasks.${taskId}`);
  }

  const receipts = list(record.receipts, "$state.receipts").map((item, index) =>
    decodeReceipt(item, `$state.receipts[${index}]`, contractChecks, binding.contractHash, binding),
  );

  const checkpoint = decodeCheckpoint(record.checkpoint, "$state.checkpoint");
  if (checkpoint.taskId !== undefined && !contractTaskIds.has(checkpoint.taskId)) {
    fail("SESSION_STATE_CORRUPT", `$state.checkpoint.taskId 引用了契约外任务 ${checkpoint.taskId}`);
  }

  return {
    planId: text(record.planId, "$state.planId", MAX_ID_BYTES),
    revision: integer(record.revision, "$state.revision", 0),
    binding,
    contract,
    status: enumText(record.status, "$state.status", GOAL_STATUSES),
    tasks,
    receipts,
    checkpoint,
    pauseReason: nullableText(record.pauseReason, "$state.pauseReason"),
    lastProgressHash: freeText(record.lastProgressHash, "$state.lastProgressHash"),
    noProgressTurns: integer(record.noProgressTurns, "$state.noProgressTurns", 0),
  };
}

/** 严格解码一批检查证据（只校验形状与引用字段，`toolOutcome` 保留原始 JSON）。 */
export function decodeGoalCheckEvidence(value: unknown): GoalCheckEvidence {
  const record = plainObject(value, "$evidence");
  exactKeys(record, EVIDENCE_KEYS, "$evidence");
  const contractHash = text(record.contractHash, "$evidence.contractHash", MAX_TEXT_BYTES);
  if (!HASH_PATTERN.test(contractHash)) {
    fail("INVALID_EVIDENCE", "$evidence.contractHash 必须是 64 位小写十六进制摘要", undefined, false);
  }
  const results = list(record.results, "$evidence.results").map((item, index) => {
    const keypath = `$evidence.results[${index}]`;
    const result = plainObject(item, keypath);
    exactKeys(result, EVIDENCE_RESULT_KEYS, keypath);
    // toolOutcome 是原工具回执的原始 JSON（不为 TUI 改写），这里只校验形状并保留原值。
    const toolOutcome =
      result.toolOutcome === null
        ? null
        : (plainObject(
            result.toolOutcome,
            `${keypath}.toolOutcome`,
          ) as unknown as GoalCheckEvidence["results"][number]["toolOutcome"]);
    return {
      checkId: text(result.checkId, `${keypath}.checkId`, MAX_ID_BYTES),
      command: decodeCommand(result.command, `${keypath}.command`),
      toolOutcome,
      blockedReason: nullableText(result.blockedReason, `${keypath}.blockedReason`),
    };
  });
  return {
    evidenceId: text(record.evidenceId, "$evidence.evidenceId", MAX_ID_BYTES),
    sessionId: text(record.sessionId, "$evidence.sessionId", MAX_ID_BYTES),
    contractHash,
    subjectBefore: decodeSubject(record.subjectBefore, "$evidence.subjectBefore"),
    subjectAfter: decodeSubject(record.subjectAfter, "$evidence.subjectAfter"),
    results,
  };
}

/* ------------------------------------------------------------------ */
/* 分支解码与 session 文件索引                                          */
/* ------------------------------------------------------------------ */

/** 把 `getBranch()` 的返回值校验成一条完整的 root→leaf 单链。 */
function decodeBranch(value: unknown): SessionEntryRecord[] {
  if (!Array.isArray(value)) {
    fail("SESSION_STATE_CORRUPT", `session 分支必须是数组，实际为 ${typeOf(value)}`);
  }
  const out: SessionEntryRecord[] = [];
  const seen = new Set<string>();
  let previousId: string | null = null;
  value.forEach((raw, index) => {
    const keypath = `branch[${index}]`;
    const record = plainObject(raw, keypath);
    const id = text(record.id, `${keypath}.id`, MAX_ID_BYTES);
    const parentValue = record.parentId;
    if (parentValue !== null && typeof parentValue !== "string") {
      fail("SESSION_STATE_CORRUPT", `${keypath}.parentId 必须是字符串或 null`);
    }
    const parentId = parentValue as string | null;
    if (index > 0 && parentId !== previousId) {
      // 分支必须是单链：出现断链说明调用方给了错误的分支快照，不能据此恢复。
      fail("SESSION_STATE_CORRUPT", `${keypath}.parentId 与前一条目不相连，分支不是单链`);
    }
    if (seen.has(id)) fail("SESSION_STATE_CORRUPT", `${keypath}.id 重复：${id}`);
    const type = text(record.type, `${keypath}.type`, MAX_ID_BYTES);
    const customType = typeof record.customType === "string" ? record.customType : null;
    seen.add(id);
    previousId = id;
    out.push({ id, parentId, type, customType, data: record.data });
  });
  return out;
}

function isGoalStateEntry(entry: SessionEntryRecord): boolean {
  return entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE;
}

function isEvidenceEntry(entry: SessionEntryRecord): boolean {
  return entry.type === "custom" && entry.customType === GOAL_CHECK_EVIDENCE_CUSTOM_TYPE;
}

function lastGoalStateEntry(branch: readonly SessionEntryRecord[]): SessionEntryRecord | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (isGoalStateEntry(entry)) return entry;
  }
  return null;
}

type SessionDiskIndex = {
  header: SessionHeader | null;
  byId: Map<string, FileEntry>;
};

/** 索引同一 session 文件的 JSONL 记录；header 唯一，条目 id 不得重复。 */
function indexSessionFile(entries: readonly FileEntry[]): SessionDiskIndex {
  let header: SessionHeader | null = null;
  const byId = new Map<string, FileEntry>();
  entries.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fail("SESSION_FILE_UNREADABLE", `session 文件第 ${index + 1} 条记录不是对象`);
    }
    const record = raw as unknown as PlainObject;
    if (record.type === "session") {
      if (header) fail("SESSION_STATE_CORRUPT", "session 文件包含多个 header");
      header = raw as SessionHeader;
      return;
    }
    const id = record.id;
    if (typeof id !== "string" || id === "") {
      fail("SESSION_STATE_CORRUPT", `session 文件第 ${index + 1} 条记录缺少 id`);
    }
    if (byId.has(id)) fail("SESSION_STATE_CORRUPT", `session 文件出现重复条目 id ${id}`);
    byId.set(id, raw);
  });
  return { header, byId };
}

/**
 * 默认的只读 session 文件读取器（`GoalSessionDiskReader`）。
 *
 * 只做「读同一 JSONL → 标准行解码」：不写文件、不建 index/journal、不触碰 SessionManager 私有状态。
 * `parseSessionEntries` 会跳过无法解析的行；因此缺证据不会被宽松跳过掩盖——所需的
 * state/evidence 记录一旦缺失，恢复立即以 `SESSION_STATE_NOT_PERSISTED` 阻塞。
 */
export const readPersistedGoalEntries: GoalSessionDiskReader = async (sessionFile) => {
  const path = normalizeSessionFile(sessionFile);
  if (!path) {
    fail("SESSION_FILE_UNAVAILABLE", "读取持久化记录时缺少 session 文件路径（--no-session/内存会话不支持 Goal）");
  }
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      fail("SESSION_FILE_MISSING", `session 文件不存在：${path}`, describeError(error));
    }
    fail("SESSION_FILE_UNREADABLE", `session 文件不可读：${path}`, describeError(error));
  }
  return parseSessionEntries(content);
};

function normalizeSessionFile(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/* ------------------------------------------------------------------ */
/* 恢复                                                                */
/* ------------------------------------------------------------------ */

export type RestoreGoalStateInput = {
  /** 当前分支（`sessionManager.getBranch()` 的原样返回值）。 */
  branch: readonly SessionEntry[];
  /** Host 提供的真实 session ID。 */
  sessionId: string;
  /** Host 提供的真实 session 文件；内存会话为 undefined。 */
  sessionFile: string | undefined;
  /** 只读读取同一 JSONL 的解码入口。 */
  readPersistedEntries: GoalSessionDiskReader;
};

type RestoreOutcome = {
  state: GoalState;
  stateEntryId: string;
  evidenceEntryIds: string[];
};

/**
 * verification.ts 写入端把回执 `resultRef` 写成 `${entryId}#${index}`（`index` 为同一证据条目内
 * 第几个结果，与 index.ts 的拆分约定一致）；恢复时必须按同一约定剥离索引后缀再定位条目。
 */
const RESULT_REF_PATTERN = /^(.*)#(\d+)$/;

/** 在分支中定位回执引用的唯一证据条目（优先按 entry ID，其次按 evidenceId）。 */
function resolveEvidenceEntry(
  ref: string,
  ofTypeEvidence: readonly SessionEntryRecord[],
  byId: ReadonlyMap<string, SessionEntryRecord>,
): SessionEntryRecord {
  // 带索引后缀的引用只能按 entry ID 定位：索引指向该条目内的结果，不参与条目身份。
  const suffix = RESULT_REF_PATTERN.exec(ref);
  const target = suffix ? suffix[1] : ref;
  const direct = byId.get(target);
  if (direct && isEvidenceEntry(direct)) return direct;
  if (suffix) {
    fail("SESSION_STATE_CORRUPT", `回执 resultRef ${ref} 在当前分支找不到唯一证据条目`);
  }
  const byEvidenceId = ofTypeEvidence.filter((entry) => {
    const data = entry.data;
    return (
      data !== null &&
      typeof data === "object" &&
      (data as Record<string, unknown>).evidenceId === ref
    );
  });
  if (byEvidenceId.length === 1) return byEvidenceId[0];
  if (byEvidenceId.length === 0) {
    fail("SESSION_STATE_CORRUPT", `回执 resultRef ${ref} 在当前分支找不到唯一证据条目`);
  }
  fail("SESSION_STATE_AMBIGUOUS", `回执 resultRef ${ref} 在当前分支匹配到多个证据条目`);
}

/**
 * 校验某条处于当前分支的 Goal 条目在同一 session 文件中确有唯一记录。
 *
 * 只证明「该条目已写入文件」：核对其 id、customType、payload hash 与父链。
 * 不承诺 fsync/断电事务，也不改写 SessionManager 内存状态。
 */
function assertPersistedRecord(
  disk: SessionDiskIndex,
  entry: SessionEntryRecord,
  customType: string,
  expectedHash: string,
): void {
  const record = disk.byId.get(entry.id);
  if (!record) {
    fail(
      "SESSION_STATE_NOT_PERSISTED",
      `session 文件中缺少 Goal 条目 ${entry.id}（customType=${customType}）；分支事实尚未落盘`,
    );
  }
  const diskRecord = record as unknown as PlainObject;
  if (diskRecord.type !== "custom" || diskRecord.customType !== customType) {
    fail("SESSION_STATE_NOT_PERSISTED", `session 文件中条目 ${entry.id} 不是 ${customType} 记录`);
  }
  if (payloadHash(diskRecord.data) !== expectedHash) {
    fail("SESSION_STATE_NOT_PERSISTED", `session 文件中条目 ${entry.id} 的内容与分支快照不一致`);
  }
  const diskParentId = (diskRecord.parentId ?? null) as string | null;
  if (diskParentId !== entry.parentId) {
    fail("SESSION_STATE_NOT_PERSISTED", `session 文件中条目 ${entry.id} 的父链与分支不一致`);
  }
  if (diskParentId !== null && !disk.byId.has(diskParentId)) {
    fail("SESSION_STATE_CORRUPT", `session 文件中条目 ${entry.id} 的父条目 ${diskParentId} 缺失`);
  }
}

/** 终态 Goal 状态：只有这两种状态允许「文件里有历史记录但当前分支没有」时按无 Goal 处理。 */
const TERMINAL_GOAL_STATUSES: readonly GoalState["status"][] = ["completed", "cancelled"];

/**
 * 当前分支没有 Goal 条目时，确认同一 session 文件里也没有「活的」Goal 记录。
 *
 * 存在的场景：session 文件被回退到早于 Goal 激活的叶子、或文件索引不完整导致分支被截断。
 * 这种情况不能当作「没有 Goal」——否则会在丢失既有目标的情况下允许再次激活。
 * 只有文件里最后一条 Goal 状态已经是 completed/cancelled（历史归档）时才返回 null。
 */
async function assertNoLiveGoalRecord(
  sessionFile: string | null,
  reader: GoalSessionDiskReader,
): Promise<void> {
  // 没有持久文件（内存会话/--no-session）：没有磁盘事实可比较，交由调用方按普通会话处理。
  if (!sessionFile) return;

  let entries: readonly FileEntry[];
  try {
    entries = await reader(sessionFile);
  } catch (error) {
    // 文件尚未创建是正常的新空会话；其余读取失败不得冒充「不存在」。
    if (error instanceof GoalStateError && error.code === "SESSION_FILE_MISSING") return;
    if (error instanceof GoalStateError) throw error;
    fail("SESSION_FILE_UNREADABLE", `无法读取 session 文件：${sessionFile}`, describeError(error));
  }

  let lastStateData: unknown = undefined;
  let sawEvidence = false;
  for (const raw of entries) {
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as unknown as PlainObject;
    if (record.type !== "custom") continue;
    if (record.customType === GOAL_STATE_CUSTOM_TYPE) lastStateData = record.data;
    else if (record.customType === GOAL_CHECK_EVIDENCE_CUSTOM_TYPE) sawEvidence = true;
  }

  if (lastStateData === undefined) {
    if (sawEvidence) {
      fail("SESSION_STATE_CORRUPT", "session 文件中存在 Goal 检查证据但没有状态记录；拒绝当作没有 Goal");
    }
    return;
  }

  let status: GoalState["status"];
  try {
    status = decodeGoalStateSnapshot(lastStateData).status;
  } catch (error) {
    fail(
      "SESSION_STATE_CORRUPT",
      `session 文件中存在无法解码的 Goal 状态记录：${describeError(error)}`,
      describeError(error),
    );
  }
  if (TERMINAL_GOAL_STATUSES.includes(status)) return;
  fail(
    "SESSION_STATE_CORRUPT",
    `session 文件中存在未终态的 Goal 记录（status=${status}），但当前分支不含它；分支已回退或文件索引不完整，拒绝当作没有 Goal`,
  );
}

/**
 * 恢复当前分支的 Goal 状态。
 *
 * 返回 `null` 仅表示「当前会话没有 Goal 状态」（含从未激活过的普通会话 / 尚未落盘的新空会话），
 * 调用方可以继续首次 `plan_execute`。corrupt、foreign、缺文件、缺记录等情况一律抛出
 * `GoalStateError`（blocking），与「不存在」严格区分。
 */
export async function restoreGoalState(input: RestoreGoalStateInput): Promise<GoalState | null> {
  const outcome = await restoreGoalStateVerified(input);
  return outcome ? outcome.state : null;
}

async function restoreGoalStateVerified(input: RestoreGoalStateInput): Promise<RestoreOutcome | null> {
  const sessionId = normalizeSessionFile(input.sessionId);
  if (!sessionId) {
    fail("SESSION_STATE_FOREIGN", "恢复时缺少 Host session ID，无法确认 Goal 状态归属");
  }

  const branch = decodeBranch(input.branch);
  const stateEntry = lastGoalStateEntry(branch);
  const evidenceEntries = branch.filter(isEvidenceEntry);
  const sessionFile = normalizeSessionFile(input.sessionFile);

  if (!stateEntry) {
    // 只剩证据而无状态权威，说明引用链被破坏，不能当成「没有 Goal」。
    if (evidenceEntries.length > 0) {
      fail(
        "SESSION_STATE_CORRUPT",
        "当前分支存在检查证据条目但没有 Goal 状态权威条目；引用链不完整，拒绝恢复",
      );
    }
    // 分支无 Goal 时仍核对同一文件：不允许把「曾在文件里记录过的活 Goal」当作不存在。
    await assertNoLiveGoalRecord(sessionFile, input.readPersistedEntries);
    return null;
  }

  const state = decodeGoalStateSnapshot(stateEntry.data);
  if (!sessionFile) {
    fail(
      "SESSION_FILE_UNAVAILABLE",
      "分支存在 Goal 状态，但当前 session 没有持久文件（--no-session/内存会话不支持 Goal）",
    );
  }
  if (state.binding.sessionId !== sessionId) {
    fail(
      "SESSION_STATE_FOREIGN",
      `Goal 状态绑定的 sessionId(${state.binding.sessionId}) 与当前 session(${sessionId}) 不一致，拒绝跨会话恢复`,
    );
  }
  if (normalizeSessionFile(state.binding.sessionFile) !== sessionFile) {
    fail("SESSION_STATE_FOREIGN", "Goal 状态绑定的 session 文件与当前 session 文件不一致，拒绝恢复");
  }

  // 回执 → 证据条目的引用链必须能在当前分支内唯一解析。
  const branchById = new Map(branch.map((entry) => [entry.id, entry]));
  const referenced = new Map<string, SessionEntryRecord>();
  for (const receipt of state.receipts) {
    const entry = resolveEvidenceEntry(receipt.resultRef, evidenceEntries, branchById);
    referenced.set(entry.id, entry);
  }

  // 同一 session 文件核验：header/sessionId、state 记录、以及被引用的证据记录。
  let disk: SessionDiskIndex;
  try {
    disk = indexSessionFile(await input.readPersistedEntries(sessionFile));
  } catch (error) {
    if (error instanceof GoalStateError) throw error;
    fail("SESSION_FILE_UNREADABLE", `无法读取 session 文件：${sessionFile}`, describeError(error));
  }
  if (!disk.header) {
    fail(
      "SESSION_STATE_NOT_PERSISTED",
      `session 文件 ${sessionFile} 尚无 header，分支上的 Goal 状态并未落盘`,
    );
  }
  if (disk.header.id !== sessionId) {
    fail(
      "SESSION_STATE_FOREIGN",
      `session 文件 header 的 sessionId(${disk.header.id}) 与当前 session(${sessionId}) 不一致`,
    );
  }
  assertPersistedRecord(disk, stateEntry, GOAL_STATE_CUSTOM_TYPE, payloadHash(stateEntry.data));

  for (const entry of referenced.values()) {
    const evidence = decodeGoalCheckEvidence(entry.data);
    if (evidence.sessionId !== sessionId) {
      fail("SESSION_STATE_FOREIGN", `证据条目 ${entry.id} 属于 session ${evidence.sessionId}，拒绝跨会话引用`);
    }
    if (evidence.contractHash !== state.binding.contractHash) {
      fail("SESSION_STATE_CORRUPT", `证据条目 ${entry.id} 的 contractHash 与当前状态绑定的契约不一致`);
    }
    assertSubjectBinding(evidence.subjectBefore, state.binding, `证据 ${entry.id}.subjectBefore`);
    assertSubjectBinding(evidence.subjectAfter, state.binding, `证据 ${entry.id}.subjectAfter`);
    assertPersistedRecord(disk, entry, GOAL_CHECK_EVIDENCE_CUSTOM_TYPE, payloadHash(entry.data));
  }

  return {
    state: deepFreeze(state),
    stateEntryId: stateEntry.id,
    evidenceEntryIds: [...referenced.keys()],
  };
}

/* ------------------------------------------------------------------ */
/* 串行状态 store                                                      */
/* ------------------------------------------------------------------ */

/** 类型化纯状态转换：接收当前（已冻结）状态，返回新状态；禁止原地改写。 */
export type GoalStateChange = (current: GoalState | null) => GoalState;

export type GoalStateBranchReader = () => readonly SessionEntry[];

export type GoalStateAppendEntry = (customType: string, data?: unknown) => void;

export type CreateGoalStateStoreInput = {
  /** Host 提供的真实 session ID（`sessionManager.getSessionId()`）。 */
  sessionId: string;
  /** Host 提供的真实 session 文件（`getSessionFile()`）；内存会话为 undefined。 */
  sessionFile: string | undefined;
  /** `sessionManager.getBranch()` 的只读投影。 */
  readBranch: GoalStateBranchReader;
  /** `pi.appendEntry(customType, data)`（返回 void）。 */
  appendEntry: GoalStateAppendEntry;
  /** 只读读取同一 JSONL；缺省使用 `readPersistedGoalEntries`。 */
  readPersistedEntries?: GoalSessionDiskReader;
};

/** 本实例的存储阻塞诊断；`read()` 本身不伪造 blocked 快照。 */
export type GoalStateStoreDiagnostics = {
  restored: boolean;
  writable: boolean;
  revision: number | null;
  entryId: string | null;
  blockedCode: GoalStateErrorCode | null;
  blockedReason: string | null;
  sessionFile: string | null;
  verifiedEntryCount: number;
};

export type GoalStateStore = {
  /** 从当前分支 + 同一 session 文件恢复；无 Goal 时返回 null。 */
  restore(): Promise<GoalState | null>;
  /** 只读返回最后已核验状态；不做 I/O，不推进 revision。 */
  read(): GoalState | null;
  /** 串行提交一次状态转换；提交前校验 expectedRevision。 */
  update(expectedRevision: number, change: GoalStateChange): Promise<GoalState>;
  /** 仅为已取消实例追加新计划；旧条目及证据保持原样。 */
  replaceCancelled(expectedRevision: number, newState: GoalState): Promise<GoalState>;
  /** 记录结构化交接（checkpoint）；不改 revision 语义以外的业务字段。 */
  checkpoint(value: GoalCheckpoint): Promise<GoalState>;
  /** 写入一批检查证据，返回真实 entry ID（写完并核验后才返回）。 */
  writeEvidence: EvidenceWriter;
  /** 拒绝派发/修复/完成等业务副作用：未恢复或已 latch 时抛出。 */
  assertWritable(): void;
  /** 本实例存储状态诊断（真实 latch 原因，不改写状态）。 */
  diagnose(): GoalStateStoreDiagnostics;
};

class GoalStateStoreImpl implements GoalStateStore {
  /** 短 Promise 写队列：所有 restore/update/checkpoint/writeEvidence 共用。 */
  private queue: Promise<unknown> = Promise.resolve();

  private current: GoalState | null = null;

  private currentEntryId: string | null = null;

  /** 本代已核验（写入或恢复）的条目 ID；仅用于省去重复读盘，不用于绕过核验。 */
  private readonly verifiedEntryIds = new Set<string>();

  private restored = false;

  private latch: GoalStateError | null = null;

  private readonly sessionId: string;

  private readonly sessionFile: string | null;

  private readonly readBranch: GoalStateBranchReader;

  private readonly appendEntry: GoalStateAppendEntry;

  private readonly readPersistedEntries: GoalSessionDiskReader;

  constructor(input: CreateGoalStateStoreInput) {
    this.sessionId = input.sessionId;
    this.sessionFile = normalizeSessionFile(input.sessionFile);
    this.readBranch = input.readBranch;
    this.appendEntry = input.appendEntry;
    this.readPersistedEntries = input.readPersistedEntries ?? readPersistedGoalEntries;
  }

  get writeEvidence(): EvidenceWriter {
    return async (evidence: GoalCheckEvidence): Promise<{ entryId: string }> => {
      // 入队前先做纯校验，非法证据不占用写队列、也不产生副作用。
      let decoded: GoalCheckEvidence;
      try {
        decoded = decodeGoalCheckEvidence(evidence);
      } catch (error) {
        throw asCallerError("INVALID_EVIDENCE", error);
      }
      return this.enqueue(() => this.writeEvidenceNow(decoded));
    };
  }

  read(): GoalState | null {
    return this.current;
  }

  diagnose(): GoalStateStoreDiagnostics {
    return {
      restored: this.restored,
      writable: this.restored && this.latch === null,
      revision: this.current ? this.current.revision : null,
      entryId: this.currentEntryId,
      blockedCode: this.latch ? this.latch.code : null,
      blockedReason: this.latch ? this.latch.message : null,
      sessionFile: this.sessionFile,
      verifiedEntryCount: this.verifiedEntryIds.size,
    };
  }

  assertWritable(): void {
    if (this.latch) throw this.latch;
    if (!this.restored) {
      fail(
        "STORE_NOT_RESTORED",
        "Goal 状态尚未完成恢复核验，拒绝派发/修复/完成等业务副作用",
      );
    }
  }

  restore(): Promise<GoalState | null> {
    return this.enqueue(() => this.restoreNow());
  }

  update(expectedRevision: number, change: GoalStateChange): Promise<GoalState> {
    return this.enqueue(() => this.commit(expectedRevision, change));
  }

  replaceCancelled(expectedRevision: number, newState: GoalState): Promise<GoalState> {
    return this.enqueue(async () => {
      this.assertWritable();
      const current = this.current;
      if (!current || current.revision !== expectedRevision) {
        fail("REVISION_CONFLICT", "替换计划前状态已变化，请重新核对闭合事实", undefined, false);
      }
      if (current.status !== "cancelled") {
        fail("INVALID_STATE_CHANGE", "仅允许替换已取消的计划", undefined, false);
      }
      let decoded: GoalState;
      try { decoded = decodeGoalStateSnapshot(newState); }
      catch (error) { throw asCallerError("INVALID_STATE_CHANGE", error); }
      if (decoded.planId === current.planId || decoded.status !== "active" || decoded.revision !== 0
        || decoded.receipts.length || Object.values(decoded.tasks).some(task => task.status !== "pending"
          || task.attempt !== 0 || task.run || task.dispatchKey || task.workspaceId
          || task.terminalProofRef || task.integrationReceiptRef || task.blocker)) {
        fail("INVALID_STATE_CHANGE", "替换必须建立新 planId 的全新状态，不能继承旧执行证据", undefined, false);
      }
      this.assertImmutableIdentity(null, decoded);
      // 原状态不修改；appendVerified 同样核对分支连续性、条目身份与落盘事实。
      const next = deepFreeze({ ...decoded, revision: 1 });
      const { entryId } = await this.appendVerified(GOAL_STATE_CUSTOM_TYPE, next);
      this.current = next;
      this.currentEntryId = entryId;
      this.verifiedEntryIds.add(entryId);
      return next;
    });
  }

  checkpoint(value: GoalCheckpoint): Promise<GoalState> {
    // 先做严格解码，非法交接内容在入队前即被拒绝。
    let checkpoint: GoalCheckpoint;
    try {
      checkpoint = decodeCheckpoint(value, "$checkpoint");
    } catch (error) {
      throw asCallerError("INVALID_STATE_CHANGE", error);
    }
    return this.enqueue(() =>
      this.commit(null, (current) => {
        if (!current) {
          fail("NO_GOAL_STATE", "当前会话没有 Goal 状态，无法记录 checkpoint", undefined, false);
        }
        return { ...current, checkpoint };
      }),
    );
  }

  /* -------------------------------------------------------------- */

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    // 队列本身永不 reject：前一次失败不得阻断后续任务（失败语义由 latch 承担）。
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 记录不可写 latch 并返回该错误（调用方负责 throw）。 */
  private block(code: GoalStateErrorCode, message: string, detail = message): GoalStateError {
    const error = new GoalStateError(code, message, detail, true);
    if (!this.latch) this.latch = error;
    return error;
  }

  private readBranchEntries(): { raw: readonly SessionEntry[]; decoded: SessionEntryRecord[] } {
    let raw: unknown;
    try {
      raw = this.readBranch();
    } catch (error) {
      throw this.block("BRANCH_READ_FAILED", `读取 session 分支失败：${describeError(error)}`, describeError(error));
    }
    let decoded: SessionEntryRecord[];
    try {
      decoded = decodeBranch(raw);
    } catch (error) {
      if (error instanceof GoalStateError) {
        throw this.block(error.code, error.message, error.detail);
      }
      throw this.block("SESSION_STATE_CORRUPT", `session 分支无法解码：${describeError(error)}`, describeError(error));
    }
    return { raw: raw as readonly SessionEntry[], decoded };
  }

  /**
   * 写入前确认当前分支仍属于本实例核验过的业务事实：
   * 已有状态条目时它必须仍在分支上（防 switch/fork/tree 后写入旧事实到新分支）。
   */
  private assertBranchContinuity(branch: readonly SessionEntryRecord[]): void {
    if (this.currentEntryId) {
      if (!branch.some((entry) => entry.id === this.currentEntryId)) {
        throw this.block(
          "SESSION_STATE_DIVERGED",
          `当前分支已不含本实例最后核验的 Goal 状态条目 ${this.currentEntryId}；session 或分支已切换，拒绝写入`,
        );
      }
      return;
    }
    if (branch.some(isGoalStateEntry)) {
      throw this.block(
        "SESSION_STATE_CORRUPT",
        "当前分支已有 Goal 状态条目，但本实例未恢复它；拒绝覆盖既有业务事实",
      );
    }
  }

  private async restoreNow(): Promise<GoalState | null> {
    if (this.latch) throw this.latch;

    const { raw, decoded } = this.readBranchEntries();
    const stateEntry = lastGoalStateEntry(decoded);

    // 本代已核验且仍是分支上最后一条状态 → 复用核验事实，不重复读全文件。
    if (stateEntry && this.current && this.currentEntryId === stateEntry.id && this.verifiedEntryIds.has(stateEntry.id)) {
      this.restored = true;
      return this.current;
    }

    let outcome: RestoreOutcome | null;
    try {
      // 无 Goal 时也走同一入口，确保「文件里有活 Goal 但分支不含它」不被当成不存在。
      outcome = await restoreGoalStateVerified({
        branch: raw,
        sessionId: this.sessionId,
        sessionFile: this.sessionFile ?? undefined,
        readPersistedEntries: this.readPersistedEntries,
      });
    } catch (error) {
      // 恢复失败是真实的存储阻塞：latch 具体原因，后续 assertWritable 与 diagnose 据此上报。
      if (error instanceof GoalStateError) {
        throw this.block(error.code, error.message, error.detail);
      }
      throw this.block("SESSION_STATE_CORRUPT", `恢复失败：${describeError(error)}`, describeError(error));
    }

    this.current = outcome ? outcome.state : null;
    this.currentEntryId = outcome ? outcome.stateEntryId : null;
    if (outcome) {
      this.verifiedEntryIds.add(outcome.stateEntryId);
      for (const evidenceId of outcome.evidenceEntryIds) this.verifiedEntryIds.add(evidenceId);
    }
    this.restored = true;
    return this.current;
  }

  /**
   * 提交一次状态转换。
   *
   * `expectedRevision === null` 表示由本方法在队列内读取当前 revision（checkpoint 用）。
   */
  private async commit(expectedRevision: number | null, change: GoalStateChange): Promise<GoalState> {
    this.assertWritable();
    const current = this.current;
    const baselineRevision = current ? current.revision : 0;
    if (expectedRevision !== null && expectedRevision !== baselineRevision) {
      fail(
        "REVISION_CONFLICT",
        `期望 revision ${expectedRevision} 与当前 revision ${baselineRevision} 不一致，请重新读取状态后重试`,
        undefined,
        false,
      );
    }
    if (!current && expectedRevision === null) {
      fail("NO_GOAL_STATE", "当前会话没有 Goal 状态，无法提交该转换", undefined, false);
    }

    let produced: GoalState;
    try {
      // current 已深度冻结：change 必须返回新对象，原地改写会直接抛错。
      produced = decodeGoalStateSnapshot(change(current));
    } catch (error) {
      // change 的产物属于调用方入参，不是读盘事实：统一归为非 blocking 的拒绝。
      throw asCallerError("INVALID_STATE_CHANGE", error);
    }

    this.assertImmutableIdentity(current, produced);
    const next = deepFreeze({ ...produced, revision: baselineRevision + 1 });
    const { entryId } = await this.appendVerified(GOAL_STATE_CUSTOM_TYPE, next);
    this.current = next;
    this.currentEntryId = entryId;
    this.verifiedEntryIds.add(entryId);
    return next;
  }

  /**
   * 本代内不可变身份：planId、binding 与契约语义 hash。
   * v1 不支持原地 amendment；契约变化必须由用户 cancel 后重新授权。
   */
  private assertImmutableIdentity(current: GoalState | null, produced: GoalState): void {
    if (current) {
      if (produced.planId !== current.planId) {
        fail("INVALID_STATE_CHANGE", "禁止修改 planId（v1 只允许一个活跃计划）", undefined, false);
      }
      if (canonicalJson(produced.binding) !== canonicalJson(current.binding)) {
        fail(
          "INVALID_STATE_CHANGE",
          "禁止修改 plan binding（sessionFile/contractHash 由 Host 与契约决定）",
          undefined,
          false,
        );
      }
      if (hashPlanContract(produced.contract) !== hashPlanContract(current.contract)) {
        fail(
          "INVALID_STATE_CHANGE",
          "禁止修改契约内容（v1 不支持原地 amendment；契约漂移时必须先暂停并重新授权）",
          undefined,
          false,
        );
      }
      return;
    }

    // 首次写入（bootstrap）：必须先具备与 Host session 一致的 binding。
    if (produced.binding.sessionId !== this.sessionId) {
      throw this.block(
        "SESSION_STATE_FOREIGN",
        `新状态的 binding.sessionId(${produced.binding.sessionId}) 与当前 session(${this.sessionId}) 不一致，拒绝写入`,
      );
    }
    if (!this.sessionFile) {
      throw this.block(
        "SESSION_FILE_UNAVAILABLE",
        "当前 session 没有持久文件（--no-session/内存会话不支持 Goal），无法首次写入状态",
      );
    }
    if (normalizeSessionFile(produced.binding.sessionFile) !== this.sessionFile) {
      throw this.block(
        "SESSION_STATE_FOREIGN",
        "新状态的 binding.sessionFile 与当前 session 文件不一致，拒绝写入",
      );
    }
  }

  private async writeEvidenceNow(evidence: GoalCheckEvidence): Promise<{ entryId: string }> {
    this.assertWritable();
    const current = this.current;
    if (!current) {
      fail("NO_GOAL_STATE", "当前会话没有 Goal 状态，拒绝写入检查证据", undefined, false);
    }
    if (evidence.sessionId !== this.sessionId) {
      fail(
        "SESSION_STATE_FOREIGN",
        `证据的 sessionId(${evidence.sessionId}) 与当前 session(${this.sessionId}) 不一致`,
        undefined,
        false,
      );
    }
    if (evidence.contractHash !== current.binding.contractHash) {
      fail(
        "INVALID_EVIDENCE",
        "证据的 contractHash 与当前契约不一致（旧契约证据不得写入当前状态）",
        undefined,
        false,
      );
    }
    assertSubjectBinding(evidence.subjectBefore, current.binding, "$evidence.subjectBefore");
    assertSubjectBinding(evidence.subjectAfter, current.binding, "$evidence.subjectAfter");
    const knownCheckIds = new Set(current.contract.checks.map((check) => check.id));
    const checkCommandById = new Map(current.contract.checks.map((check) => [check.id, check.command]));
    evidence.results.forEach((result, index) => {
      if (!knownCheckIds.has(result.checkId)) {
        fail(
          "INVALID_EVIDENCE",
          `证据 results[${index}] 的 checkId ${result.checkId} 不在当前契约内`,
          undefined,
          false,
        );
      }
      // 证据里的命令必须逐字等于契约命令：不允许调用方自带/篡改命令。
      if (canonicalJson(result.command) !== canonicalJson(checkCommandById.get(result.checkId))) {
        fail(
          "INVALID_EVIDENCE",
          `证据 results[${index}] 的命令与契约中检查 ${result.checkId} 的命令不一致`,
          undefined,
          false,
        );
      }
    });

    const { decoded } = this.readBranchEntries();
    this.assertBranchContinuity(decoded);
    const duplicated = decoded.some(
      (entry) =>
        isEvidenceEntry(entry) &&
        entry.data !== null &&
        typeof entry.data === "object" &&
        (entry.data as Record<string, unknown>).evidenceId === evidence.evidenceId,
    );
    if (duplicated) {
      fail(
        "INVALID_EVIDENCE",
        `证据 ID ${evidence.evidenceId} 在当前分支已存在；证据 ID 必须唯一`,
        undefined,
        false,
      );
    }

    const { entryId } = await this.appendVerified(GOAL_CHECK_EVIDENCE_CUSTOM_TYPE, evidence);
    this.verifiedEntryIds.add(entryId);
    return { entryId };
  }

  /**
   * 串行追加一条 custom entry：append → 在当前 branch 唯一定位条目 ID → 同一 session 文件核验。
   * 任一步失败即设置不可写 latch 并抛出；此时不发布任何新事实。
   */
  private async appendVerified(customType: string, payload: unknown): Promise<{ entryId: string }> {
    const expectedHash = payloadHash(payload);
    const before = this.readBranchEntries();
    this.assertBranchContinuity(before.decoded);
    const beforeIds = new Set(before.decoded.map((entry) => entry.id));

    try {
      this.appendEntry(customType, payload);
    } catch (error) {
      // Pi 1.4 可能已在抛错前更新内存索引，因此一律 latch，不做补偿写入。
      throw this.block(
        "APPEND_FAILED",
        `写入 session 条目 ${customType} 失败：${describeError(error)}；本实例已停止写入`,
        describeError(error),
      );
    }

    const after = this.readBranchEntries();
    const candidates = after.decoded.filter((entry) => {
      if (entry.customType !== customType || beforeIds.has(entry.id)) return false;
      // 其他 extension 的新条目可能含无法 JSON 序列化的 data；它不可能与本条 payload 同摘要。
      try {
        return payloadHash(entry.data) === expectedHash;
      } catch {
        return false;
      }
    });
    if (candidates.length === 0) {
      throw this.block(
        "ENTRY_NOT_FOUND",
        `append ${customType} 返回后无法在当前分支定位本次写入；分支事实与写入结果不一致`,
      );
    }
    if (candidates.length > 1) {
      throw this.block(
        "ENTRY_AMBIGUOUS",
        `append ${customType} 返回后当前分支匹配到 ${candidates.length} 条候选条目，拒绝猜测真实身份`,
      );
    }

    const entry = candidates[0];
    await this.confirmPersisted(entry, customType, expectedHash);
    return { entryId: entry.id };
  }

  /** 读同一 session 文件确认该条目已落盘（id/customType/内容/父链）。 */
  private async confirmPersisted(
    entry: SessionEntryRecord,
    customType: string,
    expectedHash: string,
  ): Promise<void> {
    const sessionFile = this.sessionFile;
    if (!sessionFile) {
      throw this.block(
        "SESSION_FILE_UNAVAILABLE",
        "无法确认写盘：当前 session 没有持久文件（--no-session/内存会话不支持 Goal）",
      );
    }
    let entries: readonly FileEntry[];
    try {
      entries = await this.readPersistedEntries(sessionFile);
    } catch (error) {
      if (error instanceof GoalStateError) {
        throw this.block(error.code, error.message, error.detail);
      }
      throw this.block(
        "SESSION_FILE_UNREADABLE",
        `无法读取 session 文件确认写盘：${sessionFile}`,
        describeError(error),
      );
    }

    let disk: SessionDiskIndex;
    try {
      disk = indexSessionFile(entries);
    } catch (error) {
      if (error instanceof GoalStateError) {
        throw this.block(error.code, error.message, error.detail);
      }
      throw this.block("SESSION_FILE_UNREADABLE", `session 文件无法解码：${describeError(error)}`, describeError(error));
    }
    if (!disk.header) {
      throw this.block(
        "SESSION_STATE_NOT_PERSISTED",
        `session 文件 ${sessionFile} 尚无 header：本次写入并未落盘`,
      );
    }
    if (disk.header.id !== this.sessionId) {
      throw this.block(
        "SESSION_STATE_FOREIGN",
        `session 文件 header 的 sessionId(${disk.header.id}) 与当前 session(${this.sessionId}) 不一致`,
      );
    }
    try {
      assertPersistedRecord(disk, entry, customType, expectedHash);
    } catch (error) {
      if (error instanceof GoalStateError) {
        throw this.block(error.code, error.message, error.detail);
      }
      throw this.block(
        "SESSION_STATE_NOT_PERSISTED",
        `写入 ${customType} 后无法在 session 文件中确认条目 ${entry.id}`,
        describeError(error),
      );
    }
  }
}

/**
 * 创建一个与会话串行绑定的状态 store。
 *
 * 契约要点：
 * - 所有写入经同一短 Promise 队列串行；提交前校验 expectedRevision。
 * - append 返回且 branch 身份 + 同一 session 文件持久化都核验通过后才发布新快照。
 * - append/核验失败设置不可写 latch，后续 `assertWritable()` 拒绝业务副作用。
 * - 不创建第二状态文件、全局 registry 或进程锁；不调用 SessionManager 私有写方法。
 */
export function createGoalStateStore(input: CreateGoalStateStoreInput): GoalStateStore {
  return new GoalStateStoreImpl(input);
}
