import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createCoordinatorLedger } from "./coordinator-ledger.ts";
import { isPreparedWorkspaceDisposition, type PreparedWorkspaceDispositionV1 } from "./disposition-contract.ts";
import { assertProcessBirthOutput } from "../subagent-dispatch/process-birth-identity.ts";
import { createIntegrationResumeIntentV1, progressFingerprint } from "../subagent-dispatch/recovery-resume-contract.ts";

export const INTEGRATION_QUEUE_RECORD_VERSION = "workspace-integration-queue-item.v1";
export const INTEGRATION_RECEIPT_EVENT_VERSION = "integration-receipt-event.v1";
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const id = (value: unknown, label: string) => { if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is required`); return value; };
const digest = (value: unknown, label: string) => { if (typeof value !== "string" || !SHA.test(value)) throw new TypeError(`${label} must be sha256`); return value; };
const commit = (value: unknown, label: string) => { if (typeof value !== "string" || !COMMIT.test(value)) throw new TypeError(`${label} must be a commit id`); return value; };
const RESUMABLE_QUEUE_STATES = ["queued", "admitted", "resolving-conflict", "prepared"];
const RESUME_ACTIVE_STATES = ["waiting-head", "pending", "starting", "activated"];
const RESUME_MAX_ATTEMPTS = 6;
const RESUME_MAX_NO_PROGRESS = 2;

export type ProcessAliveStatus = { state: "alive" | "dead" | "mismatch" | "undetermined"; reason?: "process-not-found" | "birth-identity-mismatch"; error?: unknown; errno?: string };

/** 队列项终态回执事件：五个终态写入点在 ledger.withLock 临界区内追加的 durable 记录。 */
export type IntegrationReceiptEvent = {
  version: typeof INTEGRATION_RECEIPT_EVENT_VERSION;
  /** 幂等键：`${queueItemId}:${state}` */
  eventId: string;
  queueItemId: string;
  workspaceId: string;
  leaseId: string;
  /** rebind 后的最终 run；未绑定 child 的队列项为 null */
  childRunId: string | null;
  ownerScope: { kind: "standalone-subagent"; rootSessionId: string };
  repositoryId: string;
  state: "completed" | "preserved" | "cancelled";
  attempt: number;
  /** 终态写入后的 revision */
  revision: number;
  candidateHead?: string;
  integrationIntentId?: string;
  workspaceDispositionReceiptId?: string;
  completedAt?: string;
  preservedAt?: string;
  cancelledAt?: string;
  delivery: { state: "pending" | "delivered" | "debt"; attempts: number; reason?: string };
};

/**
 * Process liveness is security-sensitive: only ESRCH proves death. EPERM,
 * ps failures, malformed output, and invalid birth identities remain unknown.
 * A successfully observed different birth identity is explicit PID reuse.
 */
export function processAliveStatus(pid: number, birthIdentity: string): ProcessAliveStatus {
  if (typeof birthIdentity !== "string" || !/^[a-f0-9]{64}$/.test(birthIdentity)) {
    const error = new Error("process birth identity is invalid");
    error.code = "PROCESS_IDENTITY_INVALID";
    return { state: "undetermined", error, errno: error.code };
  }
  try {
    process.kill(pid, 0);
  } catch (error: any) {
    if (error?.code === "ESRCH") return { state: "dead", reason: "process-not-found", error, errno: error.code };
    return { state: "undetermined", error, errno: error?.code };
  }
  try {
    const observed = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "buffer" });
    if (!Buffer.isBuffer(observed) || observed.length === 0 || observed.toString("utf8").trim().length === 0) {
      const error = new Error("process birth identity output is unavailable");
      return { state: "undetermined", error };
    }
    try {
      assertProcessBirthOutput(observed);
    } catch (error: any) {
      return { state: "undetermined", error, errno: error?.code };
    }
    const observedIdentity = createHash("sha256").update(observed).digest("hex");
    if (observedIdentity === birthIdentity) return { state: "alive" };
    const error = new Error("process birth identity does not match");
    error.code = "PROCESS_IDENTITY_MISMATCH";
    return { state: "mismatch", reason: "birth-identity-mismatch", error, errno: error.code };
  } catch (error: any) {
    return { state: "undetermined", error, errno: error?.code };
  }
}

export function createIntegrationQueue({ stateRoot, repositoryId, storageRepositoryId, diagnosticSink }: { stateRoot: string; repositoryId: string; storageRepositoryId?: string; diagnosticSink?: (entry: unknown) => void }) {
  const diagnose = (entry: unknown) => { try { diagnosticSink?.(entry); } catch (diagnosticError) { console.error("[integration-queue] diagnostic sink failed", { entry, diagnosticError }); } };
  digest(repositoryId, "repositoryId");
  const storageId = storageRepositoryId ?? repositoryId;
  digest(storageId, "storageRepositoryId");
  const ledger = createCoordinatorLedger(path.join(stateRoot, "repositories", storageId, "integration-queue"));
  const metaFile = "queue-meta.json";
  const recoveryIndexFile = "recovery-intent-index.json";
  const resumeIndexFile = "resume-intent-index.json";
  const files = () => ledger.read<string[]>("queue-index.json", []).filter((name) => ledger.exists(name));
  const recoveryFiles = () => ledger.read<string[]>(recoveryIndexFile, []).filter((name) => ledger.exists(name));
  const recoveryLoad = (name: string) => ledger.read<any>(name, null);
  function createRecoveryIntentUnlocked(input: any) {
    const ownerScope = input?.ownerScope;
    if (!input?.queueItemId || !input?.workspaceId || !input?.runId || !ownerScope?.rootSessionId || !input?.reason || !input?.requiredAction) throw new TypeError("recovery intent identity and action are required");
    if (typeof input.reason !== "string" || typeof input.requiredAction !== "string") throw new TypeError("recovery intent reason and action must be strings");
    const names = recoveryFiles();
    const existing = names.map(recoveryLoad).find((entry) => entry.queueItemId === input.queueItemId && entry.workspaceId === input.workspaceId && entry.ownerScope?.rootSessionId === ownerScope.rootSessionId);
    if (existing) return structuredClone(existing);
    const intent = { version: "recovery-intent.v1", recoveryIntentId: randomUUID(), queueItemId: input.queueItemId, workspaceId: input.workspaceId,
      ownerScope: structuredClone(ownerScope), runId: input.runId, attempt: Number.isSafeInteger(input.attempt) ? input.attempt : 1,
      reason: input.reason.slice(0, 256), requiredAction: input.requiredAction.slice(0, 64), generation: Number.isSafeInteger(input.generation) ? input.generation : 0,
      delivery: { state: "pending", attempts: 0 }, state: "preserved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const name = `recovery-${intent.recoveryIntentId}.json`; ledger.write(name, intent); ledger.write(recoveryIndexFile, [...names, name]); return structuredClone(intent);
  }
  function recoveryIntent(input: any) {
    return ledger.withLock(() => createRecoveryIntentUnlocked(input));
  }
  function listRecoveryIntents() { return recoveryFiles().map(recoveryLoad).filter(Boolean).map((entry) => structuredClone(entry)); }
  function markRecoveryDelivery(recoveryIntentId: string, delivery: any) {
    return ledger.withLock(() => {
      const current = recoveryLoad(`recovery-${recoveryIntentId}.json`);
      if (!current) throw new Error("recovery intent not found");
      const next = { ...current, delivery: { state: delivery?.state === "delivered" ? "delivered" : "debt", ...(delivery?.reason ? { reason: String(delivery.reason).slice(0, 256) } : {}), attempts: (current.delivery?.attempts ?? 0) + 1 }, updatedAt: new Date().toISOString() };
      ledger.write(`recovery-${recoveryIntentId}.json`, next); return structuredClone(next);
    });
  }
  function notificationDeliveryDebt() { return listRecoveryIntents().filter((entry) => entry.delivery?.state === "debt" || entry.delivery?.state === "pending"); }

  const resumeFiles = () => ledger.read<string[]>(resumeIndexFile, []).filter((name) => ledger.exists(name));
  const resumeLoad = (name: string) => ledger.read<any>(name, null);
  const loadResumeIntentsUnlocked = () => resumeFiles().map(resumeLoad).filter(Boolean);
  function saveResumeIntentUnlocked(intent: any) {
    const name = `resume-${intent.resumeIntentId}.json`;
    ledger.write(name, intent);
    const names = resumeFiles();
    if (!names.includes(name)) ledger.write(resumeIndexFile, [...names, name]);
  }
  function listResumeIntents(ownerRootSessionId?: string) {
    const intents = loadResumeIntentsUnlocked().map((entry) => structuredClone(entry));
    return ownerRootSessionId === undefined ? intents : intents.filter((entry) => entry.ownerScope?.rootSessionId === ownerRootSessionId);
  }
  // child 在 integration 完成前退出的 durable 续轮意图：对 queue item/source run
  // 幂等；resumed run 再次退出时前一 intent 标记 failed 并按 fingerprint 判定
  // 无进展；两次无进展或 attempt 超限即 fail closed preserve 并生成 legacy 人工债。
  function requestChildResume(input: any) {
    id(input?.queueItemId, "queueItemId"); id(input.sourceRunId, "sourceRunId"); id(input.sourceAsyncDir, "sourceAsyncDir"); id(input.sourceProofId, "sourceProofId");
    return ledger.withLock(() => {
      const current = load(`${input.queueItemId}.json`);
      if (!current || !RESUMABLE_QUEUE_STATES.includes(current.state)) throw new Error("queue item is not resumable");
      const existing = loadResumeIntentsUnlocked().filter((entry) => entry.queueItemId === input.queueItemId).sort((a, b) => a.attempt - b.attempt);
      const previous = existing.at(-1);
      if (previous?.state === "preserved") return structuredClone(previous);
      const active = existing.filter((entry) => RESUME_ACTIVE_STATES.includes(entry.state)).at(-1);
      if (active && active.sourceRunId === input.sourceRunId) return structuredClone(active);
      if (active) saveResumeIntentUnlocked({ ...structuredClone(active), state: "failed", updatedAt: new Date().toISOString() });
      const attempt = (previous?.attempt ?? 0) + 1;
      const fingerprint = progressFingerprint(current);
      const noProgress = previous && previous.progressFingerprint === fingerprint ? (previous.noProgressCount ?? 0) + 1 : 0;
      const created = createIntegrationResumeIntentV1({ queueItem: current, sourceAsyncDir: input.sourceAsyncDir, sourceProofId: input.sourceProofId, attempt });
      const intent = { ...structuredClone(created), noProgressCount: noProgress };
      if (noProgress >= RESUME_MAX_NO_PROGRESS || attempt > RESUME_MAX_ATTEMPTS) {
        const preserved = { ...intent, state: "preserved", updatedAt: new Date().toISOString() };
        saveResumeIntentUnlocked(preserved);
        createRecoveryIntentUnlocked({ queueItemId: current.queueItemId, workspaceId: current.workspaceId, ownerScope: current.ownerScope, runId: input.sourceRunId,
          attempt, generation: current.admissionGeneration,
          reason: attempt > RESUME_MAX_ATTEMPTS ? "resume attempts exhausted" : "resume made no progress", requiredAction: "preserve" });
        return structuredClone(preserved);
      }
      saveResumeIntentUnlocked(intent);
      return structuredClone(intent);
    });
  }
  // 只有 FIFO 第一项的 waiting-head intent 可以升级为 pending；其余 follower
  // 保持等待，避免并发唤醒绕过队列串行化。
  function promoteRecoverableHead() {
    return ledger.withLock(() => {
      const head = listQueue().find((entry) => RESUMABLE_QUEUE_STATES.includes(entry.state));
      if (!head) return null;
      const candidate = loadResumeIntentsUnlocked().filter((entry) => entry.queueItemId === head.queueItemId && entry.state === "waiting-head").sort((a, b) => a.attempt - b.attempt).at(-1);
      if (!candidate) return null;
      const next = { ...structuredClone(candidate), state: "pending", updatedAt: new Date().toISOString() };
      saveResumeIntentUnlocked(next);
      return structuredClone(next);
    });
  }
  function markResumeDelivery(resumeIntentId: string, delivery: any) {
    return ledger.withLock(() => {
      const current = resumeLoad(`resume-${id(resumeIntentId, "resumeIntentId")}.json`);
      if (!current) throw new Error("resume intent not found");
      const next = { ...current, delivery: { state: delivery?.state === "delivered" ? "delivered" : "debt", ...(delivery?.reason ? { reason: String(delivery.reason).slice(0, 256) } : {}), attempts: (current.delivery?.attempts ?? 0) + 1 }, updatedAt: new Date().toISOString() };
      saveResumeIntentUnlocked(next); return structuredClone(next);
    });
  }
  function markResumeStarting(resumeIntentId: string, resumedRun?: any) {
    return ledger.withLock(() => {
      const current = resumeLoad(`resume-${id(resumeIntentId, "resumeIntentId")}.json`);
      if (!current) throw new Error("resume intent not found");
      if (current.state === "starting" || current.state === "activated") {
        if (resumedRun?.runId !== undefined && current.resumedRun?.runId !== resumedRun.runId) throw new Error("resume intent already targets another resumed run");
        return structuredClone(current);
      }
      if (current.state !== "pending") throw new Error("resume intent is not pending");
      if (resumedRun !== undefined
          && (!resumedRun?.runId || typeof resumedRun.asyncDir !== "string" || !path.isAbsolute(resumedRun.asyncDir) || !resumedRun?.sessionId
            || !Number.isSafeInteger(resumedRun.pid) || resumedRun.pid < 1 || !resumedRun?.agentProfile)) throw new TypeError("resumed run identity is invalid");
      const next = { ...current, state: "starting", ...(resumedRun !== undefined ? { resumedRun: structuredClone(resumedRun) } : {}), updatedAt: new Date().toISOString() };
      saveResumeIntentUnlocked(next); return structuredClone(next);
    });
  }
  // activation 序列的最后一段：starting → activated；重放幂等，但拒绝与已
  // 记录 resumedRun 不同的再次激活。
  function markResumeActivated(resumeIntentId: string, resumedRun?: any) {
    return ledger.withLock(() => {
      const current = resumeLoad(`resume-${id(resumeIntentId, "resumeIntentId")}.json`);
      if (!current) throw new Error("resume intent not found");
      if (current.state === "activated") {
        if (resumedRun?.runId !== undefined && current.resumedRun?.runId !== resumedRun.runId) throw new Error("resume intent already activated for another resumed run");
        return structuredClone(current);
      }
      if (current.state !== "starting") throw new Error("resume intent is not starting");
      if (!current.resumedRun?.runId) throw new Error("resume intent has no resumed run");
      if (resumedRun?.runId !== undefined && current.resumedRun.runId !== resumedRun.runId) throw new Error("resume activation does not match the starting resumed run");
      const next = { ...current, state: "activated", updatedAt: new Date().toISOString() };
      saveResumeIntentUnlocked(next); return structuredClone(next);
    });
  }
  // Root 授权的 queue 重绑：childRunId 从 source run 换到 resumed run，保留
  // queue lease/admission generation/sequencer；幂等重放不叠加 revision。
  function rebindChildRunForRecovery(input: any) {
    id(input?.queueItemId, "queueItemId"); id(input.resumeIntentId, "resumeIntentId"); id(input.sourceRunId, "sourceRunId"); id(input.resumedRunId, "resumedRunId");
    if (input.sourceRunId === input.resumedRunId) throw new Error("resume rebind must change the child run");
    return ledger.withLock(() => {
      const current = load(`${input.queueItemId}.json`);
      if (!current || !RESUMABLE_QUEUE_STATES.includes(current.state)) throw new Error("queue item is not resumable");
      const intent = loadResumeIntentsUnlocked().find((entry) => entry.resumeIntentId === input.resumeIntentId);
      if (!intent || intent.queueItemId !== current.queueItemId || intent.sourceRunId !== input.sourceRunId) throw new Error("resume intent does not match the queue item");
      if (intent.state !== "starting" && intent.state !== "activated") throw new Error("resume intent is not starting");
      if (intent.generation !== current.admissionGeneration) throw new Error("resume intent generation mismatch");
      if (input.generation !== undefined && input.generation !== intent.generation) throw new Error("resume rebind generation mismatch");
      if (current.childRunId === input.resumedRunId) return structuredClone(current);
      if (current.childRunId !== input.sourceRunId) throw new Error("queue item is bound to another child run");
      const next = { ...current, childRunId: input.resumedRunId, revision: current.revision + 1 };
      save(`${current.queueItemId}.json`, next);
      return structuredClone(next);
    });
  }
  function completeResumeIntent(resumeIntentId: string) {
    return ledger.withLock(() => {
      const current = resumeLoad(`resume-${id(resumeIntentId, "resumeIntentId")}.json`);
      if (!current) throw new Error("resume intent not found");
      if (current.state === "completed") return structuredClone(current);
      if (!RESUME_ACTIVE_STATES.includes(current.state)) throw new Error("resume intent is not active");
      const next = { ...current, state: "completed", updatedAt: new Date().toISOString() };
      saveResumeIntentUnlocked(next); return structuredClone(next);
    });
  }
  function failResumeIntent(resumeIntentId: string) {
    return ledger.withLock(() => {
      const current = resumeLoad(`resume-${id(resumeIntentId, "resumeIntentId")}.json`);
      if (!current) throw new Error("resume intent not found");
      if (current.state === "failed") return structuredClone(current);
      if (!RESUME_ACTIVE_STATES.includes(current.state)) throw new Error("resume intent is not active");
      const next = { ...current, state: "failed", updatedAt: new Date().toISOString() };
      saveResumeIntentUnlocked(next); return structuredClone(next);
    });
  }

  // 终态回执事件（integration-receipt-event.v1）：五个终态写入点
  // （preserveByBinding / completePrepared / transition〔含 cancelItem〕 /
  // settleDispositionQueue）都在既有 ledger.withLock 临界区内追加；幂等键
  // queueItemId+state，已存在则跳过；初始 delivery pending。存储与 resume
  // intents 同形态：queue-receipt-events.json 索引 + 每事件一文件。
  const receiptEventIndexFile = "queue-receipt-events.json";
  const receiptEventFiles = () => ledger.read<string[]>(receiptEventIndexFile, []).filter((name) => ledger.exists(name));
  const receiptEventLoad = (name: string) => ledger.read<any>(name, null);
  const loadReceiptEventsUnlocked = () => receiptEventFiles().map(receiptEventLoad).filter(Boolean);
  function listReceiptEvents(ownerRootSessionId?: string) {
    const events = loadReceiptEventsUnlocked().map((entry) => structuredClone(entry));
    return ownerRootSessionId === undefined ? events : events.filter((entry) => entry.ownerScope?.rootSessionId === ownerRootSessionId);
  }
  // 按 owner 过滤且只含 pending 的回执事件读取（计划 T4，queue.receipt-events 消费）：
  // delivered 已完成 at-least-once 送达、debt 为 child-run 不可用终态，均不再返回。
  function listPendingReceiptEvents(ownerRootSessionId?: string) {
    return listReceiptEvents(ownerRootSessionId).filter((entry) => entry.delivery?.state === "pending");
  }
  // 回执事件 delivery 回写（计划 T4，queue.receipt-event-delivered 消费）：Host 泵
  // notifyExecutionFacts 成功后回写 delivered、childRunId 缺位回写 debt（终态）。
  // 幂等重放收敛：state 覆写、attempts 每次递增；未知 eventId 或 owner 不匹配
  // fail-closed 报错，绝不静默跳过。
  function markReceiptEventDelivery(input: { eventIds: unknown; state: unknown; reason?: unknown; ownerRootSessionId?: string }) {
    const eventIds = Array.isArray(input?.eventIds) ? input.eventIds : [];
    if (eventIds.length === 0 || eventIds.some((eventId) => typeof eventId !== "string" || eventId.length === 0)) throw new TypeError("receipt event ids are required");
    if (input.state !== "delivered" && input.state !== "debt") throw new TypeError("receipt event delivery state is invalid");
    const reason = typeof input.reason === "string" && input.reason ? input.reason.slice(0, 256) : undefined;
    return ledger.withLock(() => {
      const updated: IntegrationReceiptEvent[] = [];
      for (const eventId of eventIds as string[]) {
        const current = loadReceiptEventsUnlocked().find((entry) => entry.eventId === eventId);
        if (!current) throw new Error(`receipt event not found: ${eventId}`);
        if (input.ownerRootSessionId !== undefined && current.ownerScope?.rootSessionId !== input.ownerRootSessionId) throw new Error("receipt event owner scope denied");
        const next: IntegrationReceiptEvent = { ...current, delivery: { state: input.state, ...(reason !== undefined ? { reason } : {}), attempts: (current.delivery?.attempts ?? 0) + 1 } };
        ledger.write(`receipt-event-${eventId}.json`, next);
        updated.push(structuredClone(next));
      }
      return updated;
    });
  }
  // 仅可在 ledger.withLock 临界区内调用；只追加事件，不改变任何既有终态写入行为。
  function appendReceiptEventUnlocked(item: any, state: string) {
    if (state !== "completed" && state !== "preserved" && state !== "cancelled") return null;
    const eventId = `${item.queueItemId}:${state}`;
    const existing = loadReceiptEventsUnlocked().find((entry) => entry.eventId === eventId);
    if (existing) return structuredClone(existing);
    const now = new Date().toISOString();
    const settledAt = state === "completed" ? { completedAt: typeof item.completedAt === "string" ? item.completedAt : now }
      : state === "preserved" ? { preservedAt: typeof item.preservedAt === "string" ? item.preservedAt : now }
      : { cancelledAt: typeof item.cancelledAt === "string" ? item.cancelledAt : now };
    const event: IntegrationReceiptEvent = { version: INTEGRATION_RECEIPT_EVENT_VERSION, eventId, queueItemId: item.queueItemId, workspaceId: item.workspaceId, leaseId: item.leaseId,
      childRunId: typeof item.childRunId === "string" ? item.childRunId : null,
      ownerScope: { kind: item.ownerScope?.kind, rootSessionId: item.ownerScope?.rootSessionId },
      repositoryId: item.repositoryId, state, attempt: item.attempt, revision: item.revision,
      ...(typeof item.candidateHead === "string" ? { candidateHead: item.candidateHead } : {}),
      ...(typeof item.integrationIntentId === "string" ? { integrationIntentId: item.integrationIntentId } : {}),
      ...(typeof item.workspaceDispositionReceiptId === "string" ? { workspaceDispositionReceiptId: item.workspaceDispositionReceiptId } : {}),
      ...settledAt,
      delivery: { state: "pending", attempts: 0 } };
    const name = `receipt-event-${eventId}.json`;
    ledger.write(name, event);
    const names = receiptEventFiles();
    if (!names.includes(name)) ledger.write(receiptEventIndexFile, [...names, name]);
    return structuredClone(event);
  }

  function mutateRecovery(input: any, action: string) {
    return ledger.withLock(() => {
      const current = recoveryLoad(`recovery-${input.recoveryIntentId}.json`);
      if (!current || current.ownerScope?.rootSessionId !== input.ownerScope?.rootSessionId) throw new Error("recovery intent owner scope denied");
      if (input.generation !== undefined && input.generation !== current.generation) throw new Error("recovery intent generation mismatch");
      if (current.state !== "preserved" && action !== "status") throw new Error("recovery intent already settled");
      const next = { ...current, state: action === "status" ? current.state : action, generation: action === "retry" ? current.generation + 1 : current.generation, updatedAt: new Date().toISOString() };
      ledger.write(`recovery-${current.recoveryIntentId}.json`, next); return structuredClone(next);
    });
  }
  const load = (name: string) => ledger.read<any>(name, null);
  const save = (name: string, value: any) => ledger.write(name, value);
  function enqueueIntegration(request: any) {
    id(request?.requestId, "requestId"); id(request.workspaceId, "workspaceId"); digest(request.repositoryId, "repositoryId");
    if (request.repositoryId !== repositoryId) throw new Error("repository scope mismatch");
    if (request.strategy !== "rebase-ff") throw new Error("unsupported integration strategy");
    return ledger.withLock(() => {
      const names = files(); const existing = names.map(load).find((entry) => entry.requestId === request.requestId);
      const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      if (existing) { if (existing.requestHash !== requestHash) throw new Error("requestId idempotency conflict"); return structuredClone(existing); }
      if (names.map(load).some((entry) => entry.workspaceId === request.workspaceId && !["completed", "cancelled", "preserved"].includes(entry.state))) throw new Error("workspace is already queued");
      const sequence = Number(ledger.read<any>(metaFile, { nextSequence: 1 }).nextSequence);
      const entry = { version: INTEGRATION_QUEUE_RECORD_VERSION, queueItemId: randomUUID(), requestId: request.requestId, requestHash, repositoryId, sequence,
        workspaceId: request.workspaceId, leaseId: id(request.leaseId, "leaseId"), ownerScope: structuredClone(request.ownerScope), strategy: request.strategy,
        ...(request.childRunId === undefined ? {} : { childRunId: id(request.childRunId, "childRunId") }),
        targetRef: id(request.targetRef, "targetRef"), authorizedWorkspaceHead: commit(request.authorizedWorkspaceHead, "authorizedWorkspaceHead"), ...(request.observedTargetHead === null || request.observedTargetHead === undefined ? {} : { observedTargetHead: commit(request.observedTargetHead, "observedTargetHead") }),
        autoManaged: request.autoManaged === true, admissionGeneration: 0, attempt: request.attempt ?? 1, state: "queued", revision: 0 };
      save(`${entry.queueItemId}.json`, entry); save(metaFile, { nextSequence: sequence + 1 }); save("queue-index.json", [...names, `${entry.queueItemId}.json`]); return structuredClone(entry);
    });
  }
  function listQueue() { return files().map(load).filter(Boolean).sort((a, b) => a.sequence - b.sequence).map((entry) => structuredClone(entry)); }
  function claimNext(instanceIdentity: any, admission?: (entry: any) => any) {
    id(instanceIdentity?.instanceId, "instanceId");
    return ledger.withLock(() => {
      if (listQueue().some((entry) => entry.state === "admitted" || entry.state === "rebasing" || entry.state === "resolving-conflict" || entry.state === "prepared")) return null;
      const current = listQueue().find((entry) => entry.state === "queued"); if (!current) return null;
      const admitted = admission?.(structuredClone(current)) ?? {};
      const now = new Date().toISOString(); const next = { ...current, ...admitted, state: "admitted", claimRevision: current.revision + 1, revision: current.revision + 1,
        daemonClaim: { ...instanceIdentity }, queueLeaseId: randomUUID(), childAdmissionLeaseId: randomUUID(), admissionGeneration: current.admissionGeneration + 1, claimedAt: now };
      save(`${current.queueItemId}.json`, next); return structuredClone(next);
    });
  }
  function getItem(queueItemId: string) { const current = load(`${id(queueItemId, "queueItemId")}.json`); return current ? structuredClone(current) : null; }
  // child 自有 commit 使 HEAD 前进为旧授权头的后代时刷新授权头（coordinator
  // 侧已校验后代关系）；revision+1，幂等重复刷新不叠加。
  function refreshAuthorizedWorkspaceHead(input: any) {
    id(input?.queueItemId, "queueItemId"); commit(input.authorizedWorkspaceHead, "authorizedWorkspaceHead");
    return ledger.withLock(() => {
      const current = load(`${input.queueItemId}.json`);
      if (!current || current.state !== "queued" || current.autoManaged !== true) throw new Error("queue item is not refreshable");
      if (current.authorizedWorkspaceHead === input.authorizedWorkspaceHead) return structuredClone(current);
      const next = { ...current, authorizedWorkspaceHead: input.authorizedWorkspaceHead, revision: current.revision + 1 };
      save(`${current.queueItemId}.json`, next);
      return structuredClone(next);
    });
  }
  function findByBinding(binding: any) {
    return listQueue().filter((entry) => entry.workspaceId === binding?.workspaceId && entry.leaseId === binding?.leaseId
      && entry.childRunId === binding?.runId && entry.ownerScope?.kind === binding?.ownerScope?.kind
      && entry.ownerScope?.rootSessionId === binding?.ownerScope?.rootSessionId).at(-1) ?? null;
  }
  function preserveByBinding(binding: any, reason: string) {
    id(reason, "preserveReason");
    return ledger.withLock(() => {
      const current = findByBinding(binding);
      if (!current || ["completed", "preserved", "cancelled"].includes(current.state)) return current;
      const next = { ...current, state: "preserved", revision: current.revision + 1, preservedAt: new Date().toISOString(), preserveReason: reason.slice(0, 160) };
      save(`${current.queueItemId}.json`, next);
      appendReceiptEventUnlocked(next, "preserved");
      return structuredClone(next);
    });
  }
  function prepareCandidate(input: any) {
    return ledger.withLock(() => {
      const current = load(`${id(input.queueItemId, "queueItemId")}.json`);
      if (!current || !["admitted", "rebasing", "resolving-conflict", "prepared"].includes(current.state)
          || current.queueLeaseId !== input.queueLeaseId || current.admissionGeneration !== input.admissionGeneration) throw new Error("queue lease, generation, or state mismatch");
      commit(input.candidateHead, "candidateHead");
      if (current.state === "prepared") {
        if (current.candidateHead !== input.candidateHead) throw new Error("prepared candidate is immutable");
        return structuredClone(current);
      }
      const next = { ...current, state: "prepared", candidateHead: input.candidateHead, revision: current.revision + 1, preparedAt: new Date().toISOString() };
      save(`${current.queueItemId}.json`, next); return structuredClone(next);
    });
  }
  function completePrepared(input: any) {
    return ledger.withLock(() => {
      const current = load(`${id(input.queueItemId, "queueItemId")}.json`);
      if (!current || current.state !== "prepared" || current.queueLeaseId !== input.queueLeaseId
          || current.candidateHead !== input.candidateHead) throw new Error("prepared queue lease or candidate mismatch");
      const next = { ...current, state: "completed", integrationIntentId: id(input.integrationIntentId, "integrationIntentId"),
        workspaceDispositionReceiptId: id(input.workspaceDispositionReceiptId, "workspaceDispositionReceiptId"), revision: current.revision + 1, completedAt: new Date().toISOString() };
      save(`${current.queueItemId}.json`, next);
      appendReceiptEventUnlocked(next, "completed");
      // 队列项完成即关闭其 active resume intent；下一 waiting-head intent 由
      // coordinator 的 pump 在完成路径上升级并投递。
      const activeResume = loadResumeIntentsUnlocked().find((entry) => entry.queueItemId === current.queueItemId && RESUME_ACTIVE_STATES.includes(entry.state));
      if (activeResume) saveResumeIntentUnlocked({ ...structuredClone(activeResume), state: "completed", updatedAt: new Date().toISOString() });
      return structuredClone(next);
    });
  }
  function markResolvingConflict(input: any) {
    return ledger.withLock(() => {
      const current = load(`${id(input.queueItemId, "queueItemId")}.json`);
      if (!current || !["admitted", "rebasing", "resolving-conflict"].includes(current.state) || current.queueLeaseId !== input.queueLeaseId
          || (input.admissionGeneration !== undefined && current.admissionGeneration !== input.admissionGeneration)) throw new Error("queue lease, generation, or state mismatch");
      if (input.conflictDigest === undefined) {
        const next = { ...current, state: "resolving-conflict", revision: current.revision + 1 };
        save(`${current.queueItemId}.json`, next); return structuredClone(next);
      }
      digest(input.conflictDigest, "conflictDigest");
      const noProgress = current.conflictDigest === input.conflictDigest;
      const continuationAttempt = noProgress ? (current.continuationAttempt ?? 0) : (current.continuationAttempt ?? 0) + 1;
      const next = { ...current, state: "resolving-conflict", conflictDigest: input.conflictDigest, continuationAttempt, revision: current.revision + 1 };
      save(`${current.queueItemId}.json`, next); return structuredClone({ ...next, noProgress });
    });
  }
  function completeItem(receipt: any) { return transition(receipt, "completed"); }
  function failItem(receipt: any) { return transition(receipt, "preserved"); }
  function cancelItem(receipt: any, authorization: any = {}) {
    if (authorization.authorized !== true) throw new Error("authorized cancel is required");
    return transition(receipt, "cancelled");
  }
  const settlementIndex = "disposition-settlement-index.json";
  function settlementFile(settlementId: string) { return `disposition-${id(settlementId, "settlementId")}.json`; }
  function validateDispositionIntent(value: any, name: string) {
    if (!value || Object.keys(value).length !== 5 || value.schemaVersion !== "workspace-queue-settlement-intent.v1"
        || !isPreparedWorkspaceDisposition(value.prepared) || name !== settlementFile(value.prepared.settlementId)
        || !["authorized", "workspace-committed", "queue-committed", "settled"].includes(value.phase)
        || value.workspaceReceiptRef !== (value.phase === "authorized" ? null : `wsr-${value.prepared.settlementId}`)
        || value.queueReceiptRef !== (["queue-committed", "settled"].includes(value.phase) ? `qsr-${value.prepared.settlementId}` : null)) throw new Error("invalid settlement intent");
    return value;
  }
  function listDispositionIntents(): any[] {
    return ledger.read<string[]>(settlementIndex, []).map(name => {
      if (typeof name !== "string" || !/^disposition-[A-Za-z0-9._-]+\.json$/.test(name) || name.includes("..")) throw new Error("invalid settlement index");
      const value = ledger.read<any>(name, null);
      validateDispositionIntent(value, name);
      return structuredClone(value);
    });
  }
  function recordDispositionIntent(prepared: PreparedWorkspaceDispositionV1) {
    if (!isPreparedWorkspaceDisposition(prepared)) throw new Error("invalid prepared disposition");
    return ledger.withLock(() => {
      const name = settlementFile(prepared.settlementId);
      const existing = ledger.read<any>(name, null);
      if (existing) {
        validateDispositionIntent(existing, name);
        const prior = existing.prepared;
        for (const field of ["settlementId", "operation", "reason", "binding", "authorizedRevision", "snapshotHash", "proofHash", "executorHead"]) {
          if (JSON.stringify(prior?.[field]) !== JSON.stringify(prepared[field])) throw new Error("settlement intent identity mismatch");
        }
      }
      const next = existing ?? { schemaVersion: "workspace-queue-settlement-intent.v1", prepared: structuredClone(prepared), phase: "authorized", workspaceReceiptRef: null, queueReceiptRef: null };
      ledger.write(name, next);
      const names = ledger.read<string[]>(settlementIndex, []);
      if (!names.includes(name)) ledger.write(settlementIndex, [...names, name]);
      return structuredClone(next);
    });
  }
  function advanceDispositionIntent(settlementId: string, phase: string) {
    return ledger.withLock(() => {
      const name = settlementFile(settlementId);
      const value = ledger.read<any>(name, null);
      const phases = ["authorized", "workspace-committed", "queue-committed", "settled"];
      if (!value || !phases.includes(phase)) throw new Error("settlement intent is unavailable");
      validateDispositionIntent(value, name);
      if (phases.indexOf(value.phase) >= phases.indexOf(phase)) return value;
      if (phases.indexOf(phase) !== phases.indexOf(value.phase) + 1) throw new Error("settlement phase cannot skip an effect");
      const next = { ...value, phase, workspaceReceiptRef: `wsr-${settlementId}`, queueReceiptRef: ["queue-committed", "settled"].includes(phase) ? `qsr-${settlementId}` : null };
      ledger.write(name, next);
      return structuredClone(next);
    });
  }
  function verifyDispositionBinding(prepared: PreparedWorkspaceDispositionV1) {
    if (!isPreparedWorkspaceDisposition(prepared)) throw new Error("invalid prepared disposition");
    const b = prepared.binding;
    if (!b.queueItemId) return;
    const current = getItem(b.queueItemId);
    if (!current || current.workspaceId !== b.workspaceId || current.leaseId !== b.leaseId || current.childRunId !== b.runId
        || current.ownerScope?.rootSessionId !== b.rootSessionId || current.ownerScope?.kind !== "standalone-subagent"
        || (current.queueLeaseId ?? null) !== b.queueLeaseId || current.admissionGeneration !== b.admissionGeneration
        || (current.dispositionSettlementId === prepared.settlementId
          ? current.dispositionReceiptRef !== `qsr-${prepared.settlementId}` || !["completed", "cancelled", "preserved"].includes(current.state)
          : current.revision !== b.queueRevision)) throw new Error("settlement queue binding or revision mismatch");
  }
  function settleDispositionQueue(prepared: PreparedWorkspaceDispositionV1) {
    return ledger.withLock(() => {
      verifyDispositionBinding(prepared);
      const b = prepared.binding;
      if (!b.queueItemId) return { receiptRef: `qsr-${prepared.settlementId}` };
      const current = getItem(b.queueItemId);
      if (!current || current.workspaceId !== b.workspaceId || current.leaseId !== b.leaseId || current.childRunId !== b.runId
          || current.ownerScope?.rootSessionId !== b.rootSessionId || current.ownerScope?.kind !== "standalone-subagent"
          || (current.queueLeaseId ?? null) !== b.queueLeaseId || current.admissionGeneration !== b.admissionGeneration) throw new Error("settlement queue binding mismatch");
      let settled = current;
      if (current.dispositionSettlementId !== prepared.settlementId) {
        if (current.revision !== b.queueRevision) throw new Error("settlement queue revision changed");
        const terminal = ["completed", "cancelled", "preserved"].includes(current.state);
        settled = { ...current, state: terminal ? current.state : prepared.operation === "preserve" ? "preserved" : "cancelled",
          revision: current.revision + 1, dispositionSettlementId: prepared.settlementId, dispositionReceiptRef: `qsr-${prepared.settlementId}` };
        save(`${current.queueItemId}.json`, settled);
      } else if (current.dispositionReceiptRef !== `qsr-${prepared.settlementId}` || !["completed", "cancelled", "preserved"].includes(current.state)) throw new Error("settlement queue receipt mismatch");
      // 终态回执事件：首写与重放都经过这里，queueItemId+state 幂等去重，
      // 覆盖「队列项已写终态、事件尚未落盘」的崩溃窗口。
      appendReceiptEventUnlocked(settled, settled.state);
      // 同一锁下写队列终态和匹配 handoff；单个文件写后崩溃仍由此分支幂等补齐。
      for (const intent of loadResumeIntentsUnlocked()) {
        if (intent.queueItemId === b.queueItemId && intent.workspaceId === b.workspaceId && intent.sourceRunId === b.runId
            && intent.ownerScope?.rootSessionId === b.rootSessionId && RESUME_ACTIVE_STATES.includes(intent.state)) {
          saveResumeIntentUnlocked({ ...intent, state: "completed", updatedAt: new Date().toISOString() });
        }
      }
      for (const name of recoveryFiles()) {
        const intent = recoveryLoad(name);
        if (intent?.queueItemId === b.queueItemId && intent.workspaceId === b.workspaceId && intent.runId === b.runId
            && intent.ownerScope?.rootSessionId === b.rootSessionId && intent.state === "preserved") {
          ledger.write(name, { ...intent, state: prepared.operation === "preserve" ? "preserved" : "discarded", delivery: { ...intent.delivery, state: "delivered" }, updatedAt: new Date().toISOString() });
        }
      }
      return { receiptRef: `qsr-${prepared.settlementId}` };
    });
  }
  function retryItem(receipt: any) {
    return ledger.withLock(() => {
      const current = load(`${id(receipt.queueItemId, "queueItemId")}.json`);
      if (!current || !["admitted", "blocked", "preserved"].includes(current.state) || current.queueLeaseId !== receipt.queueLeaseId || current.revision !== receipt.revision) throw new Error("queue lease or revision mismatch");
      const names = files(); const sequence = Number(ledger.read<any>(metaFile, { nextSequence: 1 }).nextSequence);
      const next = { ...current, queueItemId: randomUUID(), requestId: `${current.requestId}:attempt-${current.attempt + 1}`, sequence, attempt: current.attempt + 1, admissionGeneration: 0, revision: 0, state: "queued" };
      for (const field of ["daemonClaim", "queueLeaseId", "childAdmissionLeaseId", "claimRevision", "claimedAt", "admittedTargetHead", "candidateHead", "preparedAt", "integrationIntentId", "workspaceDispositionReceiptId", "completedAt"]) delete next[field];
      save(`${next.queueItemId}.json`, next); save(metaFile, { nextSequence: sequence + 1 }); save("queue-index.json", [...names, `${next.queueItemId}.json`]);
      return structuredClone(next);
    });
  }
  function transition(receipt: any, state: string) { return ledger.withLock(() => { const current = load(`${id(receipt.queueItemId, "queueItemId")}.json`); const allowed = state === "preserved" ? ["admitted", "rebasing", "resolving-conflict", "prepared", "blocked"] : ["admitted"]; if (!current || !allowed.includes(current.state) || current.queueLeaseId !== receipt.queueLeaseId || current.revision !== receipt.revision) throw new Error("queue lease or revision mismatch"); const next = { ...current, state, revision: current.revision + 1 }; save(`${current.queueItemId}.json`, next); appendReceiptEventUnlocked(next, state); return structuredClone(next); }); }
  function recoverClaims(instanceIdentity: any) { return ledger.withLock(() => { const recovered: any[] = []; for (const current of listQueue()) if (current.state === "admitted" && current.daemonClaim && current.daemonClaim.instanceId === instanceIdentity.instanceId) {
    const status = processAliveStatus(instanceIdentity.pid ?? current.daemonClaim.pid, instanceIdentity.birthIdentity ?? current.daemonClaim.birthIdentity);
    if (status.state === "undetermined") diagnose({ version: 1, phase: "integration-queue-owner-liveness-undetermined", state: status.state, error: status.error, cause: (status.error as any)?.cause, errno: status.errno, instanceId: instanceIdentity.instanceId });
    if (status.state === "dead" || status.state === "mismatch") { const next = { ...current, state: "queued", revision: current.revision + 1, daemonClaim: undefined, queueLeaseId: undefined, childAdmissionLeaseId: undefined }; save(`${current.queueItemId}.json`, next); recovered.push(next); }
  } return recovered; }); }
  return Object.freeze({ enqueueIntegration, claimNext, getItem, findByBinding, preserveByBinding, prepareCandidate, completePrepared, markResolvingConflict, completeItem, failItem, cancelItem, retryItem, recoverClaims, listQueue, recoveryIntent, listRecoveryIntents, mutateRecovery, markRecoveryDelivery, notificationDeliveryDebt,
    requestChildResume, promoteRecoverableHead, markResumeDelivery, markResumeStarting, markResumeActivated, completeResumeIntent, failResumeIntent, listResumeIntents, rebindChildRunForRecovery, refreshAuthorizedWorkspaceHead, listReceiptEvents, listPendingReceiptEvents, markReceiptEventDelivery,
    recordDispositionIntent, advanceDispositionIntent, listDispositionIntents, verifyDispositionBinding, settleDispositionQueue });
}
