/**
 * Goal Runtime v1：计划内调度、可信交付接受与受限修复。
 * 外部资源事实只读消费 execution adapter；本模块不处置 workspace、不制造运行回执。
 */
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { PlanExecutionService, PlanLineageResolution, PlanRunFacts, PlanRunRef } from "pi-subagents-enhanced/execution";
import {
  decodePlanContract, hashPlanContract, readPlanContract,
  type CaptureSubject, type CheckReceipt, type GoalCheckpoint, type GoalState,
  type GoalTask, type PlanBinding, type PlanContract, type TaskState, type VerifyChecks,
} from "./contract.ts";
import type { GoalStateStore } from "./session-state.ts";
import { captureBindingSubject, compareSubjects, receiptsAreCurrent } from "./verification.ts";
import { bindingSemanticInput, isMultiRepositoryBinding, resolveTaskRepository } from "./repository-resolution.ts";

/** 以 runId 索引，值保持 adapter 原始事实；不补造缺失字段。 */
export type RunFacts = Readonly<Record<string, PlanRunFacts>>;
export type SchedulingCapacity = { maxConcurrentTasks: number; facts?: RunFacts };
export type NextAction =
  | { kind: "advance"; taskIds: string[] }
  | { kind: "retry"; taskId: string; checkIds: string[]; reason: string }
  | { kind: "verify"; taskId: string | null; checkIds: string[] }
  | { kind: "wait"; taskIds: string[]; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "done" };
export type DispatchResult = {
  taskId: string;
  outcome: "bound" | "not-started" | "unknown";
  run: PlanRunRef | null;
  /** 原异常保留给调用方诊断，不据错误文案推断 spawn 结果。 */
  error?: unknown;
};

const CHECK_FAILED = "检查失败：提供针对性指导后调用 plan_retry";
const CHECK_REVERIFY = "检查受阻或候选漂移：本批已结束，调用 plan_verify 重验";
/** 替换门拒绝文案的统一补充：澄清被拒实例的内存态归属并给出两条处置路径，删除存盘文件不能解锁替换门。 */
const REPLACEMENT_BLOCKED_GUIDANCE = "被拒实例持有于当前会话内存与 session 分支索引，删除存盘文件不影响本会话判定；"
  + "处置路径：① /plan force-close 或 plan_force_close 核实闭合后重新 plan_execute；"
  + "② 若 session 文件已删除，重启会话后旧 goal 随会话消失，可直接重新 plan_execute。";

export class GoalSchedulerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "GoalSchedulerError";
  }
}

function reject(code: string, message: string): never {
  throw new GoalSchedulerError(code, message);
}
function sameRun(a: PlanRunRef | null, b: PlanRunRef | null): boolean {
  return a !== null && b !== null && a.runId === b.runId
    && a.workspaceId === b.workspaceId && a.rootSessionId === b.rootSessionId;
}
function factFor(task: TaskState, facts: RunFacts): PlanRunFacts | undefined {
  const fact = task.run && facts[task.run.runId];
  return fact && sameRun(task.run, fact.run) ? fact : undefined;
}
/**
 * 可选血缘解析：服务未实现 lineage、解析抛错或不可达时一律返回 null（fail-closed，维持现状 blocked）。
 * scheduler 无独立日志通道；异常吞掉后不解读 blocker 文案，重绑只由返回的持久血缘证据授权。
 */
async function resolveLineageRun(execution: PlanExecutionService, ref: PlanRunRef): Promise<PlanLineageResolution | null> {
  if (typeof execution.lineage !== "function") return null;
  try {
    return await execution.lineage(ref);
  } catch {
    return null;
  }
}
/**
 * 按 resume 血缘把 task.run 重绑至最终 run：attempt/dispatchKey/workspaceId 不变，
 * 旧 runId 追加进 supersededRunIds（去重）作为审计线索。
 */
function rebindTaskRun(state: GoalState, taskId: string, run: PlanRunRef): GoalState {
  const task = state.tasks[taskId]!;
  const previousRunIds = task.supersededRunIds ?? [];
  const supersededRunIds = task.run && !previousRunIds.includes(task.run.runId)
    ? [...previousRunIds, task.run.runId]
    : previousRunIds;
  return { ...state, tasks: { ...state.tasks, [taskId]: { ...task, run, supersededRunIds } } };
}
function provedTerminal(fact: PlanRunFacts): boolean {
  return (fact.terminal === "succeeded" || fact.terminal === "failed") && !!fact.terminalProofRef;
}
function integrated(fact: PlanRunFacts): boolean {
  return (fact.integration === "completed" && !!fact.integrationReceiptRef)
    || fact.integration === "not-applicable";
}
/**
 * 主管裁决：这些逐项满足的权威 facts 表示旧 attempt 完全闭合，可经 start 申请新 attempt。
 * not-applicable 必须由 adapter 权威给出；released/status 本身绝不构成交付或重派许可。
 */
function closed(fact: PlanRunFacts): boolean {
  return provedTerminal(fact) && integrated(fact) && fact.workspaceState === "released"
    && fact.recovery === "none" && fact.blocker === null;
}
function delivered(fact: PlanRunFacts): boolean {
  return closed(fact) && fact.terminal === "succeeded";
}
function resumable(fact: PlanRunFacts): boolean {
  // typed-resume 是 adapter 对无 live attempt、owner、proof 与恢复 intent 的合取证明。
  return provedTerminal(fact) && fact.recovery === "typed-resume"
    && fact.workspaceState === "active" && fact.integration === "blocked"
    && fact.blocker === "PLAN_TYPED_RESUME_REQUIRED";
}
function occupied(task: TaskState, facts: RunFacts): boolean {
  if (task.status === "verifying") return true;
  if (task.run) {
    const fact = factFor(task, facts);
    return !fact || !closed(fact);
  }
  // 持久 intent 没有绑定时无法排除 spawn；跨 reload 也保留占用。
  return task.dispatchKey !== null || task.workspaceId !== null || task.status === "running";
}

/** 只计算计划容量；不把本地计数当成 workspace/lease 的权威账本。 */
export function resourceUsage(state: GoalState, facts: RunFacts = {}, excludeTaskId?: string) {
  const resources: Record<string, number> = Object.fromEntries(state.contract.resources.map(r => [r.id, 0]));
  let tasks = 0;
  for (const task of state.contract.tasks) {
    if (task.id === excludeTaskId || !occupied(state.tasks[task.id]!, facts)) continue;
    tasks++;
    for (const id of task.resources) resources[id] = (resources[id] ?? 0) + 1;
  }
  return { tasks, resources };
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) reject("INVALID_CAPACITY", "容量必须是正整数");
  return value;
}
function fits(state: GoalState, task: GoalTask, usage: ReturnType<typeof resourceUsage>, max: number): boolean {
  return usage.tasks < max && task.resources.every(id => {
    const capacity = state.contract.resources.find(r => r.id === id)?.capacity;
    return capacity !== undefined && (usage.resources[id] ?? 0) < capacity;
  });
}
function depsAccepted(state: GoalState, task: GoalTask): boolean {
  return task.deps.every(id => state.tasks[id]?.status === "accepted");
}

/** title-registry 只接受单行、非空、≤256 字节的展示标题，合同以该模块为准。 */
const MAX_DISPATCH_TITLE_BYTES = 256;

/** 折叠控制符与换行为空格并压缩空白；派发标题必须是单行文本。 */
function singleLine(value: string): string {
  return value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/** 按 UTF-8 字节截断且不切断码点，避免超出 title-registry 的字节上界。 */
function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let kept = "";
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    kept += char;
  }
  return kept.trim();
}

/**
 * 派发标题由计划与任务身份派生：`goal-<plan 短号> <taskId>: <task 首个可读片段>`。
 * 任务正文是多行文档，直接切片会带换行并被 title-registry 拒绝（INVALID_TITLE），
 * 见 docs/bugs/2026-10-27-goal-dispatch-multiline-title.md。
 */
function dispatchTitle(state: GoalState, task: GoalTask): string {
  const identity = `goal-${state.planId.slice(0, 8)} ${task.id}`;
  const headline = singleLine(task.task);
  return truncateBytes(headline ? `${identity}: ${headline}` : identity, MAX_DISPATCH_TITLE_BYTES);
}

/** 按契约顺序贪心选取全部兼容任务；无 Wave 屏障。 */
export function readyTasks(state: GoalState, capacity: number | SchedulingCapacity): GoalTask[] {
  const max = positive(typeof capacity === "number" ? capacity : capacity.maxConcurrentTasks);
  const facts = typeof capacity === "number" ? {} : capacity.facts ?? {};
  if (state.status !== "active" || Object.values(state.tasks).some(t => t.status === "verifying")) return [];
  const usage = resourceUsage(state, facts);
  const ready: GoalTask[] = [];
  for (const task of state.contract.tasks) {
    const current = state.tasks[task.id]!;
    if (current.status !== "pending" || occupied(current, facts) || !depsAccepted(state, task)
      || !fits(state, task, usage, max)) continue;
    ready.push(task);
    usage.tasks++;
    for (const id of task.resources) usage.resources[id] = (usage.resources[id] ?? 0) + 1;
  }
  return ready;
}
function latestReceipts(state: GoalState): Map<string, CheckReceipt> {
  return new Map(state.receipts.map(receipt => [receipt.checkId, receipt]));
}
function failedChecks(state: GoalState, taskId: string): string[] {
  const latest = latestReceipts(state);
  return state.contract.checks.filter(check => check.repairTaskIds.includes(taskId)
    && latest.get(check.id)?.outcome === "failed"
    && latest.get(check.id)?.contractHash === state.binding.contractHash).map(check => check.id);
}
function retryRoute(state: GoalState, task: GoalTask, facts: RunFacts): "start" | "resume" | null {
  const current = state.tasks[task.id]!;
  if (!current.run || current.status === "verifying" || !depsAccepted(state, task)) return null;
  const fact = factFor(current, facts);
  if (!fact) return null;
  const checkFailure = failedChecks(state, task.id).length > 0;
  const failedAttempt = fact.terminal === "failed" && (resumable(fact) || closed(fact));
  if (!checkFailure && !failedAttempt) return null;
  if (resumable(fact)) return "resume";
  return closed(fact) ? "start" : null;
}
function allClosed(state: GoalState, facts: RunFacts): boolean {
  return state.contract.tasks.every(task => {
    const current = state.tasks[task.id]!;
    const fact = factFor(current, facts);
    return current.run !== null && !!fact && closed(fact);
  });
}

/** 无 I/O、无 revision 更新；status/context 可重复调用。 */
export function decideNextAction(state: GoalState, facts: RunFacts, maxConcurrentTasks = 2): NextAction {
  if (state.status === "completed") return { kind: "done" };
  if (state.status !== "active") return { kind: "blocked", reason: state.pauseReason ?? `计划处于 ${state.status}` };
  const verifying = state.contract.tasks.find(t => state.tasks[t.id]?.status === "verifying"
    || (state.tasks[t.id]?.blocker === CHECK_REVERIFY && !!factFor(state.tasks[t.id]!, facts)
      && delivered(factFor(state.tasks[t.id]!, facts)!)
      && fits(state, t, resourceUsage(state, facts, t.id), maxConcurrentTasks)));
  if (verifying) return { kind: "verify", taskId: verifying.id, checkIds: [...verifying.checkIds] };
  const ready = readyTasks(state, { maxConcurrentTasks, facts });
  if (ready.length) return { kind: "advance", taskIds: ready.map(t => t.id) };
  for (const task of state.contract.tasks) {
    if (retryRoute(state, task, facts)
      && fits(state, task, resourceUsage(state, facts, task.id), maxConcurrentTasks)) {
      return { kind: "retry", taskId: task.id, checkIds: failedChecks(state, task.id), reason: "提供针对性指导后调用 plan_retry" };
    }
  }
  if (state.contract.tasks.every(t => state.tasks[t.id]?.status === "accepted") && allClosed(state, facts)) {
    const failed = state.contract.terminalCheckIds.some(id => latestReceipts(state).get(id)?.outcome === "failed");
    if (failed) return { kind: "blocked", reason: "终态检查失败，关联任务当前无合法修复路径；核对 adapter facts 与 typed 处置入口" };
    return { kind: "verify", taskId: null, checkIds: [...state.contract.terminalCheckIds] };
  }
  const waiting: string[] = [];
  const blockers: string[] = [];
  for (const task of state.contract.tasks) {
    const current = state.tasks[task.id]!;
    if (!occupied(current, facts) && current.status !== "blocked") continue;
    const fact = factFor(current, facts);
    if (fact && fact.wakeup === "subscribed" && fact.blocker === null && fact.recovery === "none"
      && fact.terminal !== "unknown" && (fact.terminal === "pending" || fact.integration === "pending")) waiting.push(task.id);
    else blockers.push(`${task.id}: ${current.blocker ?? fact?.blocker ?? "运行事实不完整，需 typed status 或人工处置"}`);
  }
  if (blockers.length) return { kind: "blocked", reason: blockers.join("；") };
  if (waiting.length) return { kind: "wait", taskIds: waiting, reason: "等待已订阅的权威运行或集成事实变化" };
  return { kind: "blocked", reason: "没有可执行任务；检查依赖、容量与恢复事实" };
}

/** 只比较成果、候选与有效结论；run/attempt、时间戳、回执 ID 和瞬态状态均不算进展。 */
export function progressFingerprint(state: GoalState): string {
  const checks = [...latestReceipts(state).values()].sort((a, b) => a.checkId.localeCompare(b.checkId)).map(r => ({
    checkId: r.checkId, contractHash: r.contractHash, subject: r.subject,
    outcome: r.outcome, exitCode: r.exitCode,
  }));
  return createHash("sha256").update(JSON.stringify({
    accepted: state.contract.tasks.filter(t => state.tasks[t.id]?.status === "accepted").map(t => t.id).sort(),
    checks,
  })).digest("hex");
}

export type CreateGoalRuntimeInput = {
  store: GoalStateStore;
  execution: PlanExecutionService;
  verify: VerifyChecks;
  captureSubject: CaptureSubject;
  maxConcurrentTasks?: number;
  maxNoProgressTurns?: number;
};

export function createGoalRuntime(input: CreateGoalRuntimeInput) {
  const { store, execution } = input;
  const maxConcurrentTasks = positive(input.maxConcurrentTasks ?? 2);
  const maxNoProgressTurns = positive(input.maxNoProgressTurns ?? 3);
  const facts: Record<string, PlanRunFacts> = {};
  let operation: "advance" | "retry" | "verify" | "force-close" | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let refreshFlight: Promise<RunFacts> | null = null;

  function read(): GoalState {
    const state = store.read();
    if (!state) reject("NO_GOAL_STATE", "当前会话没有已绑定计划");
    return state;
  }
  function assertIdentity(state: GoalState, baseline: GoalState): void {
    if (state.planId !== baseline.planId || state.binding.sessionId !== baseline.binding.sessionId
      || state.binding.sessionFile !== baseline.binding.sessionFile
      || state.binding.contractHash !== baseline.binding.contractHash) reject("STALE_GOAL", "计划或 session 身份已变化");
  }
  function assertContext(ctx: ExtensionToolContext, state: GoalState): void {
    if (ctx.sessionManager.getSessionId() !== state.binding.sessionId
      || ctx.sessionManager.getSessionFile() !== state.binding.sessionFile) reject("SESSION_MISMATCH", "工具上下文不属于已绑定 Host session");
    if (ctx.signal?.aborted) reject("ABORTED", "当前工具已中断");
  }
  function assertTask(state: GoalState, baseline: GoalState, taskId: string): void {
    assertIdentity(state, baseline);
    const current = state.tasks[taskId]!;
    const previous = baseline.tasks[taskId]!;
    if (current.attempt !== previous.attempt || current.dispatchKey !== previous.dispatchKey
      || JSON.stringify(state.contract.tasks.find(t => t.id === taskId)) !== JSON.stringify(baseline.contract.tasks.find(t => t.id === taskId))) {
      reject("STALE_ATTEMPT", "任务 attempt 或原始任务合同已变化");
    }
  }
  // 这里只串行短状态写入；adapter 与命令检查始终在 store 的短队列之外。
  function change(baseline: GoalState, transform: (state: GoalState) => GoalState): Promise<GoalState> {
    const result = writes.then(async () => {
      store.assertWritable();
      const current = read();
      assertIdentity(current, baseline);
      return store.update(current.revision, state => {
        if (!state) reject("NO_GOAL_STATE", "计划状态已消失");
        assertIdentity(state, baseline);
        return transform(state);
      });
    });
    writes = result.catch(() => {});
    return result;
  }
  async function exclusive<T>(kind: NonNullable<typeof operation>, work: () => Promise<T>): Promise<T> {
    if (operation) reject("RUNTIME_BUSY", `正在 ${operation}，等待当前操作结束`);
    operation = kind;
    try { return await work(); } finally { operation = null; }
  }
  async function assertContract(state: GoalState): Promise<void> {
    let matches = false;
    try { matches = (await readPlanContract(state.binding.planPath)).contractHash === state.binding.contractHash; } catch {
      // 读取失败不按旧合同继续派发，也不伪造新合同。
    }
    if (!matches) {
      await change(state, current => ({ ...current, status: "paused", pauseReason: "源契约变化或不可读；处理 live run 后取消旧执行并重新授权" }));
      reject("CONTRACT_CHANGED", "源契约变化或不可读");
    }
  }
  function assertActive(state: GoalState): void {
    store.assertWritable();
    if (state.status !== "active") reject("GOAL_NOT_ACTIVE", "计划已暂停、阻塞或结束");
  }

  async function activate(binding: PlanBinding, contract: PlanContract): Promise<GoalState> {
    store.assertWritable();
    const decoded = decodePlanContract(contract);
    if (hashPlanContract(decoded) !== binding.contractHash) reject("CONTRACT_HASH_MISMATCH", "契约 hash 与 binding 不一致");
    const existing = store.read();
    if (existing) {
      if (JSON.stringify(bindingSemanticInput(existing.binding)) !== JSON.stringify(bindingSemanticInput(binding))) reject("GOAL_ALREADY_BOUND", "当前 store 已绑定其他计划或 session");
      return existing;
    }
    const tasks: Record<string, TaskState> = Object.fromEntries(decoded.tasks.map(task => [task.id, {
      status: "pending", attempt: 0, dispatchKey: null, workspaceId: null, run: null,
      terminalProofRef: null, integrationReceiptRef: null, blocker: null,
    }]));
    const planId = randomUUID();
    return store.update(0, () => ({
      planId, revision: 0, binding, contract: decoded, status: "active", tasks, receipts: [],
      checkpoint: { decisions: [], sourceRefs: [], nextAction: "调用 plan_execute 调度 ready 任务" },
      pauseReason: null, lastProgressHash: "", noProgressTurns: 0,
    }));
  }

  async function replaceCancelled(binding: PlanBinding, contract: PlanContract): Promise<GoalState> {
    return exclusive("advance", async () => {
      store.assertWritable();
      if (refreshFlight) await refreshFlight;
      await writes;
      const baseline = read();
      const decoded = decodePlanContract(contract);
      if (hashPlanContract(decoded) !== binding.contractHash) reject("CONTRACT_HASH_MISMATCH", "契约 hash 与 binding 不一致");
      if (baseline.status !== "cancelled") reject("GOAL_CANCELLED_REPLACEMENT_REQUIRED", "只能替换已取消计划" + ";" + REPLACEMENT_BLOCKED_GUIDANCE);
      for (const task of Object.values(baseline.tasks)) {
        if (!task.run) {
          if (task.dispatchKey || task.workspaceId || task.status === "running") {
            reject("GOAL_CANCELLED_REPLACEMENT_REQUIRED", "取消计划仍有未绑定的启动 intent/workspace，禁止覆盖" + ";" + REPLACEMENT_BLOCKED_GUIDANCE);
          }
          continue;
        }
        // 前置血缘重绑（仅内存态，本函数不持久化——计划即将被整体替换）：
        // 旧 run 被 resume 血缘取代时按最终 run 判闭合；解析失败/未取代时仍按原 run 判。
        let run = task.run;
        const resolution = await resolveLineageRun(execution, run);
        if (resolution?.superseded) run = resolution.run;
        const fact = await execution.inspect(run);
        if (!sameRun(run, fact.run) || !closed(fact)) {
          reject("GOAL_CANCELLED_REPLACEMENT_REQUIRED", "取消计划仍有未闭合运行或资源；须先经 typed 路径处置" + ";" + REPLACEMENT_BLOCKED_GUIDANCE);
        }
      }
      assertIdentity(read(), baseline);
      const tasks: Record<string, TaskState> = Object.fromEntries(decoded.tasks.map(task => [task.id, {
        status: "pending", attempt: 0, dispatchKey: null, workspaceId: null, run: null,
        terminalProofRef: null, integrationReceiptRef: null, blocker: null,
      }]));
      const state = await store.replaceCancelled(baseline.revision, {
        planId: randomUUID(), revision: 0, binding, contract: decoded, status: "active", tasks, receipts: [],
        checkpoint: { decisions: [], sourceRefs: [], nextAction: "调用 plan_execute 调度 ready 任务" },
        pauseReason: null, lastProgressHash: "", noProgressTurns: 0,
      });
      for (const runId of Object.keys(facts)) delete facts[runId];
      return state;
    });
  }

  /** force-close 的两种模式：verified=核实型（plan_force_close typed 工具入口）；manual=盲闭合（/plan force-close 人工确认后）。 */
  async function forceCloseTasks(opts: { mode: "verified" | "manual" }): Promise<GoalState> {
    return exclusive("force-close", async () => {
      store.assertWritable();
      if (refreshFlight) await refreshFlight;
      await writes;
      const baseline = read();
      if (baseline.status !== "cancelled") reject("GOAL_NOT_CANCELLED", "强制闭合仅适用于已取消计划；先经 /plan cancel 取消");
      const closedAt = new Date().toISOString();
      if (opts.mode === "verified") {
        // 模式 A（核实型）：逐任务按 resume 血缘重绑后 inspect(最终 run) 必须 closed；
        // 任一任务不满足即整体拒绝，绝不部分写入。
        const verified: Array<{ taskId: string; finalRun: PlanRunRef }> = [];
        const unclosed: string[] = [];
        for (const task of baseline.contract.tasks) {
          const current = baseline.tasks[task.id]!;
          if (!current.run) {
            if (current.dispatchKey || current.workspaceId || current.status === "running") {
              unclosed.push(`${task.id}（无 run 绑定）: 存在未绑定 run 的启动 intent/workspace，无权威事实可核实`);
            }
            continue;
          }
          let run = current.run;
          const resolution = await resolveLineageRun(execution, run);
          if (resolution?.superseded) run = resolution.run;
          const describe = (reason: string) => `${task.id}（run ${run.runId}）: ${reason}`;
          let fact: PlanRunFacts;
          try { fact = await execution.inspect(run); }
          catch (error) {
            unclosed.push(describe(`权威事实读取失败：${error instanceof Error ? error.message : String(error)}`));
            continue;
          }
          if (!sameRun(run, fact.run)) {
            unclosed.push(describe("最终 run 的 facts 身份不符，拒绝采纳"));
            continue;
          }
          if (!closed(fact)) {
            unclosed.push(describe(`未闭合：terminal=${fact.terminal}、integration=${fact.integration}`
              + `、workspaceState=${fact.workspaceState}、recovery=${fact.recovery}${fact.blocker ? `、blocker=${fact.blocker}` : ""}`));
            continue;
          }
          verified.push({ taskId: task.id, finalRun: run });
        }
        if (unclosed.length) {
          reject("FORCE_CLOSE_VERIFICATION_FAILED", `核实型强制闭合被拒，未做任何写入：${unclosed.join("；")}`
            + "；如确已人工核实闭合，请改走 /plan force-close（人工断言闭合）");
        }
        // 全部通过：经 change() 持久化重绑（仅 superseded 任务）并留 checkpoint 审计痕。
        return change(baseline, state => {
          let next = state;
          for (const { taskId, finalRun } of verified) {
            if (!sameRun(state.tasks[taskId]!.run, finalRun)) next = rebindTaskRun(next, taskId, finalRun);
          }
          return { ...next, checkpoint: {
            decisions: [`force-close verified: closedAt=${closedAt} planId=${baseline.planId}`,
              ...verified.map(({ taskId, finalRun }) => `task ${taskId} 最终 runId=${finalRun.runId}`)],
            sourceRefs: [],
            nextAction: "核实型强制闭合已完成并留痕；重新 plan_execute 绑定新计划",
          } };
        });
      }
      // 模式 B（盲闭合）：人工确认后置空全部 run/intent/workspace 引用；proof/receipt 保留原值，
      // 历史条目不删，仅经 change() 追加。
      return change(baseline, state => {
        const tasks = { ...state.tasks };
        for (const task of state.contract.tasks) {
          const current = tasks[task.id]!;
          const settled = current.status === "accepted" || current.status === "blocked";
          tasks[task.id] = { ...current, run: null, dispatchKey: null, workspaceId: null,
            status: settled ? current.status : "blocked",
            blocker: settled ? current.blocker : "FORCE_CLOSED_BY_ADMIN" };
        }
        return { ...state, tasks, checkpoint: {
          decisions: [`force-close manual: closedAt=${closedAt} planId=${baseline.planId}`,
            ...state.contract.tasks.map(task => `task ${task.id} run/intent/workspace 引用已人工断言闭合并置空`)],
          sourceRefs: [],
          nextAction: "人工盲闭合已完成并留痕；重新 plan_execute 绑定新计划",
        } };
      });
    });
  }

  async function refreshRuns(): Promise<RunFacts> {
    if (refreshFlight) return refreshFlight;
    const flight = (async () => {
      const baseline = read();
      const inspected = await Promise.all(baseline.contract.tasks.map(async task => {
        const previous = baseline.tasks[task.id]!;
        if (!previous.run) return { taskId: task.id, previous, fact: undefined };
        try {
          const fact = await execution.inspect(previous.run);
          if (!sameRun(previous.run, fact.run)) reject("RUN_IDENTITY_MISMATCH", "adapter facts 与请求 run 身份不符");
          // 血缘重绑：仅降级 facts（terminal unknown 且存在 blocker）触发；解析失败、未取代或服务缺失时维持现状 blocked。
          if (fact.terminal === "unknown" && fact.blocker !== null) {
            const resolution = await resolveLineageRun(execution, previous.run);
            if (resolution?.superseded) {
              // 经既有 change()/assertTask 串行化路径持久化重绑；本轮 previous 基线同步为最终 run，
              // 否则 apply 的 previous.run 身份守卫会跳过本轮投影（首轮审阅 S5）。
              const rebound = await change(baseline, current => {
                assertTask(current, baseline, task.id);
                return rebindTaskRun(current, task.id, resolution.run);
              });
              const reboundTask = rebound.tasks[task.id]!;
              const finalFact = await execution.inspect(reboundTask.run!);
              if (!sameRun(reboundTask.run!, finalFact.run)) reject("RUN_IDENTITY_MISMATCH", "adapter facts 与请求 run 身份不符");
              return { taskId: task.id, previous: reboundTask, fact: finalFact };
            }
          }
          return { taskId: task.id, previous, fact };
        } catch {
          return { taskId: task.id, previous, fact: undefined };
        }
      }));
      assertIdentity(read(), baseline);
      for (const { previous, fact } of inspected) {
        if (!previous.run) continue;
        if (fact) facts[previous.run.runId] = fact;
        else delete facts[previous.run.runId];
      }
      const apply = (current: GoalState): GoalState => {
        const tasks = { ...current.tasks };
        for (const { taskId, previous, fact } of inspected) {
          const task = tasks[taskId]!;
          if (task.attempt !== previous.attempt || task.dispatchKey !== previous.dispatchKey
            || JSON.stringify(task.run) !== JSON.stringify(previous.run)) continue;
          if (!task.run) {
            if (task.dispatchKey) tasks[taskId] = { ...task, status: "blocked", blocker: "启动结果不明：intent 尚无权威 run 绑定，禁止重派" };
            continue;
          }
          let status = task.status;
          let blocker = task.blocker;
          if (!fact) { status = "blocked"; blocker = "运行事实读取失败；需要 typed status 核对"; }
          else if (delivered(fact)) {
            if (task.status === "running" || (task.status === "blocked" && task.blocker !== CHECK_FAILED && task.blocker !== CHECK_REVERIFY)) {
              status = current.contract.tasks.find(t => t.id === taskId)!.checkIds.length ? "verifying" : "accepted";
              blocker = null;
            }
          } else if (fact.terminal === "failed" || fact.terminal === "unknown" || fact.blocker !== null) {
            status = "blocked";
            blocker = fact.blocker ?? (fact.terminal === "failed" ? "权威终态确认 attempt 失败；需要 plan_retry 或 typed 处置" : "运行终态未知；禁止重派");
          } else if (task.status !== "accepted" && task.status !== "verifying") {
            status = "running"; blocker = null;
          }
          tasks[taskId] = { ...task, status, blocker, terminalProofRef: fact ? fact.terminalProofRef : task.terminalProofRef,
            integrationReceiptRef: fact ? fact.integrationReceiptRef : task.integrationReceiptRef };
        }
        return { ...current, tasks };
      };
      const current = read();
      const proposed = apply(current);
      // 无事实变化时不推进 revision；持久化失败时仍允许 inspect 提供只读诊断。
      if (JSON.stringify(proposed.tasks) !== JSON.stringify(current.tasks) && store.diagnose().writable) {
        await change(baseline, apply);
      }
      return { ...facts };
    })();
    refreshFlight = flight;
    try { return await flight; } finally { if (refreshFlight === flight) refreshFlight = null; }
  }

  function prompt(state: GoalState, task: GoalTask, guidance?: string): string {
    return [
      "按以下已冻结计划合同执行；不得从父会话历史补充权限。",
      JSON.stringify({ objective: state.contract.objective, constraints: state.contract.constraints,
        task, dependencies: task.deps.map(id => ({ taskId: id, ...state.tasks[id] })),
        evidence: state.receipts.filter(r => task.deps.some(id => state.contract.tasks.find(t => t.id === id)!.checkIds.includes(r.checkId))),
      }, null, 2),
      ...(guidance === undefined ? [] : ["本次修复指导：", guidance]),
      "结束前必须在 worktree 内将全部交付物显式 git add 并 git commit；未提交的 run 终结后集成队列无法发布你的工作。",
    ].join("\n");
  }

  async function dispatch(taskId: string, ctx: ExtensionToolContext, route: "start" | "resume", message?: string, expectedRevision?: number): Promise<DispatchResult> {
    let invoked = false;
    let bound: PlanRunRef | null = null;
    let intent: GoalState | null = null;
    let prior: GoalState | null = null;
    try {
      const baseline = read();
      prior = baseline;
      assertActive(baseline);
      assertContext(ctx, baseline);
      const task = baseline.contract.tasks.find(t => t.id === taskId)!;
      const projection = isMultiRepositoryBinding(baseline.binding)
        ? resolveTaskRepository(task, baseline.binding.repositories)
        : { root: baseline.binding.repositoryRoot, writePaths: task.writePaths };
      const dispatchedTask = isMultiRepositoryBinding(baseline.binding) ? { ...task, writePaths: projection.writePaths } : task;
      const previous = baseline.tasks[taskId]!;
      const attempt = previous.attempt + 1;
      const dispatchKey = `${baseline.planId}:${taskId}:${attempt}:${randomUUID()}`;
      intent = await change(baseline, current => {
        assertTask(current, baseline, taskId);
        assertActive(current);
        if (expectedRevision !== undefined && current.revision !== expectedRevision) reject("REVISION_CONFLICT", "持久化修复 intent 前 revision 已变化");
        if (message === undefined) {
          if (current.tasks[taskId]!.status !== "pending" || occupied(current.tasks[taskId]!, facts)
            || !depsAccepted(current, task)) reject("TASK_NOT_READY", "任务不再属于 ready set");
        } else if (retryRoute(current, task, facts) !== route) {
          reject("RETRY_NOT_ADMITTED", "持久化 intent 前修复准入已变化");
        }
        if (!fits(current, task, resourceUsage(current, facts, message === undefined ? undefined : taskId), maxConcurrentTasks)) {
          reject("RESOURCE_CAPACITY", "持久化 intent 前计划资源容量已不足");
        }
        // 新 intent 清空旧 run，旧引用仍在前一个持久快照；未知 resume 不能冒充旧 run。
        const next: TaskState = { status: "running", attempt, dispatchKey,
          workspaceId: route === "resume" ? previous.workspaceId : null, run: null,
          terminalProofRef: null, integrationReceiptRef: null, blocker: null };
        const invalid = new Set([...current.contract.terminalCheckIds, ...task.checkIds,
          ...current.contract.checks.filter(c => c.repairTaskIds.includes(taskId)).map(c => c.id)]);
        return { ...current, tasks: { ...current.tasks, [taskId]: next },
          receipts: current.receipts.filter(r => !invalid.has(r.checkId)) };
      });
      const saved = intent;
      const onBound = async (ref: PlanRunRef) => {
        if (ref.rootSessionId !== saved.binding.sessionId || !ref.runId || !ref.workspaceId) reject("RUN_IDENTITY_MISMATCH", "adapter 返回的绑定身份无效");
        const current = read();
        assertTask(current, saved, taskId);
        const allocated = current.tasks[taskId]!;
        if ((allocated.workspaceId && allocated.workspaceId !== ref.workspaceId) || (allocated.run && !sameRun(allocated.run, ref))) {
          reject("RUN_IDENTITY_MISMATCH", "adapter 绑定与已分配 workspace/run 不符");
        }
        bound = ref;
        if (sameRun(allocated.run, ref)) return;
        await change(saved, current => {
          assertTask(current, saved, taskId);
          const now = current.tasks[taskId]!;
          if ((now.workspaceId && now.workspaceId !== ref.workspaceId) || (now.run && !sameRun(now.run, ref))) reject("RUN_IDENTITY_MISMATCH", "adapter 绑定与已分配 workspace/run 不符");
          return { ...current, tasks: { ...current.tasks, [taskId]: { ...now, status: "running", run: ref, workspaceId: ref.workspaceId, blocker: null } } };
        });
      };
      store.assertWritable();
      assertContext(ctx, read());
      assertActive(read());
      // 从这一行之后的所有未绑定异常均为 unknown；不解读异常字符串推断未启动。
      invoked = true;
      // 显式提供单行 title：缺省回退会切片多行任务正文并由 title-registry 以 INVALID_TITLE 拒绝整次派发。
      const startRequest = () => ({ agent: task.agent, task: prompt(saved, dispatchedTask, message), title: dispatchTitle(saved, task),
        writePaths: [...projection.writePaths], acceptance: { criteria: [...task.acceptance.criteria] },
        worktree: true as const, cwd: projection.root });
      const ref = route === "resume"
        ? await execution.resume({ previous: previous.run!, dispatchKey: saved.tasks[taskId]!.dispatchKey!, message: message!, ctx, onBound })
        : await execution.start({ dispatchKey: saved.tasks[taskId]!.dispatchKey!, request: startRequest(), ctx,
          onAllocated: async workspaceId => {
            await change(saved, current => {
              assertTask(current, saved, taskId);
              const now = current.tasks[taskId]!;
              if (!workspaceId || (now.workspaceId && now.workspaceId !== workspaceId)) reject("WORKSPACE_IDENTITY_MISMATCH", "分配的 workspace 身份不一致");
              return { ...current, tasks: { ...current.tasks, [taskId]: { ...now, workspaceId } } };
            });
          }, onBound });
      if (!sameRun(read().tasks[taskId]!.run, ref)) await onBound(ref);
      return { taskId, outcome: "bound", run: ref };
    } catch (error) {
      if (intent && store.diagnose().writable) {
        await change(intent, current => {
          assertTask(current, intent!, taskId);
          const now = current.tasks[taskId]!;
          if (now.run) return current;
          // 仅此分支能证明 adapter 未调用：恢复原业务状态，不把已知未启动变成 unknown。
          if (!invoked) {
            const unchangedAttempts = current.contract.tasks.every(task => task.id === taskId
              || (current.tasks[task.id]!.attempt === prior!.tasks[task.id]!.attempt
                && current.tasks[task.id]!.dispatchKey === prior!.tasks[task.id]!.dispatchKey));
            return { ...current, tasks: { ...current.tasks, [taskId]: prior!.tasks[taskId]! },
              receipts: unchangedAttempts ? prior!.receipts : current.receipts };
          }
          return { ...current, tasks: { ...current.tasks, [taskId]: {
            ...now, status: "blocked", blocker: "启动结果不明：禁止自动重派，需核对权威绑定",
          } } };
        });
      }
      return { taskId, outcome: bound ? "bound" : invoked ? "unknown" : "not-started", run: bound, error };
    }
  }

  async function advance(ctx: ExtensionToolContext): Promise<{ dispatches: DispatchResult[]; next: NextAction }> {
    return exclusive("advance", async () => {
      assertActive(read());
      assertContext(ctx, read());
      await assertContract(read());
      await refreshRuns();
      const ready = readyTasks(read(), { maxConcurrentTasks, facts });
      const dispatches = await Promise.all(ready.map(task => dispatch(task.id, ctx, "start")));
      return { dispatches, next: decideNextAction(read(), facts, maxConcurrentTasks) };
    });
  }

  async function retryTask(taskId: string, message: string, expectedRevision: number, ctx: ExtensionToolContext): Promise<DispatchResult> {
    return exclusive("retry", async () => {
      const baseline = read();
      assertActive(baseline);
      assertContext(ctx, baseline);
      if (baseline.revision !== expectedRevision) reject("REVISION_CONFLICT", "revision 已变化，请重新读取计划状态");
      if (typeof message !== "string" || !message.trim()) reject("EMPTY_GUIDANCE", "plan_retry 必须提供非空针对性指导");
      const task = baseline.contract.tasks.find(t => t.id === taskId);
      if (!task) reject("UNKNOWN_TASK", "不得新增或替换原合同中的任务");
      await assertContract(baseline);
      // 不在准入期间 refresh 写 revision；只取当前 attempt 的权威事实并重核版本。
      let run = baseline.tasks[taskId]!.run;
      if (!run) reject("UNKNOWN_DISPATCH", "原 attempt 无权威绑定，禁止 retry");
      // 前置血缘重绑：旧 run 已被 resume 血缘取代时，先经 change() 持久化重绑至最终 run 再取权威事实。
      let revision = expectedRevision;
      const resolution = await resolveLineageRun(execution, run);
      if (resolution?.superseded) {
        run = (await change(baseline, current => {
          assertTask(current, baseline, taskId);
          return rebindTaskRun(current, taskId, resolution.run);
        })).tasks[taskId]!.run!;
        // 本函数自身的一次已知写入计入准入版本；其余外部变化仍按 REVISION_CONFLICT 拒绝。
        revision += 1;
      }
      const fact = await execution.inspect(run);
      if (!sameRun(fact.run, run)) reject("RUN_IDENTITY_MISMATCH", "原 attempt 的 facts 身份不符");
      if (read().revision !== revision) reject("REVISION_CONFLICT", "准入期间 revision 已变化");
      assertTask(read(), baseline, taskId);
      facts[run.runId] = fact;
      const route = retryRoute({ ...baseline, tasks: { ...baseline.tasks, [taskId]: { ...baseline.tasks[taskId]!, run } } }, task, facts);
      if (!route) reject("RETRY_NOT_ADMITTED", "既无失败 check 的合法修复路径，也无可合法恢复的权威失败 attempt");
      if (Object.values(baseline.tasks).some(t => t.status === "verifying")) reject("VERIFICATION_ACTIVE", "验证期间不得启动修复任务");
      if (!fits(baseline, task, resourceUsage(baseline, facts, taskId), maxConcurrentTasks)) reject("RESOURCE_CAPACITY", "修复所需计划资源容量不足");
      store.assertWritable();
      return dispatch(taskId, ctx, route, message, revision);
    });
  }

  async function verify(ctx: ExtensionToolContext, toolCallId: string, requestedCheckIds?: readonly string[]): Promise<{ receipts: CheckReceipt[]; next: NextAction; driftedRepoIds: string[] }> {
    return exclusive("verify", async () => {
      assertActive(read());
      assertContext(ctx, read());
      if (!toolCallId.trim()) reject("TOOL_CALL_ID_REQUIRED", "检查需要真实父工具调用 ID");
      await assertContract(read());
      await refreshRuns();
      let baseline = read();
      if (requestedCheckIds && (!requestedCheckIds.length || new Set(requestedCheckIds).size !== requestedCheckIds.length
        || requestedCheckIds.some(id => !baseline.contract.checks.some(check => check.id === id)))) {
        reject("INVALID_CHECK_IDS", "只能选择非空、不重复的契约内检查 ID");
      }
      const candidates = baseline.contract.tasks.filter(t => t.checkIds.length > 0
        && (baseline.tasks[t.id]!.status === "verifying" || baseline.tasks[t.id]!.status === "blocked")
        && !!factFor(baseline.tasks[t.id]!, facts) && delivered(factFor(baseline.tasks[t.id]!, facts)!));
      const task = requestedCheckIds
        ? candidates.find(t => requestedCheckIds.every(id => t.checkIds.includes(id)))
        : candidates.find(t => baseline.tasks[t.id]!.status === "verifying")
          ?? candidates.find(t => baseline.tasks[t.id]!.blocker === CHECK_REVERIFY);
      const terminal = !task;
      if (terminal && (!baseline.contract.tasks.every(t => baseline.tasks[t.id]!.status === "accepted") || !allClosed(baseline, facts))) {
        reject("TERMINAL_NOT_READY", "全部 child 终止、集成闭合且任务 accepted 后才可验证终态；任务级批次须属于一个已交付任务");
      }
      const checkIds = requestedCheckIds ? [...requestedCheckIds] : [...(task ? task.checkIds : baseline.contract.terminalCheckIds)];
      if (task && baseline.tasks[task.id]!.status !== "verifying") {
        if (!fits(baseline, task, resourceUsage(baseline, facts, task.id), maxConcurrentTasks)) reject("RESOURCE_CAPACITY", "复验所需计划资源容量不足");
        baseline = await change(baseline, current => ({ ...current, tasks: { ...current.tasks,
          [task.id]: { ...current.tasks[task.id]!, status: "verifying", blocker: null } } }));
      }
      store.assertWritable();
      try {
        const receipts = await input.verify({ contract: baseline.contract, binding: baseline.binding, checkIds,
          toolCallId, ctx, writeEvidence: store.writeEvidence });
        store.assertWritable();
        assertContext(ctx, read());
        const subject = await captureBindingSubject(baseline.binding, input.captureSubject);
        const completeBatch = receipts.length === checkIds.length && checkIds.every(id => receipts.some(r => r.checkId === id));
        const passed = completeBatch && receiptsAreCurrent(receipts, subject, baseline.binding.contractHash);
        const comparisons = receipts.map(r => compareSubjects(r.subject, subject));
        const candidateMatches = comparisons.every(comparison => comparison.equal);
        const driftedRepoIds = new Set(comparisons.flatMap(comparison => comparison.driftedRepoIds));
        // 原始证据保留在 session；记录前候选再漂移则撤销整批可用引用，不改写或制造 receipt。
        const evidenced = completeBatch && receipts.every(r => r.resultRef.length > 0);
        await change(baseline, current => {
          for (const original of baseline.contract.tasks) assertTask(current, baseline, original.id);
          const nextReceipts = !candidateMatches
            ? current.receipts.filter(r => !checkIds.includes(r.checkId))
            : evidenced ? [...current.receipts, ...receipts] : current.receipts;
          const tasks = { ...current.tasks };
          if (task) {
            const latest = new Map(nextReceipts.map(r => [r.checkId, r]));
            const required = task.checkIds.flatMap(id => latest.has(id) ? [latest.get(id)!] : []);
            const accepted = passed && required.length === task.checkIds.length
              && receiptsAreCurrent(required, subject, baseline.binding.contractHash);
            tasks[task.id] = { ...tasks[task.id]!, status: accepted ? "accepted" : "blocked",
              blocker: accepted ? null : candidateMatches && receipts.some(r => r.outcome === "failed") ? CHECK_FAILED : CHECK_REVERIFY };
          }
          return { ...current, tasks, receipts: nextReceipts };
        });
        // 最终完成只接受本轮覆盖全部 terminal checks 的有效批次，不拼接历史终态通过。
        if (terminal && passed && baseline.contract.terminalCheckIds.every(id => checkIds.includes(id))) {
          await refreshRuns();
          await assertContract(read());
          const finalSubject = await captureBindingSubject(baseline.binding, input.captureSubject);
          for (const receipt of receipts) {
            for (const repoId of compareSubjects(receipt.subject, finalSubject).driftedRepoIds) driftedRepoIds.add(repoId);
          }
          if (receiptsAreCurrent(receipts, finalSubject, baseline.binding.contractHash) && allClosed(read(), facts)) {
            store.assertWritable();
            await change(baseline, current => {
              assertActive(current);
              for (const original of baseline.contract.tasks) assertTask(current, baseline, original.id);
              if (!current.contract.tasks.every(t => current.tasks[t.id]!.status === "accepted")) reject("TERMINAL_NOT_READY", "完成前任务状态已变化");
              return { ...current, status: "completed", pauseReason: null };
            });
          }
        }
        // 每批结束立即重算；不等其它独立 child，也不在通知回调中派发。
        return { receipts, next: decideNextAction(read(), facts, maxConcurrentTasks), driftedRepoIds: [...driftedRepoIds].sort() };
      } finally {
        // 命令/候选捕获/中断均可能失败；检查已结束就释放计划占用，真实 live 债务仍由 facts 约束。
        if (task && store.diagnose().writable && read().tasks[task.id]?.status === "verifying") {
          await change(baseline, current => {
            assertTask(current, baseline, task.id);
            return { ...current, tasks: { ...current.tasks, [task.id]: { ...current.tasks[task.id]!, status: "blocked", blocker: CHECK_REVERIFY } } };
          });
        }
      }
    });
  }

  async function recordCheckpoint(checkpoint: GoalCheckpoint): Promise<GoalState> {
    store.assertWritable();
    return store.checkpoint(checkpoint);
  }
  async function recordProgressTurn(sample: { goalContinuation: boolean; pendingMessages: boolean }): Promise<GoalState> {
    const baseline = read();
    const next = decideNextAction(baseline, facts, maxConcurrentTasks);
    const normalWaiting = baseline.contract.tasks.some(task => {
      const fact = factFor(baseline.tasks[task.id]!, facts);
      return fact?.wakeup === "subscribed" && fact.blocker === null && fact.recovery === "none"
        && (fact.terminal === "pending" || fact.integration === "pending");
    });
    if (!sample.goalContinuation || sample.pendingMessages || operation || baseline.status !== "active"
      || normalWaiting || next.kind === "wait" || next.kind === "done") return baseline;
    return change(baseline, current => {
      if (current.status !== "active") return current;
      const hash = progressFingerprint(current);
      const noProgressTurns = hash === current.lastProgressHash ? current.noProgressTurns + 1 : 0;
      return { ...current, lastProgressHash: hash, noProgressTurns,
        status: noProgressTurns >= maxNoProgressTurns ? "paused" : current.status,
        pauseReason: noProgressTurns >= maxNoProgressTurns ? "连续自动推进无有效进展，保留未完成状态并等待诊断" : current.pauseReason };
    });
  }
  return { activate, replaceCancelled, advance, refreshRuns, retryTask, verify, recordCheckpoint, recordProgressTurn, forceCloseTasks,
    readFacts: (): RunFacts => ({ ...facts }),
    nextAction: (): NextAction => decideNextAction(read(), facts, maxConcurrentTasks) };
}
