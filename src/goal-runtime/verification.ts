/**
 * Goal Runtime v1：Host 运行的候选捕获、真实检查执行与全候选证据失效。
 *
 * 权威来源：`docs/plans/2026-10-26-goal-runtime-v1.md` §5.3 与 Task T5。
 *
 * 边界：
 * - 只执行契约内已冻结的检查；命令文本只由契约的 executable/args 与 repository root 经
 *   POSIX shell quoting 组成，调用方不能覆盖 command、passed 或 evidence。
 * - 检查命令一律经 `ctx.executeTool("bash", {command,timeout}, {signal})` 走原工具入口
 *   （hooks、权限、嵌套记录），不直接 spawn 检查命令、不使用旧签名、不传 bash schema
 *   中不存在的 `cwd`，也不读 `details.exit_code`，只以 `structuredContent.exit_code` 取证。
 * - 每批只在前、后各捕获一次候选；批内发生任何候选漂移则整批 stale。
 * - 证据经注入的 `writeEvidence` 落到 session custom entry；未拿到非空 entryId 时不发布
 *   任何 passed 结果（append 未确认即 blocked）。
 * - 原始 tool outcome 原样保存在证据里，输出摘要按结构化完整输出计算，不为 UI 精简改写。
 * - 不持有全局验证锁、不 import T2 实现；检查结束后由调用方立即重算 ready set。
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type { Stats } from "node:fs";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  hashPlanContract,
  type CaptureSubject,
  type CheckReceipt,
  type GoalCheck,
  type GoalCheckEvidence,
  type GoalSubject,
  type PlanBinding,
  type PlanContract,
  type VerifyChecks,
} from "./contract.ts";
import { isMultiRepositoryBinding } from "./repository-resolution.ts";

/* ------------------------------------------------------------------ */
/* 拒绝诊断                                                            */
/* ------------------------------------------------------------------ */

/** 检查批次的准入错误码；调用方按 code 决定 blocked 文案，不匹配错误文本。 */
export type VerificationErrorCode =
  | "INVALID_INPUT"
  | "UNKNOWN_CHECK"
  | "DUPLICATE_CHECK"
  | "INVALID_CHECK_COMMAND"
  | "CONTRACT_HASH_MISMATCH"
  | "SESSION_MISMATCH"
  | "SUBJECT_GIT_FAILED"
  | "SUBJECT_NOT_REPOSITORY"
  | "SUBJECT_ROOT_MISMATCH"
  | "SUBJECT_UNAVAILABLE";

/**
 * 验证准入失败：这些情形下不执行命令、不写证据，也不返回可被当成通过的回执。
 *
 * 候选漂移、命令失败、命令超时/中断、证据 append 未确认不属于准入错误，
 * 它们通过 `CheckReceipt.outcome` 的 `stale`/`failed`/`blocked` 表达。
 */
export class VerificationError extends Error {
  readonly code: VerificationErrorCode;

  constructor(code: VerificationErrorCode, message: string) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 单独成函数：避免控制流收窄把后续 `signal?.aborted` 判成恒 false。 */
function isAborted(ctx: ExtensionToolContext): boolean {
  return ctx.signal?.aborted === true;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/** 唯一候选比较：旧三字段逐项相等，多仓库按身份定位成员差异。 */
export function compareSubjects(left: GoalSubject | null | undefined, right: GoalSubject | null | undefined): { equal: boolean; driftedRepoIds: string[] } {
  if (!left || !right) return { equal: false, driftedRepoIds: [] };
  const leftMulti = "kind" in left;
  const rightMulti = "kind" in right;
  if (leftMulti || rightMulti) {
    const before = new Map(leftMulti ? left.repositories.map(member => [member.repoId, member]) : []);
    const after = new Map(rightMulti ? right.repositories.map(member => [member.repoId, member]) : []);
    const driftedRepoIds = [...new Set([...before.keys(), ...after.keys()])].sort()
      .filter(repoId => !compareSubjects(before.get(repoId), after.get(repoId)).equal);
    return { equal: leftMulti && rightMulti && driftedRepoIds.length === 0, driftedRepoIds };
  }
  return { equal: typeof left.repositoryRoot === "string" && typeof left.head === "string"
    && typeof left.contentHash === "string" && left.repositoryRoot === right.repositoryRoot
    && left.head === right.head && left.contentHash === right.contentHash, driftedRepoIds: [] };
}

/** 仅访问 binding 固定参与根；单仓库直接走 v1 原语，超级根不执行 Git。 */
export async function captureBindingSubject(binding: PlanBinding, capture: CaptureSubject = captureSubject): Promise<GoalSubject> {
  if (!isMultiRepositoryBinding(binding)) return capture(binding.repositoryRoot);
  const repositories = [];
  for (const repository of [...binding.repositories].sort((a, b) => a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : 0)) {
    try { repositories.push({ repoId: repository.repoId, ...await capture(repository.root) }); }
    catch (error) {
      throw new VerificationError("SUBJECT_UNAVAILABLE", `仓库 ${repository.repoId} 候选捕获失败：${describeError(error)}`);
    }
  }
  return { kind: "multi-repository", repositories };
}

/* ------------------------------------------------------------------ */
/* 候选捕获：Git 路径清单 + 内容指纹                                    */
/* ------------------------------------------------------------------ */

/** Git 只读调用的超时；超时按捕获失败处理，不返回半份候选。 */
const GIT_TIMEOUT_MS = 120_000;
/** 路径清单上限（`git ls-files -z` 输出），超限视为仓库异常而不是悄悄截断。 */
const GIT_MAX_BUFFER_BYTES = 128 * 1024 * 1024;
/** 内容摘要并发度：本地读取，保持确定性排序而不阻塞事件循环。 */
const FILE_HASH_CONCURRENCY = 16;

type GitInvocation = { code: number | null; stdout: string; stderr: string };

/**
 * 只读 Git 调用（plumbing）。
 *
 * `captureSubject` 的签名没有 `ctx`，因此这里直接执行 git；它只读取仓库元数据与索引，
 * 绝不执行契约检查命令，也不写入工作区内容（`GIT_OPTIONAL_LOCKS=0` 避免索引锁刷新
 * 改变候选）。检查命令仍然只经 `ctx.executeTool` 原入口执行。
 */
async function runGit(repositoryRoot: string, args: readonly string[]): Promise<GitInvocation> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    LC_ALL: "C",
  };
  const file = "git";
  const argv = ["--no-optional-locks", "-C", repositoryRoot, ...args];
  return await new Promise<GitInvocation>((resolve, reject) => {
    execFile(
      file,
      argv,
      {
        env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const rawCode: unknown = (error as NodeJS.ErrnoException).code;
        if (typeof rawCode === "number") {
          // 非 0 退出码是 git 的正常答复（例如 HEAD 尚未产生），由调用点判定。
          resolve({ code: rawCode, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        reject(
          new VerificationError(
            "SUBJECT_GIT_FAILED",
            `无法运行 git（${rawCode === undefined ? "unknown" : String(rawCode)}）：${error.message}`,
          ),
        );
      },
    );
  });
}

type SubjectEntry = {
  /** 条目类型：file / symlink / directory / missing / special / unreadable / outside。 */
  type: string;
  path: string;
  /** 文件为内容摘要；符号链接为 link target 原文；其余为稳定标记。 */
  digest: string;
};

/** Git 路径必须是仓库内相对路径；越界、绝对路径和 `..` 段一律拒绝。 */
function assertRelativeGitPath(relativePath: string): void {
  if (!isNonEmptyString(relativePath)) {
    throw new VerificationError("SUBJECT_UNAVAILABLE", "Git 返回了空路径，无法建立候选指纹");
  }
  if (relativePath.includes("\u0000") || isAbsolute(relativePath)) {
    throw new VerificationError("SUBJECT_UNAVAILABLE", `Git 返回了非相对路径：${JSON.stringify(relativePath)}`);
  }
  if (relativePath.split("/").some((segment) => segment === "..")) {
    throw new VerificationError("SUBJECT_UNAVAILABLE", `Git 返回了越界路径：${JSON.stringify(relativePath)}`);
  }
}

/** 物理路径必须仍在（已 realpath 的）仓库根内，用于拒绝经目录跳转读到仓库外的文件。 */
function isWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** 流式摘要文件内容；只保存摘要，不缓存内容，也不把内容带出本函数。 */
async function hashFileContent(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

/**
 * 描述单个候选路径。
 *
 * - 删除：索引里仍有条目但工作区已不存在 → `missing`（rename 的源侧同样表现为 missing）；
 * - rename：旧路径消失/新路径出现都会改变路径清单与内容指纹，无需额外启发式；
 * - 符号链接：`lstat` + `readlink` 只记录 link target，绝不 follow，也绝不读取目标内容；
 * - 常规文件：先 realpath 校验仍在仓库内，再流式取内容摘要；
 * - 其它（子模块目录、fifo/device 等）：只记录类型标记，不递归、不读取。
 */
async function describeSubjectPath(rootReal: string, relativePath: string): Promise<SubjectEntry> {
  assertRelativeGitPath(relativePath);
  const absolutePath = join(rootReal, relativePath);

  let stats: Stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return { type: "missing", path: relativePath, digest: "absent" };
    }
    return { type: "unreadable", path: relativePath, digest: isErrno(error, "EACCES") ? "eacces" : "error" };
  }

  if (stats.isSymbolicLink()) {
    try {
      return { type: "symlink", path: relativePath, digest: await readlink(absolutePath) };
    } catch (error) {
      return { type: "symlink", path: relativePath, digest: `unreadable:${isErrno(error, "EACCES") ? "eacces" : "error"}` };
    }
  }
  if (stats.isDirectory()) {
    // 子模块 / gitlink：只标记目录存在，不递归进入，避免越出仓库边界。
    return { type: "directory", path: relativePath, digest: "" };
  }
  if (!stats.isFile()) {
    return { type: "special", path: relativePath, digest: "" };
  }

  let physicalPath: string;
  try {
    physicalPath = await realpath(absolutePath);
  } catch (error) {
    return { type: "unreadable", path: relativePath, digest: isErrno(error, "EACCES") ? "eacces" : "error" };
  }
  if (!isWithinRoot(rootReal, physicalPath)) {
    // 防御目录被替换成越界链接：只记录标记，不读取仓库外文件内容。
    return { type: "outside", path: relativePath, digest: "" };
  }

  let contentDigest: string;
  try {
    contentDigest = await hashFileContent(physicalPath);
  } catch (error) {
    return { type: "unreadable", path: relativePath, digest: isErrno(error, "EACCES") ? "eacces" : "error" };
  }
  return { type: "file", path: relativePath, digest: contentDigest };
}

/** 小并发映射；保持输入顺序，结果确定。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 捕获候选版本：HEAD + 「Git 列出的 tracked 与未忽略 untracked 路径」的统一内容指纹。
 *
 * 只保存摘要，不保存文件内容；忽略规则沿用仓库既有 `.gitignore`（runtime 私有文件不进入
 * 交付候选），不修改 `.gitignore`，也不在仓库内写任何输出日志。
 */
export const captureSubject: CaptureSubject = async (repositoryRoot) => {
  if (!isNonEmptyString(repositoryRoot)) {
    throw new VerificationError("SUBJECT_UNAVAILABLE", "候选捕获需要非空的 repositoryRoot");
  }

  let rootReal: string;
  try {
    rootReal = await realpath(repositoryRoot);
  } catch (error) {
    throw new VerificationError(
      "SUBJECT_UNAVAILABLE",
      `无法解析 repositoryRoot：${repositoryRoot}（${describeError(error)}）`,
    );
  }

  const toplevel = await runGit(rootReal, ["rev-parse", "--show-toplevel"]);
  if (toplevel.code !== 0) {
    throw new VerificationError(
      "SUBJECT_NOT_REPOSITORY",
      `repositoryRoot 不是可用的 Git 仓库：${rootReal}（${toplevel.stderr.trim() || `exit ${String(toplevel.code)}`}）`,
    );
  }
  let toplevelReal: string;
  try {
    toplevelReal = await realpath(toplevel.stdout.trim());
  } catch (error) {
    throw new VerificationError("SUBJECT_UNAVAILABLE", `无法解析 Git 顶层目录：${describeError(error)}`);
  }
  if (toplevelReal !== rootReal) {
    // 候选必须覆盖整个交付仓库；子目录候选会漏掉其它路径的变化。
    throw new VerificationError(
      "SUBJECT_ROOT_MISMATCH",
      `repositoryRoot 必须是仓库根：传入 ${rootReal}，Git 顶层为 ${toplevelReal}`,
    );
  }

  const headResult = await runGit(rootReal, ["rev-parse", "--verify", "HEAD"]);
  if (headResult.code === null) {
    throw new VerificationError("SUBJECT_GIT_FAILED", "git rev-parse --verify HEAD 未返回退出码");
  }
  // 空仓库（unborn HEAD）没有 commit：记为 ""，与「有 commit」明确区分。
  const head = headResult.code === 0 ? headResult.stdout.trim() : "";

  const listed = await runGit(rootReal, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listed.code !== 0) {
    throw new VerificationError(
      "SUBJECT_UNAVAILABLE",
      `无法列出候选路径（exit ${String(listed.code)}）：${listed.stderr.trim()}`,
    );
  }

  const paths = Array.from(
    new Set(listed.stdout.split("\u0000").filter((entry) => entry !== "")),
  ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const entries = await mapWithConcurrency(paths, FILE_HASH_CONCURRENCY, (relativePath) =>
    describeSubjectPath(rootReal, relativePath),
  );

  const digest = createHash("sha256");
  digest.update("goal-runtime.subject.v1\n", "utf8");
  digest.update(`${entries.length}\n`, "utf8");
  for (const entry of entries) {
    // 用 JSON 数组编码单行，避免路径中的 tab/换行造成歧义。
    digest.update(`${JSON.stringify([entry.type, entry.path, entry.digest])}\n`, "utf8");
  }

  return {
    repositoryRoot: rootReal,
    head,
    contentHash: digest.digest("hex"),
  };
};

/* ------------------------------------------------------------------ */
/* 检查批次                                                            */
/* ------------------------------------------------------------------ */

type ToolCallOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

type CheckRun = {
  check: GoalCheck;
  /** 原始 outcome 原样保留；未执行时为 null。 */
  toolOutcome: ToolCallOutcome | null;
  blockedReason: string | null;
  exitCode: number | null;
  passed: boolean;
  outputHash: string;
};

/** POSIX shell 单词引用：只放行无需转义的安全字符，其余整体单引号包裹。 */
function shellQuote(token: string): string {
  if (token === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/**
 * 组成固定命令文本：`cd -- <repository root> && <executable> <args...>`。
 *
 * 所有片段都经 shell quoting；不引入调用方可控的额外命令、不传 cwd 参数
 * （bash 工具 schema 只有 `command`/`timeout`）。
 */
function composeCheckCommand(repositoryRoot: string, command: GoalCheck["command"]): string {
  const argv = [command.executable, ...command.args].map(shellQuote).join(" ");
  return `cd -- ${shellQuote(repositoryRoot)} && ${argv}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 从 tool result 的模型可见文本取回退摘要（仅用于 outputHash，不参与通过判定）。 */
function resultContentText(outcome: ToolCallOutcome): string {
  const content: unknown = outcome.result?.content;
  if (!Array.isArray(content)) return "";
  const fragments: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    if (record !== null && record.type === "text" && typeof record.text === "string") {
      fragments.push(record.text);
    }
  }
  return fragments.join("\n");
}

/**
 * 以 `structuredContent.exit_code` 取证。
 *
 * `output` 取程序化完整输出（truncation 元数据只描述结构化字段上限），
 * 不读 TUI 投影，也不为展示改写结果。
 */
function readStructuredOutcome(outcome: ToolCallOutcome): { exitCode: number | null; output: string } {
  const structured = asRecord(outcome.result?.structuredContent);
  const rawExit = structured?.exit_code;
  const exitCode = typeof rawExit === "number" && Number.isFinite(rawExit) ? rawExit : null;
  const rawOutput = structured?.output;
  if (typeof rawOutput === "string") return { exitCode, output: rawOutput };
  return { exitCode, output: resultContentText(outcome) };
}

function blockedRun(check: GoalCheck, reason: string, outputHashSource: string): CheckRun {
  return {
    check,
    toolOutcome: null,
    blockedReason: reason,
    exitCode: null,
    passed: false,
    outputHash: hashText(outputHashSource),
  };
}

/** 执行单条检查；任何「不是完整、非错误、exit_code 为 0」的结果都不算 passed。 */
async function runCheck(
  check: GoalCheck,
  repositoryRoot: string,
  ctx: ExtensionToolContext,
): Promise<CheckRun> {
  if (isAborted(ctx)) {
    return blockedRun(check, "调用已中断，未执行命令", `aborted:${check.id}`);
  }

  const shellCommand = composeCheckCommand(repositoryRoot, check.command);
  let outcome: ToolCallOutcome;
  try {
    // Pi 1.4 真实签名：签名档位为 (name, args, {signal})；bash schema 只有 command/timeout。
    outcome = await ctx.executeTool(
      "bash",
      { command: shellCommand, timeout: check.command.timeoutSeconds },
      ctx.signal === undefined ? undefined : { signal: ctx.signal },
    );
  } catch (error) {
    // executeTool 合同上不因工具失败 reject；这里只防御实现异常。
    return blockedRun(check, `工具调用异常：${describeError(error)}`, `execute-error:${describeError(error)}`);
  }

  const { exitCode, output } = readStructuredOutcome(outcome);
  const outputHash = hashText(output);
  const toolReportedError = outcome.isError === true || outcome.result?.isError === true;

  if (isAborted(ctx)) {
    return {
      check,
      toolOutcome: outcome,
      blockedReason: "命令执行期间调用被中断",
      exitCode,
      passed: false,
      outputHash,
    };
  }
  if (exitCode === null) {
    // 超时、中断、permission block 与抛错结果都没有 structured exit code：一律不通过。
    return {
      check,
      toolOutcome: outcome,
      blockedReason: `缺少 structuredContent.exit_code（${resultContentText(outcome).split("\n")[0] ?? ""}）`,
      exitCode: null,
      passed: false,
      outputHash,
    };
  }
  if (toolReportedError && exitCode === 0) {
    return {
      check,
      toolOutcome: outcome,
      blockedReason: "工具报告错误但 exit_code 为 0，结果不一致",
      exitCode,
      passed: false,
      outputHash,
    };
  }
  const passed = exitCode === 0 && !toolReportedError;
  return {
    check,
    toolOutcome: outcome,
    blockedReason: null,
    exitCode,
    passed,
    outputHash,
  };
}

/** 契约内的检查解析：只接受契约已有 check ID，拒绝未知/重复 ID。 */
function resolveChecks(contract: PlanContract, checkIds: readonly string[]): GoalCheck[] {
  const checks = contract.checks ?? [];
  const byId = new Map<string, GoalCheck>();
  for (const check of checks) byId.set(check.id, check);

  const selected: GoalCheck[] = [];
  const seen = new Set<string>();
  for (const checkId of checkIds) {
    if (!isNonEmptyString(checkId)) {
      throw new VerificationError("INVALID_INPUT", "checkIds 不能包含空值");
    }
    if (seen.has(checkId)) {
      throw new VerificationError("DUPLICATE_CHECK", `checkIds 重复：${checkId}`);
    }
    seen.add(checkId);
    const check = byId.get(checkId);
    if (check === undefined) {
      throw new VerificationError("UNKNOWN_CHECK", `契约内不存在检查：${checkId}`);
    }
    const command = check.command;
    if (
      command === undefined ||
      !isNonEmptyString(command.executable) ||
      !Array.isArray(command.args) ||
      command.args.some((arg) => typeof arg !== "string") ||
      typeof command.timeoutSeconds !== "number" ||
      !Number.isFinite(command.timeoutSeconds) ||
      command.timeoutSeconds <= 0
    ) {
      throw new VerificationError("INVALID_CHECK_COMMAND", `检查 ${checkId} 的命令不完整或不合法`);
    }
    selected.push(check);
  }
  return selected;
}

function copyCheckCommand(command: GoalCheck["command"]): GoalCheck["command"] {
  return { executable: command.executable, args: [...command.args], timeoutSeconds: command.timeoutSeconds };
}

function makeReceipt(input: {
  run: CheckRun;
  contractHash: string;
  subject: GoalSubject;
  toolCallId: string;
  outcome: CheckReceipt["outcome"];
  resultRef: string;
}): CheckReceipt {
  return {
    checkId: input.run.check.id,
    contractHash: input.contractHash,
    subject: { ...input.subject },
    command: copyCheckCommand(input.run.check.command),
    outcome: input.outcome,
    exitCode: input.run.exitCode,
    toolCallId: input.toolCallId,
    resultRef: input.resultRef,
    outputHash: input.run.outputHash,
  };
}

/**
 * 执行一批契约内检查并返回真实回执。
 *
 * 顺序：
 * 1. 准入校验（check ID、contractHash、session、bash 可用、命令完整）；
 * 2. 捕获 subjectBefore；
 * 3. 逐条经 `ctx.executeTool("bash", …)` 执行；
 * 4. 捕获 subjectAfter；before/after 不一致 → 整批 stale；
 * 5. 生成 `GoalCheckEvidence` 交注入 writer，拿到 entryId 后才可能提交 passed；
 * 6. 用 entryId 形成回执。append 未确认（抛错/空 ID）→ 全部 blocked，无 passed。
 *
 * 准入失败（未知 check、旧契约、session 不符等）直接抛 `VerificationError`：
 * 不执行命令、不写证据、不返回可被当成通过的回执。
 */
export const verifyChecks: VerifyChecks = async ({ contract, binding, checkIds, toolCallId, ctx, writeEvidence }) => {
  if (!isNonEmptyString(toolCallId)) {
    throw new VerificationError("INVALID_INPUT", "verifyChecks 需要非空的父 plan_verify toolCallId");
  }
  if (binding === null || typeof binding !== "object") {
    throw new VerificationError("INVALID_INPUT", "verifyChecks 需要 PlanBinding");
  }
  if (!isNonEmptyString(binding.repositoryRoot)) {
    throw new VerificationError("INVALID_INPUT", "PlanBinding.repositoryRoot 不能为空");
  }
  if (!isNonEmptyString(binding.sessionFile)) {
    throw new VerificationError("INVALID_INPUT", "PlanBinding.sessionFile 不能为空，无法确认证据落点");
  }
  if (!Array.isArray(checkIds)) {
    throw new VerificationError("INVALID_INPUT", "checkIds 必须是数组");
  }

  const selected = resolveChecks(contract, checkIds);
  if (selected.length === 0) {
    // 契约允许任务级 checks 为空；空批次不产生证据，也不创造「空集合通过」。
    return [];
  }

  const contractHash = hashPlanContract(contract);
  if (!isNonEmptyString(binding.contractHash) || binding.contractHash !== contractHash) {
    throw new VerificationError(
      "CONTRACT_HASH_MISMATCH",
      `计划契约已变化：binding.contractHash=${String(binding.contractHash)}，当前契约 hash=${contractHash}；旧契约不能通过验证`,
    );
  }

  const sessionId = ctx.sessionManager.getSessionId();
  if (!isNonEmptyString(binding.sessionId) || binding.sessionId !== sessionId) {
    throw new VerificationError(
      "SESSION_MISMATCH",
      `证据必须落在绑定的 session：binding.sessionId=${String(binding.sessionId)}，当前 session=${String(sessionId)}`,
    );
  }

  const repositoryRoot = binding.repositoryRoot;
  const bashAvailable = ctx.tools.some((tool) => tool.name === "bash");

  // 每批只捕获一次前态。
  const subjectBefore = await captureBindingSubject(binding);

  let runs: CheckRun[];
  if (!bashAvailable) {
    runs = selected.map((check) => blockedRun(check, "当前工具上下文没有可调用的 bash 工具", `no-bash:${check.id}`));
  } else {
    runs = [];
    for (const check of selected) {
      runs.push(await runCheck(check, repositoryRoot, ctx));
    }
  }

  // 每批只捕获一次后态；捕获失败或前后不一致都不能提交通过。
  let subjectAfter: GoalSubject;
  try {
    subjectAfter = await captureBindingSubject(binding);
  } catch (error) {
    // 无法取得后态就无法证明候选未变：不写证据、不发布 passed。
    return selected.map((check, index) =>
      makeReceipt({
        run: runs[index],
        contractHash,
        subject: subjectBefore,
        toolCallId,
        outcome: "blocked",
        resultRef: "",
      }),
    );
  }

  const comparison = compareSubjects(subjectBefore, subjectAfter);
  const drifted = !comparison.equal;

  const evidence: GoalCheckEvidence = {
    evidenceId: randomUUID(),
    sessionId,
    contractHash,
    subjectBefore: { ...subjectBefore },
    subjectAfter: { ...subjectAfter },
    results: runs.map((run) => ({
      checkId: run.check.id,
      command: copyCheckCommand(run.check.command),
      // 原始 outcome 原样保存（含 structuredContent 与 content），不为 UI 精简改写。
      toolOutcome: run.toolOutcome,
      blockedReason: drifted && comparison.driftedRepoIds.length
        ? [run.blockedReason, `候选漂移仓库：${comparison.driftedRepoIds.join("、")}`].filter(Boolean).join("；")
        : run.blockedReason,
    })),
  };

  let entryId: string | null = null;
  try {
    const written = await writeEvidence(evidence);
    if (written !== null && typeof written === "object" && isNonEmptyString(written.entryId)) {
      entryId = written.entryId;
    }
  } catch {
    // append 未确认：保留 blocked，绝不因为命令成功就发布 passed。
    entryId = null;
  }

  return runs.map((run, index) => {
    if (entryId === null) {
      return makeReceipt({
        run,
        contractHash,
        subject: subjectAfter,
        toolCallId,
        outcome: "blocked",
        resultRef: "",
      });
    }
    const resultRef = `${entryId}#${index}`;
    const outcome: CheckReceipt["outcome"] = drifted
      ? "stale"
      : run.passed
        ? "passed"
        : run.blockedReason !== null
          ? "blocked"
          : "failed";
    return makeReceipt({ run, contractHash, subject: subjectAfter, toolCallId, outcome, resultRef });
  });
};

/* ------------------------------------------------------------------ */
/* 当前有效回执判定                                                    */
/* ------------------------------------------------------------------ */

/**
 * 判定这组回执能否代表「当前候选 + 当前契约」的有效通过证据。
 *
 * 任一条件不成立即为 false：回执为空、契约 hash 不同（旧契约）、subject 不同（候选已变）、
 * 缺结果引用（blocked/stale/append 未确认）、非 passed、exitCode 非 0、重复 check ID、
 * 或缺少父 toolCallId。完成判定必须再配合一次新的 `captureSubject`。
 */
export function receiptsAreCurrent(
  receipts: readonly CheckReceipt[],
  subject: GoalSubject,
  contractHash: string,
): boolean {
  if (!Array.isArray(receipts) || receipts.length === 0) return false;
  if (!isNonEmptyString(contractHash)) return false;
  if (subject === null || typeof subject !== "object") return false;

  const seen = new Set<string>();
  for (const receipt of receipts) {
    if (receipt === null || typeof receipt !== "object") return false;
    if (!isNonEmptyString(receipt.checkId) || seen.has(receipt.checkId)) return false;
    seen.add(receipt.checkId);
    if (receipt.contractHash !== contractHash) return false;
    if (receipt.outcome !== "passed") return false;
    if (receipt.exitCode !== 0) return false;
    if (!isNonEmptyString(receipt.resultRef)) return false;
    if (!isNonEmptyString(receipt.toolCallId)) return false;
    if (!compareSubjects(receipt.subject, subject).equal) return false;
  }
  return true;
}
