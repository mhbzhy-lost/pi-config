import { createRunAuthorization } from "./run-authorization.ts";

const STARTED_EVENT = "subagent:async-started";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_START_TIMEOUT_MS = 15000;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;
const MAX_CAPTURED_STARTS = 64;

// 只驱动 child 恢复自身中断的 rebase：coordinator 仍是 FIFO/proof/release 的
// 唯一门禁，prompt 明确禁止 child 调用 integration 变更工具。
export const RECOVERY_RESUME_PROMPT = [
  "继续之前中断的 repository integration 任务。",
  "先运行 git status 与 git diff --name-only --diff-filter=U 检查当前 worktree：",
  "- 如果存在未解决的 rebase 冲突（UU/AA 等未合并路径），只解决当前冲突并用 git add 标记已解决，不要修改其他业务文件；",
  "- 如果没有冲突，不要修改任何业务文件。",
  "不要调用任何 integration 变更工具（publish/abandon/report-conflict 等），队列由 lifecycle 正常推进。",
  "完成本轮检查后正常结束。",
].join("\n");

type ResumedRunIdentity = { runId: string; asyncDir: string; sessionId: string; pid: number; agentProfile: string };
type ResumeOutcome = { state: "activated"; resumeIntentId: string; resumedRun: ResumedRunIdentity }
  | { state: "debt"; resumeIntentId: string; reason: string }
  | { state: "skipped"; reason: string };

interface StartCapture {
  dispose(): void;
  awaitFor(runId: string, asyncDir: string, timeoutMs: number): Promise<{ sessionId: string; pid: number; agentProfile: string }>;
}

// resumed run 的身份关联键：resume RPC reply details 携带 runId/asyncDir；
// subagent:async-started 事件携带 id/pid/sessionId/agent。upstream resume
// 剥离 workflowParentRunId/workflowKey，因此按 runId 关联，事件先于 reply
// 到达时由 capture 缓冲。
function createStartWatcher(events: { on(type: string, handler: (event: unknown) => void): (() => void) | undefined }, { lifecycleSessionId }: { lifecycleSessionId?: string }) {
  const listeners = new Set<(event: any) => void>();
  const unsubscribe = typeof events?.on === "function"
    ? events.on(STARTED_EVENT, (event: unknown) => {
      const record = event as any;
      const id = record?.runId ?? record?.id;
      if (typeof id !== "string" || id.length === 0) return;
      if (lifecycleSessionId !== undefined && record.sessionId !== lifecycleSessionId) return;
      for (const listener of [...listeners]) { try { listener(record); } catch { /* listener 错误经其 promise 语义暴露 */ } }
    })
    : undefined;
  return {
    dispose() { unsubscribe?.(); listeners.clear(); },
    capture(): StartCapture {
      const buffer: any[] = [];
      const listener = (event: any) => { buffer.push(event); if (buffer.length > MAX_CAPTURED_STARTS) buffer.shift(); };
      listeners.add(listener);
      let disposed = false;
      return {
        dispose() { if (!disposed) { disposed = true; listeners.delete(listener); } },
        awaitFor(runId: string, asyncDir: string, timeoutMs: number) {
          return new Promise((resolve, reject) => {
            let settled = false;
            let timer: NodeJS.Timeout | undefined;
            const notify = () => { evaluate(); };
            const cleanup = () => { if (timer !== undefined) clearTimeout(timer); listeners.delete(notify); };
            const evaluate = () => {
              if (settled) return;
              const event = buffer.find((candidate) => (candidate.runId ?? candidate.id) === runId);
              if (event === undefined) return;
              settled = true;
              cleanup();
              try {
                if (event.asyncDir !== asyncDir) throw new Error("resumed child start asyncDir does not match the resume reply");
                if (!Number.isSafeInteger(event.pid) || event.pid <= 0) throw new Error("resumed child start pid is invalid");
                if (typeof event.agent !== "string" || event.agent.length === 0) throw new Error("resumed child start agent is missing");
                if (typeof event.sessionId !== "string" || event.sessionId.length === 0) throw new Error("resumed child start sessionId is missing");
                resolve({ sessionId: event.sessionId, pid: event.pid, agentProfile: event.agent });
              } catch (error) { reject(error); }
            };
            listeners.add(notify);
            timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); reject(new Error(`resumed child start event timed out for ${runId}`)); }, timeoutMs);
            if (typeof timer.unref === "function") timer.unref();
            evaluate();
          });
        },
      };
    },
  };
}

export function createRecoveryResumeOrchestrator({
  rpc, events, coordinatorClient, registerAuthorizedRun, activateResume, rootSessionId,
  lifecycleSessionId, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  maxDeliveryAttempts = DEFAULT_MAX_DELIVERY_ATTEMPTS, trace,
}: {
  rpc: { resume(params: any): Promise<any> };
  events: { on(type: string, handler: (event: unknown) => void): (() => void) | undefined };
  coordinatorClient: { recoveryStatus(input?: any): Promise<any>; resumeDebt(input: any): Promise<any> };
  registerAuthorizedRun: (authorization: unknown) => Promise<unknown> | unknown;
  activateResume: (input: any) => Promise<any>;
  rootSessionId: string;
  lifecycleSessionId?: string;
  pollIntervalMs?: number;
  startTimeoutMs?: number;
  maxDeliveryAttempts?: number;
  trace?: (entry: any) => void;
}) {
  if (!rpc || typeof rpc.resume !== "function") throw new TypeError("recovery resume orchestrator requires a typed subagent RPC client");
  if (!events || typeof events.on !== "function") throw new TypeError("recovery resume orchestrator requires an event bus");
  if (!coordinatorClient || typeof coordinatorClient.recoveryStatus !== "function" || typeof coordinatorClient.resumeDebt !== "function") throw new TypeError("recovery resume orchestrator requires a coordinator client");
  if (typeof registerAuthorizedRun !== "function") throw new TypeError("recovery resume orchestrator requires run registration");
  if (typeof activateResume !== "function") throw new TypeError("recovery resume orchestrator requires resume activation");
  if (typeof rootSessionId !== "string" || rootSessionId.length === 0) throw new TypeError("recovery resume orchestrator requires a root session id");
  if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs <= 0) throw new TypeError("recovery resume start timeout must be a positive safe integer");
  if (!Number.isSafeInteger(maxDeliveryAttempts) || maxDeliveryAttempts <= 0) throw new TypeError("recovery resume delivery attempt cap must be a positive safe integer");

  const inFlight = new Map<string, Promise<ResumeOutcome>>();
  const completedKeys = new Set<string>();
  const startWatcher = createStartWatcher(events, { lifecycleSessionId });
  let disposed = false;
  let pollTimer: NodeJS.Timeout | undefined;

  // 诊断打点：仅记录阶段与身份，不携带 prompt/token；诊断输出不得改变恢复语义。
  const traced = (phase: string, fields: Record<string, unknown> = {}, intent?: any) => {
    if (typeof trace !== "function") return;
    try {
      trace({
        version: 1,
        phase,
        monotonicMs: Math.floor(Number(process.hrtime.bigint() / 1_000_000n)),
        ...(intent?.resumeIntentId ? { resumeIntentId: intent.resumeIntentId } : {}),
        ...(intent?.sourceRunId ? { sourceRunId: intent.sourceRunId } : {}),
        ...(intent?.attempt !== undefined ? { attempt: intent.attempt } : {}),
        ...fields,
      });
    } catch { /* 诊断输出不得影响恢复主链 */ }
  };

  function shouldAttempt(intent: any) {
    const key = typeof intent?.resumeIntentId === "string" ? intent.resumeIntentId : undefined;
    return intent?.requiredAction === "resume-child"
      && (intent.state === "pending" || intent.state === "starting")
      && intent.ownerScope?.rootSessionId === rootSessionId
      && Number.isSafeInteger(intent.delivery?.attempts) && intent.delivery.attempts < maxDeliveryAttempts
      && key !== undefined && !completedKeys.has(key);
  }

  async function resumeSourceRun(intent: any): Promise<ResumedRunIdentity> {
    const capture = startWatcher.capture();
    try {
      // 只使用 upstream public resume；禁止 model override / chain 附加。
      const reply = await rpc.resume({ id: intent.sourceRunId, message: RECOVERY_RESUME_PROMPT });
      traced("recovery-resume-resume-called", { resumedRunId: (reply as any)?.details?.runId ?? "unknown" }, intent);
      const details = (reply as any)?.details ?? reply;
      const runId = details?.runId ?? details?.asyncId;
      const asyncDir = details?.asyncDir;
      if (typeof runId !== "string" || runId.length === 0 || typeof asyncDir !== "string" || asyncDir.length === 0) {
        throw new Error("resume reply is missing runId or asyncDir");
      }
      const identity = await capture.awaitFor(runId, asyncDir, startTimeoutMs).catch((error: Error) => {
        traced("recovery-resume-child-start-timeout", { resumedRunId: runId, reason: error.message.slice(0, 240) }, intent);
        throw error;
      });
      return { runId, asyncDir, sessionId: identity.sessionId, pid: identity.pid, agentProfile: identity.agentProfile };
    } catch (error) {
      if (error instanceof Error && /timed out/.test(error.message)) throw error;
      traced("recovery-resume-resume-rejected", { reason: (error instanceof Error ? error.message : String(error)).slice(0, 240) }, intent);
      throw error;
    } finally {
      capture.dispose();
    }
  }

  async function runIntent(intent: any): Promise<ResumeOutcome> {
    traced("recovery-resume-submit", { queueState: intent.queueState, intentState: intent.state }, intent);
    try {
      // crash 重放：starting intent 复用已记录的 resumedRun，不再二次 resume。
      const resumedRun: ResumedRunIdentity = intent.state === "starting" && intent.resumedRun?.runId
        ? intent.resumedRun
        : await resumeSourceRun(intent);
      traced("recovery-resume-child-start-captured", { resumedRunId: resumedRun.runId, pid: resumedRun.pid }, intent);
      // 新 run 的授权必须先于 activation：coordinator rebind 之后的
      // trusted binding 与 proof/release 门禁都依赖该授权。
      await registerAuthorizedRun(createRunAuthorization({ kind: "coding", goal: null, binding: resumedRun }));
      traced("recovery-resume-registered", { resumedRunId: resumedRun.runId }, intent);
      await activateResume({ resumeIntentId: intent.resumeIntentId, workspaceId: intent.workspaceId, leaseId: intent.leaseId,
        sourceRunId: intent.sourceRunId, resumedRun, ownerScope: intent.ownerScope, generation: intent.generation, authorization: "root" });
      traced("recovery-resume-activated", { resumedRunId: resumedRun.runId }, intent);
      completedKeys.add(String(intent.resumeIntentId));
      return { state: "activated", resumeIntentId: intent.resumeIntentId, resumedRun };
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error);
      traced("recovery-resume-failed", { reason: reason.slice(0, 240) }, intent);
      try {
        // resume 失败写 delivery debt：attempts 递增，超过上限后轮询通道停止重试。
        await coordinatorClient.resumeDebt({ resumeIntentId: intent.resumeIntentId, ownerScope: intent.ownerScope, authorization: "root", reason: reason.slice(0, 240) });
      } catch { /* debt 记录失败保持 pending，由下次轮询重试 */ }
      return { state: "debt", resumeIntentId: intent.resumeIntentId, reason };
    }
  }

  function submit(intent: any): Promise<ResumeOutcome> {
    if (disposed || !shouldAttempt(intent)) {
      return Promise.resolve({ state: "skipped", reason: disposed ? "disposed" : "not-attemptable" });
    }
    const key = String(intent.resumeIntentId);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = runIntent(intent);
    task.finally(() => { inFlight.delete(key); }).catch(() => undefined);
    inFlight.set(key, task);
    return task;
  }

  // 双通道之一：本 Host 的 durable 轮询。daemon 与非 daemon Host 都通过
  // recovery.status（按 rootSessionId 过滤）发现自己 children 的 pending
  // intent；与 broker 快路径重叠投递由 inFlight/completedKeys 去重。
  async function poll() {
    if (disposed) return;
    let intents: unknown;
    try { intents = await coordinatorClient.recoveryStatus(); } catch { return; }
    if (disposed || !Array.isArray(intents)) return;
    for (const intent of intents) await submit(intent);
  }

  function start() {
    if (disposed) throw new Error("recovery resume orchestrator is disposed");
    if (pollTimer !== undefined) return;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) return;
    pollTimer = setInterval(() => { void poll(); }, pollIntervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
    void poll();
  }

  function dispose() {
    disposed = true;
    if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; }
    startWatcher.dispose();
    inFlight.clear();
  }

  return Object.freeze({ submit, start, dispose });
}
