import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PlanLineageResolution, PlanRunFacts, PlanRunRef } from "../src/execution/index.ts";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import {
  readSessionIdentity,
  registerBuiltinAgentsViaEvents,
  resolveCurrentSessionId,
  upstreamSubagentRuntime,
} from "../src/compat/pi-subagents-0.75.ts";
import { registerCompletionNotices } from "../src/tui/completion-notices.ts";
import { formatCompactSubagentWorkspaceReminder } from "../src/tui/compact-rendering.ts";
import { createSubagentToolRenderers } from "../src/tui/tool-renderers.ts";
// 保留既有入口导出供调用方使用；renderer 实现由 package TUI 层拥有。
export { createSubagentToolRenderers } from "../src/tui/tool-renderers.ts";
import { createSubagentDispatchTrace, createSubagentDispatchTraceFileSink, installHeadlessTypedSubagentRuntime } from "../src/subagent-dispatch/extension.ts";
import { captureSupervisorCorrelation, reconcileSupervisorConsumption } from "../src/subagent-dispatch/supervisor-consumption.ts";
import { registerConfiguredChildToolCeiling } from "../src/subagent-dispatch/child-tool-policy.ts";
import { createSupervisorControlPlane, supervisorCanonicalDigest } from "../src/subagent-dispatch/supervisor-control-plane.ts";
import { createSupervisorRuntimeReader } from "../src/subagent-dispatch/supervisor-runtime-source.ts";
import { createRenewableTypedSubagentRpcClient, createTypedSubagentRpcClient } from "../src/subagent-dispatch/rpc-client.ts";
import { createCoordinatorProofOutbox } from "../src/subagent-dispatch/coordinator-proof-outbox.ts";
import { createIntegrationQueue } from "../src/workspace/integration-queue.ts";
import { classifyTerminalProofBinding } from "../src/subagent-dispatch/terminal-proof-binding.ts";
import { resolveRootSessionId } from "../src/subagent-dispatch/root-broker-protocol.ts";
import { createRunAuthorization } from "../src/subagent-dispatch/run-authorization.ts";
import { createManualIntegrationHandoff, parseIntegrationResumeIntentV1 } from "../src/subagent-dispatch/recovery-resume-contract.ts";
import { COORDINATOR_OPERATIONS } from "../src/subagent-dispatch/root-broker-protocol.ts";
import { closeAndUnbindRootBroker, inspectRootBrokerExecutionProof, registerRootBrokerAuthorizedRun, startAndBindRootBroker } from "../src/subagent-dispatch/root-broker-registry.ts";
import { RootBrokerServer, rootBrokerTerminalProofId, type TerminalProofDeliveryOutcome } from "../src/subagent-dispatch/root-broker-server.ts";
import { AuthorityStore } from "../src/subagent-dispatch/authority-store.ts";
import { rootBrokerRegistryEntry } from "../src/subagent-dispatch/root-broker-registry.ts";
import { createTrustedRunBindingResolver } from "../src/subagent-dispatch/run-binding-resolver.ts";
import { createLazyCoordinator } from "../src/workspace/coordinator-client.ts";
import { canonicalWorkspaceStateRoot, createCoordinatorRegistry } from "../src/workspace/coordinator-registry.ts";
import { ensureCoordinatorDaemon } from "../src/workspace/coordinator-spawn.ts";
import { createManagedWorkspaceLedger } from "../src/workspace/ledger.ts";
import { resolveRepositoryIdentity } from "../src/workspace/repository-identity.ts";
import { createManagedWorkspaceService } from "../src/workspace/service.ts";
import { createCoordinatorDispositionFacade } from "../src/workspace/disposition-facade.ts";
import { createWorkspaceCompletionReminder } from "../src/workspace/completion-reminder.ts";
import { bindManagedWorkspaceServiceSession, unbindManagedWorkspaceServiceSession } from "../src/workspace/registry.ts";
import { descriptorBrokerBindingReplay, readResumeTargetDescriptor, resolveAsyncRunsRootDir } from "../src/subagent-dispatch/resume-lineage.ts";

export function shouldStartRepositoryCoordinator(cwd: string): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return false;
  }
}

/** 非 Git Host 只接受 canonical 一层普通仓库；不发现目录、不接受 child 路径。 */
export async function admitHostRepositoryOrigin(hostCwd: string, requestedCwd: string) {
  const hostRoot = realpathSync(hostCwd);
  const root = realpathSync(requestedCwd);
  const identity = await resolveRepositoryIdentity(requestedCwd);
  const gitRoot = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim());
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8" }).trim();
  if (root !== requestedCwd || path.dirname(root) !== hostRoot || gitRoot !== root
      || realpathSync(identity.originRoot) !== root || identity.migrationDebt
      || gitDir !== path.join(root, ".git") || identity.commonDir !== gitDir) {
    throw Object.assign(new Error("Host requires a canonical direct ordinary repository"), { code: "HOST_REPOSITORY_TOPOLOGY_INVALID" });
  }
  return identity;
}

// T1 ledger 逐记录诊断的安全转发：诊断只包含 repository partition、
// workspaceId、schema/error code 与可结构化解析的 owner 投影，不含 ownerToken、
// lease token 或私有原始路径；sink 自身失败不影响选路，只记录 sink 故障。
function forwardLedgerInvalidRecord(sink: ((entry: unknown) => void) | undefined, diagnostic: unknown) {
  try {
    sink?.({ version: 1, phase: "managed-workspace-invalid-record-skipped", diagnostic });
  } catch (diagnosticError) {
    console.error("[subagent-runtime] managed workspace ledger diagnostic sink failed", diagnosticError);
  }
}

/** 连接只持有仓库资源；独立单仓库调用方可保留既有 broker 接线。 */
export async function connectRuntimeCoordinator({ pi, cwd, broker, stateRoot, rpc, diagnosticSink, bindBrokerCallbacks = true }: { pi: object; cwd: string; broker: RootBrokerServer; stateRoot?: string; rpc?: any; diagnosticSink?: (entry: unknown) => void; bindBrokerCallbacks?: boolean }) {
  if (!shouldStartRepositoryCoordinator(cwd) || typeof stateRoot !== "string" || stateRoot.length === 0) return undefined;
  const identity = await resolveRepositoryIdentity(cwd);
  const registry = createCoordinatorRegistry({ commonDir: identity.commonDir, stateRoot });
  const canonicalStateRoot = canonicalWorkspaceStateRoot(stateRoot);
  // 懒加载（D1/D2）：仓库选择阶段零 claim、零 listen、零连接；首个需要类
  // 操作在 spawn 锁内拉起独立 daemon，Host 持久连接即引用（D3）。
  const lazy = createLazyCoordinator({
    identity,
    brokerRegistration: () => rootBrokerRegistryEntry(pi, broker.rootSessionId),
    ensure: async () => (await ensureCoordinatorDaemon({
      stateRoot, repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId,
      commonDir: identity.commonDir, endpoint: registry.endpoint,
      // 归零宽限可由环境覆盖（测试用小宽限快速观察自退；生产缺省 60s）。
      idleExitGraceMs: Number(process.env.PI_COORDINATOR_IDLE_EXIT_GRACE_MS) || undefined,
    })).metadata,
    readMetadata: async () => { try { return await registry.read(); } catch { return undefined; } },
  });
  const requireClient = () => lazy.requireClient();
  const preferClient = () => lazy.preferClient();
  const proofOwnerScope = Object.freeze({ kind: "standalone-subagent" as const, rootSessionId: broker.rootSessionId });
  // One durable proof outbox shared with the coordinator daemon; the broker
  // writes pending/debt entries when the daemon cannot settle them.
  const proofOutbox = createCoordinatorProofOutbox(path.join(canonicalStateRoot, "repositories", identity.storageRepositoryId, "terminal-proof-outbox"));
  // run-only 绑定解析：ledger 即绑定权威（coordinator 读同一 ledger），直读
  // scoped 记录不依赖 daemon（D5 利用类）；唯一性/身份校验仍由 resolver 执行，
  // same-owner/unknown invalid 与 v2-invalid 在直读中抛错 fail-closed。
  const ledgerInvalidSink = (diagnostic: unknown) => forwardLedgerInvalidRecord(diagnosticSink, diagnostic);
  const scopedLedgerRecords = (runId: string) => createManagedWorkspaceLedger({ stateRoot: canonicalStateRoot })
    .listScoped({ owner: proofOwnerScope, onInvalid: ledgerInvalidSink })
    .filter((record: any) => record.run?.runId === runId);
  const bindingResolver = createTrustedRunBindingResolver({
    listOwned: async (input: { runId: string }) => scopedLedgerRecords(input.runId),
  }, {
    rootSessionId: broker.rootSessionId,
    readLedger: (runId: string) => scopedLedgerRecords(runId),
  });
  let closing = false;
  // D7 轮询泵：daemon 无 pi.sendMessage 快路径，Host 持引用期间以固定间隔轮询
  // resume intents 并等价送达 handoff followUp；送达后幂等回写 delivered，失败
  // 保留 debt 由下一轮重放（极端下可能重复触发一次 followUp，消费方幂等）。无
  // 引用（daemon 未拉起）时泵空转跳过，不破坏 F1 懒加载语义。
  let pumpBusy = false;
  const pumpResumeHandoffs = async () => {
    if (closing || pumpBusy || !lazy.hasClient()) return;
    pumpBusy = true;
    // 外层 finally 覆盖置 busy 之后的全部分支：preferClient/recoveryStatus 等
    // 瞬时 RPC 故障只放弃本轮，不得让 busy 位永久卡死后续 handoff 投递。异常
    // 结果与诊断边界保持原样（finally 不吞异常，本轮仍无自动 resume）。
    try {
      let client: Awaited<ReturnType<typeof lazy.preferClient>>;
      try { client = await lazy.preferClient(); } catch { return; }
      if (!client) return;
      let intents: unknown;
      try { intents = await client.recoveryStatus(); } catch { return; }
      for (const intent of Array.isArray(intents) ? intents : []) {
        const entry = intent as { requiredAction?: string; state?: string; delivery?: { state?: string }; resumeIntentId?: string; queueItemId?: string; workspaceId?: string; leaseId?: string; ownerScope?: unknown; sourceRunId?: string };
        if (entry?.requiredAction !== "resume-child" || entry.state !== "pending" || entry.delivery?.state === "delivered") continue;
        if (typeof entry.resumeIntentId !== "string" || typeof entry.sourceRunId !== "string" || typeof entry.workspaceId !== "string" || typeof entry.queueItemId !== "string") continue;
        // 存储 intent 不携带 handoff（daemon 侧临时构造）；此处同样重建后经
        // pi.sendMessage 送达，等价旧 in-process sink 快路径。
        const handoff = createManualIntegrationHandoff({ resumeIntentId: entry.resumeIntentId, sourceRunId: entry.sourceRunId, workspaceId: entry.workspaceId, queueItemId: entry.queueItemId });
        try {
          await (pi as any).sendMessage(handoff, { deliverAs: "followUp", triggerTurn: true });
          await client.resumeDelivered({ resumeIntentId: entry.resumeIntentId, workspaceId: entry.workspaceId, leaseId: entry.leaseId, ownerScope: entry.ownerScope, authorization: "root", reason: "host handoff delivered" });
          diagnosticSink?.({ version: 1, phase: "recovery-handoff-pumped", resumeIntentId: entry.resumeIntentId, sourceRunId: entry.sourceRunId });
        } catch (error) {
          diagnosticSink?.({ version: 1, phase: "recovery-handoff-pump-failed", error, cause: (error as { cause?: unknown })?.cause, resumeIntentId: entry.resumeIntentId, sourceRunId: entry.sourceRunId });
        } finally {
          try { broker.notifyExecutionFacts(entry.sourceRunId); } catch { /* 通知失败不影响下一轮 */ }
        }
      }
    } finally {
      pumpBusy = false;
    }
  };
  // D7 回执事件泵（计划 T4）：与 pumpResumeHandoffs 共用同一 5s 定时器，同
  // closing/busy/!lazy.hasClient() 门控（独立 busy 位，互不饿死），daemon 缺位空转。
  // 判定经模块级纯函数 resolveReceiptEventPumpPlan 分组，接线保持薄层：toDebt
  // （childRunId=null）回写 debt 终态；toNotify 先 broker.notifyExecutionFacts
  // （重复通知幂等无害）再回写 delivered；回写 RPC 失败保持 pending，下一轮重试
  // （at-least-once）。
  let receiptPumpBusy = false;
  const pumpReceiptEvents = async () => {
    if (closing || receiptPumpBusy || !lazy.hasClient()) return;
    receiptPumpBusy = true;
    try {
      const client = await lazy.preferClient();
      if (!client) return;
      let events: unknown;
      try { events = await client.receiptEvents(); } catch { return; }
      const plan = resolveReceiptEventPumpPlan(events);
      for (const debt of plan.toDebt) {
        try {
          await client.receiptEventDelivered({ eventIds: [debt.eventId], state: "debt", reason: debt.reason, authorization: "root", ownerScope: debt.ownerScope });
          diagnosticSink?.({ version: 1, phase: "receipt-event-debt-recorded", eventId: debt.eventId });
        } catch (error) {
          diagnosticSink?.({ version: 1, phase: "receipt-event-debt-record-failed", error, cause: (error as { cause?: unknown })?.cause, eventId: debt.eventId });
        }
      }
      for (const notify of plan.toNotify) {
        try {
          broker.notifyExecutionFacts(notify.childRunId);
          await client.receiptEventDelivered({ eventIds: [notify.eventId], state: "delivered", authorization: "root", ownerScope: notify.ownerScope, reason: "host execution facts notified" });
          diagnosticSink?.({ version: 1, phase: "receipt-event-pumped", eventId: notify.eventId, childRunId: notify.childRunId });
        } catch (error) {
          // 回写失败保持 pending：下一轮重试（重复 notify 幂等无害，at-least-once）。
          diagnosticSink?.({ version: 1, phase: "receipt-event-pump-failed", error, cause: (error as { cause?: unknown })?.cause, eventId: notify.eventId, childRunId: notify.childRunId });
        }
      }
    } finally {
      receiptPumpBusy = false;
    }
  };
  const pumpHandle: NodeJS.Timeout | undefined = setInterval(() => { void pumpResumeHandoffs(); void pumpReceiptEvents(); }, 5_000);
  pumpHandle.unref?.();
  const coordinatorRequest: NonNullable<RootBrokerServer["coordinatorRequest"]> = async (runId, operation, input) => {
    if (closing) throw new Error("repository connection is closing");
    if (!COORDINATOR_OPERATIONS.includes(operation as any)) throw new Error("unsupported coordinator operation");
    // child 经 Root Broker 转发的集成操作是懒加载触发点（D2）：按需拉起并持有引用。
    const client = await requireClient();
    const binding = await bindingResolver.resolve(runId);
    const methods = {
      enqueue: client.enqueueIntegration,
      await_admission: client.awaitIntegrationAdmission,
      report_conflict: client.reportResolvingConflict,
      publish: client.publishRebasedCandidate,
      fail: client.abandonIntegration,
      inspect_integration_state: client.inspectIntegrationState,
      preserve_integration_debt: client.preserveIntegrationDebt,
      prepare_auto_integration: client.prepareAutoIntegration,
      inspect_auto_integration: client.inspectAutoIntegration,
      // The child wire input stays empty. coordinatorRequest adds the binding
      // resolved from the trusted run registration before this socket call.
      advance_auto_integration: client.advanceAutoIntegration,
    } as Record<string, (value: any) => Promise<unknown>>;
    const method = methods[operation as string];
    if (typeof method !== "function") throw new Error("unsupported coordinator operation");
    return method({ ...input, ...binding });
  };
  const recordTerminalProof: NonNullable<RootBrokerServer["recordTerminalProof"]> = async (run, proof): Promise<TerminalProofDeliveryOutcome> => {
    if (closing) throw new Error("repository connection is closing");
    const proofId = rootBrokerTerminalProofId(proof);
    const outcome = await classifyTerminalProofBinding({
      // 绑定复查（利用类，D5）：直读 ledger（与 coordinator 权威同源），daemon
      // 缺位不拉起；proof 结算（需要类）经 requireClient 触发拉起。
      client: {
        listOwned: async (input: { runId: string }) => scopedLedgerRecords(input.runId),
        recordTerminalProof: async (input: any) => (await requireClient()).recordTerminalProof(input),
      },
      proofOutbox,
      readLedger: () => scopedLedgerRecords(run.runId),
      // 跨 owner scope 复查：scoped 查询为空时区分「run 真没有 workspace」与
      // 「workspace 挂在别的 owner scope 下」（后者记债暴露，不静默）。无 owner
      // 的复查只跳过明确 v1 legacy 并记诊断（T1 合同）；v2/未知 schema 仍抛错，
      // 由模块内 debt 分支处置，不降级为 not-applicable。
      readCrossScope: () => createManagedWorkspaceLedger({ stateRoot: canonicalStateRoot })
        .list({ onInvalid: ledgerInvalidSink }).filter((record: any) => record.run?.runId === run.runId),
      run,
      proof,
      proofId,
      proofOwnerScope,
      rootSessionId: broker.rootSessionId,
      buildTerminalProof: () => ({
        state: "observed", conflict: false, runId: run.runId, rootSessionId: broker.rootSessionId,
        asyncDir: run.asyncDir,
        processInstance: typeof proof.runnerProcessInstanceId === "string" && proof.runnerProcessInstanceId ? proof.runnerProcessInstanceId : String(run.pid),
        proofId,
      }),
    });
    createSubagentDispatchTrace(run.runId, diagnosticSink)(outcome.state === "delivered" ? "proof-delivered" : "proof-pending", {
      runId: run.runId, proofId, repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId,
    });
    return outcome;
  };
  if (bindBrokerCallbacks) {
    if (broker.coordinatorRequest || broker.recordTerminalProof) {
      bindingResolver.dispose();
      throw new Error("broker coordinator callbacks are already installed");
    }
    broker.coordinatorRequest = coordinatorRequest;
    broker.recordTerminalProof = recordTerminalProof;
  }
  // Host 模式只关闭仓库资源；全局回调由 Host 在全部连接关闭后卸载。
  return Object.freeze({ lazy, requireClient, preferClient, registry, identity, coordinatorRequest, recordTerminalProof, async close() {
    closing = true;
    clearInterval(pumpHandle);
    await lazy.dispose();
    bindingResolver.dispose();
    if (bindBrokerCallbacks) {
      if (broker.recordTerminalProof === recordTerminalProof) broker.recordTerminalProof = undefined;
      if (broker.coordinatorRequest === coordinatorRequest) broker.coordinatorRequest = undefined;
    }
    createSubagentDispatchTrace(broker.rootSessionId, diagnosticSink)("repository-closed", { repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId });
  } });
}

/** D5 降级视图：daemon 缺位时用本地 ledger+queue 只读组装 plan facts 消费的
 * coordinator 投影（同一 durable 数据源；只读方法，绝不拉起 daemon）。 */
function localCoordinatorView(context: { identity: { repositoryId: string; storageRepositoryId: string }; workspaceService: any }, rootSessionId: string) {
  const queue = createIntegrationQueue({ stateRoot: process.env.PI_CODING_WORKSPACE_DIR, repositoryId: context.identity.repositoryId, storageRepositoryId: context.identity.storageRepositoryId });
  return Object.freeze({
    async listOwned(input: { runId?: string } = {}) {
      return context.workspaceService.listOwned({ ownerScope: { kind: "standalone-subagent", rootSessionId }, ...(input?.runId === undefined ? {} : { runId: input.runId }) });
    },
    async inspectIntegrationState(binding: any) {
      const completion = context.workspaceService.inspectIntegrationCompletion(binding);
      const item = queue.findByBinding(binding);
      const receipt = completion.integrationReceipt;
      return Object.freeze({
        queueState: item?.state ?? "absent",
        workspaceState: completion.workspaceState,
        integrationReceipt: Boolean(receipt && item?.workspaceDispositionReceiptId === receipt.receiptId),
        proofState: completion.proofState,
        terminalProof: completion.terminalProof,
        revision: item?.revision ?? 0,
      });
    },
    async recoveryStatus() {
      return [
        ...queue.listRecoveryIntents().filter((intent: any) => intent.ownerScope?.rootSessionId === rootSessionId),
        ...queue.listResumeIntents(rootSessionId),
      ];
    },
  });
}

export function createRootBrokerUpstream({ rpc }: { rpc: any }) {
  return Object.freeze({
    ping: (...args: any[]) => rpc.ping(...args),
    stop: (...args: any[]) => rpc.stop(...args),
    dispose: (...args: any[]) => rpc.dispose(...args),
  });
}

// 执行服务血缘链解析纯函数（计划 T2）：输入为闭包收集的 recovery intents 数组
// （未预过滤，过滤在本函数内确定性完成）、workspace ledger readOwned(ref.workspaceId)
// 的 record 与入参 ref，输出 PlanLineageResolution 或 null。superseded 判定只依据
// 持久 resume intent 链 + workspace ledger 复核，绝不读 blocker 文案或内存缓存；
// 任何身份不一致、链证据不可信或复核失败一律 fail-closed（截断或返回 null）。
// 行为规格（全部 fail-closed）：
// 1. 过滤：只认 version === "integration-resume-intent.v1"、ownerScope.rootSessionId
//    与 ref 一致、workspaceId === ref.workspaceId 的 intent；同 sourceRunId 取
//    attempt 最大者。
// 2. 起链：自 ref.runId 起，有效跳 = state ∈ {activated, completed}，或严格
//    解码且 activationConfirmed=true 的 failed 历史边，且
//    resumedRun.runId 为 string；环、深度 >16、workspaceId/leaseId 与首跳不一致
//    → 链在此截断（无跳时无首跳约束）。
// 3. 复核：链尾 runId 必须与 ledger record.run.runId 一致，record owner 身份与
//    ref 一致，且有跳时 record workspace/lease 匹配首跳；不满足返回 null。
// 4. 无任何有效跳且复核通过 → { run: ref, chain: [ref.runId], superseded: false }。
export function resolvePlanExecutionLineage(intents: unknown, record: any, ref: PlanRunRef): PlanLineageResolution | null {
  const intentsBySource = new Map<string, any>();
  for (const entry of Array.isArray(intents) ? intents : []) {
    if (entry?.version !== "integration-resume-intent.v1" || typeof entry.sourceRunId !== "string") continue;
    if (entry.ownerScope?.rootSessionId !== ref.rootSessionId) continue;
    if (entry.workspaceId !== ref.workspaceId) continue;
    const prior = intentsBySource.get(entry.sourceRunId);
    if (!prior || (entry.attempt ?? 0) >= (prior.attempt ?? 0)) intentsBySource.set(entry.sourceRunId, entry);
  }
  const chain = [ref.runId];
  const seen = new Set(chain);
  let current = ref.runId;
  // 首跳（首个有效跳）的 workspace/lease 绑定；后续跳与 ledger 复核都以此为锚。
  let lineageBinding: { workspaceId: unknown; leaseId: unknown } | undefined;
  for (let hop = 0; hop < 16; hop++) {
    const intent = intentsBySource.get(current);
    if (!intent) break;
    if (intent.state !== "activated" && intent.state !== "completed") {
      if (intent.state !== "failed") break;
      // resumedRun 在 starting 阶段就已写入，不能单独作为成功激活证据。
      try {
        if (parseIntegrationResumeIntentV1(intent, { rootSessionId: ref.rootSessionId }).activationConfirmed !== true) break;
      } catch { break; }
    }
    const next = typeof intent.resumedRun?.runId === "string" ? intent.resumedRun.runId : undefined;
    if (!next || seen.has(next)) break;
    if (lineageBinding && (intent.workspaceId !== lineageBinding.workspaceId || intent.leaseId !== lineageBinding.leaseId)) break;
    chain.push(next);
    seen.add(next);
    current = next;
    lineageBinding ??= { workspaceId: intent.workspaceId, leaseId: intent.leaseId };
  }
  if (!record || typeof record !== "object") return null;
  if (record.workspaceId !== ref.workspaceId) return null;
  if (record.run?.runId !== current) return null;
  if (record.owner?.kind !== "standalone-subagent" || record.owner.rootSessionId !== ref.rootSessionId) return null;
  if (lineageBinding && (record.workspaceId !== lineageBinding.workspaceId || record.leaseId !== lineageBinding.leaseId)) return null;
  return { run: { ...ref, runId: current }, chain: [...chain], superseded: current !== ref.runId };
}

// 回执事件泵判定纯函数（计划 T4）：输入为 coordinator queue.receipt-events 返回的
// pending 回执事件数组，输出处置分组——childRunId === null 归入 toDebt（回写
// debt + reason "child-run-unavailable"，终态不再重试）；childRunId 为有效 string
// 归入 toNotify（broker.notifyExecutionFacts 成功后回写 delivered，其 eventId 即
// deliveredIds 成员；回写 RPC 失败保持 pending 由下一轮重放，重复 notify 幂等无害，
// at-least-once）。身份字段不完整的条目无法安全回写，跳过（durable 存储的权威
// 读侧不产生此类条目）。
export function resolveReceiptEventPumpPlan(events: unknown): {
  toNotify: Array<{ eventId: string; childRunId: string; ownerScope: { kind: "standalone-subagent"; rootSessionId: string } }>;
  toDebt: Array<{ eventId: string; reason: "child-run-unavailable"; ownerScope: { kind: "standalone-subagent"; rootSessionId: string } }>;
  deliveredIds: string[];
} {
  const toNotify: Array<{ eventId: string; childRunId: string; ownerScope: { kind: "standalone-subagent"; rootSessionId: string } }> = [];
  const toDebt: Array<{ eventId: string; reason: "child-run-unavailable"; ownerScope: { kind: "standalone-subagent"; rootSessionId: string } }> = [];
  for (const event of Array.isArray(events) ? events : []) {
    const entry = event as { eventId?: unknown; childRunId?: unknown; ownerScope?: { kind?: unknown; rootSessionId?: unknown } } | null;
    if (typeof entry?.eventId !== "string" || !entry.eventId) continue;
    if (entry.ownerScope?.kind !== "standalone-subagent" || typeof entry.ownerScope?.rootSessionId !== "string" || !entry.ownerScope.rootSessionId) continue;
    const ownerScope = { kind: "standalone-subagent" as const, rootSessionId: entry.ownerScope.rootSessionId };
    if (entry.childRunId === null) {
      toDebt.push({ eventId: entry.eventId, reason: "child-run-unavailable", ownerScope });
      continue;
    }
    if (typeof entry.childRunId !== "string" || !entry.childRunId) continue;
    toNotify.push({ eventId: entry.eventId, childRunId: entry.childRunId, ownerScope });
  }
  return { toNotify, toDebt, deliveredIds: toNotify.map((entry) => entry.eventId) };
}

export function projectManagedWorkspaceTerminalProof(
  run: { runId?: string } | null | undefined,
  snapshot: any,
) {
  if (!run?.runId || snapshot === undefined || snapshot === null) {
    return { state: "pending" };
  }
  if (snapshot.schemaVersion === "root-broker.execution-proof.v2" && snapshot.binding?.runId === run.runId) {
    if (snapshot.terminal === null) return { state: "pending" };
    const officialProof = snapshot.terminal?.proof;
    if (snapshot.terminal && typeof snapshot.terminal === "object"
        && /^[a-f0-9]{64}$/.test(snapshot.terminal.proofId)
        && typeof snapshot.terminalConflict === "boolean"
        && typeof snapshot.binding.rootSessionId === "string" && snapshot.binding.rootSessionId
        && typeof snapshot.binding.asyncDir === "string" && snapshot.binding.asyncDir) {
      // v2 ledger 要求七字段 proof 身份；processInstance 与
      // broker.recordTerminalProof 的构造一致（runnerProcessInstanceId，退回 pid）。
      const processInstance = typeof officialProof?.runnerProcessInstanceId === "string" && officialProof.runnerProcessInstanceId
        ? officialProof.runnerProcessInstanceId
        : String(snapshot.binding.pid);
      return {
        state: "observed",
        conflict: snapshot.terminalConflict,
        runId: snapshot.binding.runId,
        rootSessionId: snapshot.binding.rootSessionId,
        asyncDir: snapshot.binding.asyncDir,
        processInstance,
        proofId: snapshot.terminal.proofId,
      };
    }
  }
  const error = new Error("observed facade terminal proof is invalid") as Error & { code: string };
  error.code = "MANAGED_WORKSPACE_TERMINAL_PROOF_ADAPTER";
  throw error;
}

export default function subagentRuntime(pi: ExtensionAPI): void {
  installSubagentRuntime(pi);
}

/** 生产装配入口；受控测试仅替换 upstream/provider 边界。 */
export function installSubagentRuntime(pi: ExtensionAPI, dependencies: { bootstrap?: typeof upstreamSubagentRuntime; rpc?: any; discoverAgents?: (...args: any[]) => any; connectCoordinator?: typeof connectRuntimeCoordinator } = {}): void {
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1") return;
  const { renderSubagentCall, renderSubagentResult, renderSupervisorRequest, renderControlNotice, renderSupervisorCall, renderSupervisorResult, renderSupervisorReplyEntry, renderCompletionNotification } = createSubagentToolRenderers();
  // Host binding：共享 AGENTS 注入项从可信 PI_CODING_AGENT_DIR 解析（与 repository
  // agent admission 同一准入 env，缺失即失败，不做回退推断）。package 实现不得
  // import root src / pi/extensions，只传 { id, path } 由 required-child 注册消费。
  const piAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (!piAgentDir) throw new Error("PI_CODING_AGENT_DIR is required to resolve the shared agents binding");
  const agentsSharedChildExtension = Object.freeze({
    id: "agents-shared",
    path: path.join(piAgentDir, "extensions", "agents-shared.ts"),
  });
  const completionNotices = registerCompletionNotices(pi);
  let brokerStarted = false;
  let brokerReady = false;
  let builtinAdmission: ReturnType<typeof registerBuiltinAgentsViaEvents> | undefined;
  const registerBuiltinAgents = (api: any) => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required for repository agent admission");
    builtinAdmission = registerBuiltinAgentsViaEvents({ pi: api, agentDir });
    if (process.env.T11B1_DEBUG === "1") {
      const debugView = builtinAdmission.discoverAgents(process.cwd(), "both");
      console.error(`[bootstrap-debug] agentDir=${agentDir} registered=${debugView.agents.map((a: any) => a.name).join(",") || "(none)"}`);
    }
  };
  let previousBrokerMarker: string | undefined;
  const rpc = dependencies.rpc ?? createRenewableTypedSubagentRpcClient(() => createTypedSubagentRpcClient(pi.events));
  let diagnosticSink: (((entry: unknown) => void) & { dispose?: () => void }) | undefined;
  try {
    diagnosticSink = createSubagentDispatchTraceFileSink();
  } catch {
    // 无效的显式诊断文件不能影响生产派发。
  }
  let broker: RootBrokerServer | undefined;
  type RepositoryContext = NonNullable<Awaited<ReturnType<typeof connectRuntimeCoordinator>>> & { workspaceService: ReturnType<typeof createManagedWorkspaceService> };
  const repositories = new Map<string, RepositoryContext>();
  const connectionFlights = new Map<string, Promise<RepositoryContext>>();
  let workspaceService: any;
  let registeredWorkspaceService: any;
  let hostCwd: string;
  let singleRepositoryHost = true;
  let hostClosing = false;
  let repositoriesClosing = false;
  const repositoryError = () => Object.assign(new Error("Host repository binding is unavailable or differs from the selected repository"), { code: "HOST_REPOSITORY_BINDING_BLOCKED" });
  const selectRepository = async (originRoot: string): Promise<RepositoryContext> => {
    if (!broker || repositoriesClosing) throw repositoryError();
    const currentBroker = broker;
    const identity = singleRepositoryHost
      ? await resolveRepositoryIdentity(originRoot)
      : await admitHostRepositoryOrigin(hostCwd, originRoot);
    if (singleRepositoryHost) {
      const hostIdentity = await resolveRepositoryIdentity(hostCwd);
      if (identity.repositoryId !== hostIdentity.repositoryId || identity.storageRepositoryId !== hostIdentity.storageRepositoryId) throw repositoryError();
    }
    if (repositoriesClosing || broker !== currentBroker) throw repositoryError();
    const existing = repositories.get(identity.repositoryId);
    if (existing) {
      if (existing.identity.storageRepositoryId !== identity.storageRepositoryId || existing.identity.originRoot !== identity.originRoot) throw repositoryError();
      return existing;
    }
    const pending = connectionFlights.get(identity.repositoryId);
    if (pending) return pending;
    const flight = (async () => {
      const connection = await (dependencies.connectCoordinator ?? connectRuntimeCoordinator)({ pi, cwd: originRoot, broker: currentBroker,
        stateRoot: process.env.PI_CODING_WORKSPACE_DIR, rpc, diagnosticSink, bindBrokerCallbacks: false });
      if (!connection) throw repositoryError();
      let context: RepositoryContext;
      try {
        if (connection.identity.repositoryId !== identity.repositoryId || connection.identity.storageRepositoryId !== identity.storageRepositoryId
            || connection.identity.originRoot !== identity.originRoot) throw repositoryError();
        context = Object.freeze({ ...connection, workspaceService: createManagedWorkspaceService({
          stateRoot: process.env.PI_CODING_WORKSPACE_DIR, storageRepositoryId: connection.identity.storageRepositoryId,
          diagnosticSink, terminalProofProvider: ({ run }: any) => projectManagedWorkspaceTerminalProof(run, run?.runId ? currentBroker.inspectExecutionProof(run.runId) : null),
        }) });
      } catch (error) {
        try { await connection.close(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "repository context and cleanup failed", { cause: error });
        }
        throw error;
      }
      repositories.set(identity.repositoryId, context);
      createSubagentDispatchTrace(currentBroker.rootSessionId, diagnosticSink)("repository-selected", {
        requestOrigin: originRoot, repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId,
      });
      return context;
    })();
    connectionFlights.set(identity.repositoryId, flight);
    try { return await flight; } finally { connectionFlights.delete(identity.repositoryId); }
  };
  // run-only 枚举：优先消费 service 的严格 owner 合同；仅当枚举被 schema 级
  // invalid record 阻断时，用 T1 ledger 逐记录隔离重试——可证明 foreign 的
  // v1 legacy record 被跳过并转发结构化诊断，same-owner/unknown invalid 与
  // v2-invalid 在重试中仍 fail-closed。重试得到的每个候选 receipt 都经
  // readOwned 直读复核身份（workspaceId/leaseId/runId），不外泄枚举原始 record，
  // 也不把任何查询失败解释为「没有 workspace」。
  const enumerateOwnedReceipts = (ownerScope: { kind: "standalone-subagent"; rootSessionId: string }, runId?: string) => {
    try {
      return workspaceService.listOwned({ ownerScope, ...(runId === undefined ? {} : { runId }) });
    } catch (error) {
      if ((error as any)?.code !== "MANAGED_WORKSPACE_SCHEMA") throw error;
      const matched = createManagedWorkspaceLedger({ stateRoot: process.env.PI_CODING_WORKSPACE_DIR })
        .listScoped({ owner: ownerScope, onInvalid: (diagnostic: unknown) => forwardLedgerInvalidRecord(diagnosticSink, diagnostic) })
        .filter((record: any) => runId === undefined || record.run?.runId === runId);
      return matched.map((record: any) => {
        const entry = workspaceService.readOwned({ workspaceId: record.workspaceId, ownerScope });
        if (entry.workspaceId !== record.workspaceId || entry.leaseId !== record.leaseId
            || (runId !== undefined && entry.run?.runId !== runId)) {
          throw Object.assign(new Error("owned workspace receipt identity changed during enumeration"), { code: "MANAGED_WORKSPACE_CAS" });
        }
        return entry;
      });
    }
  };
  // 唯一同 owner 的本地持久回执是已有 workspace/run 的唯一选路来源。
  const ownedReceipts = (runId?: string) => {
    if (!broker || !workspaceService || repositoriesClosing) throw repositoryError();
    if (runId !== undefined && (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(runId) || runId.includes(".."))) {
      const error = new Error("workspace run identity is invalid") as Error & { code?: string };
      error.code = "MANAGED_WORKSPACE_OWNER_SCOPE";
      throw error;
    }
    return enumerateOwnedReceipts({ kind: "standalone-subagent", rootSessionId: broker.rootSessionId }, runId);
  };
  const selectReceipt = async (runId?: string, workspaceId?: string) => {
    if (!broker || !workspaceService || repositoriesClosing) throw repositoryError();
    let record: any;
    if (workspaceId !== undefined) {
      // 已知 workspaceId：直读目标 owner receipt（T2 readOwned），不再经全局
      // listOwned 枚举反推目标；目标 record 损坏、owner 不匹配或 ID 不存在由
      // readOwned 以原始错误语义 fail-closed，不把空结果解释为「无 workspace」。
      record = workspaceService.readOwned({ workspaceId, ownerScope: { kind: "standalone-subagent", rootSessionId: broker.rootSessionId } });
      if (runId !== undefined && record.run?.runId !== runId) throw repositoryError();
    } else {
      // run-only：只接受唯一、身份完整的 valid receipt。
      const entries = ownedReceipts(runId);
      if (entries.length !== 1) throw repositoryError();
      record = entries[0];
    }
    const context = await selectRepository(record.originRoot);
    // 用选定的 storage identity 再加载，拒绝回执被放进错误分区的现场。
    const lease = createManagedWorkspaceLedger({ stateRoot: process.env.PI_CODING_WORKSPACE_DIR, storageRepositoryId: context.identity.storageRepositoryId })
      .load(record.workspaceId, { originRoot: record.originRoot });
    if (lease.leaseId !== record.leaseId) throw repositoryError();
    return { record, context };
  };
  const makeWorkspaceService = (currentBroker: RootBrokerServer, fixedContext?: RepositoryContext) => {
    const resolveTerminalProof = (run: any) => projectManagedWorkspaceTerminalProof(run, run?.runId ? currentBroker.inspectExecutionProof(run.runId) : null);
    // 单 Git Host 保留旧 service 的全部 owner 入口；超级根不扩展旧 Goal owner 语义。
    if (fixedContext) return createCoordinatorDispositionFacade({ localService: fixedContext.workspaceService,
      resolveCoordinatorClient: async () => fixedContext.requireClient(), resolveTerminalProof });
    const localService = createManagedWorkspaceService({ stateRoot: process.env.PI_CODING_WORKSPACE_DIR,
      diagnosticSink, terminalProofProvider: ({ run }) => resolveTerminalProof(run) });
    const allocate = (operation: "ensureAllocated" | "reserve") => async (request: any) => {
      if (hostClosing || broker !== currentBroker || request?.owner?.kind !== "standalone-subagent" || request.owner.rootSessionId !== currentBroker.rootSessionId) throw repositoryError();
      const context = await selectRepository(request.originRoot);
      if (hostClosing) throw repositoryError();
      return context.workspaceService[operation](request);
    };
    return createCoordinatorDispositionFacade({
      localService: { ...localService, ensureAllocated: allocate("ensureAllocated"), reserve: allocate("reserve"),
        async bindRun(input: any) {
          const { context } = await selectReceipt(undefined, input.workspaceId);
          return context.workspaceService.bindRun(input);
        },
      },
      async resolveCoordinatorClient(entry: any) {
        if (broker !== currentBroker || entry.owner?.kind !== "standalone-subagent" || entry.owner.rootSessionId !== currentBroker.rootSessionId) throw repositoryError();
        return (await selectReceipt(entry.run?.runId, entry.workspaceId)).context.requireClient();
      },
      resolveTerminalProof,
    });
  };
  let workspaceRootSessionId: string | undefined;
  let workspaceLifecycleSessionId: string | undefined;
  let childToolCeilingRegistration: { dispose(): void } | undefined;
  // managed resume 的结构化诊断：只经既有 diagnosticSink 通道，不新增日志面；
  // sink 自身故障不影响选路。
  const managedResumeDiagnostic = (phase: string, payload: Record<string, unknown>) => {
    try { diagnosticSink?.({ version: 1, phase, ...payload }); }
    catch (diagnosticError) { console.error("[subagent-runtime] managed resume diagnostic sink failed", diagnosticError); }
  };
  // managed resume 的 lineage 归一化（缺陷修复规格 A）：resume 请求携带旧祖先 run id
  // 时，workspace ledger 只按当前 owner run 记账，直接以请求 id 查 owned receipts 必然
  // 为空并静默放行，复活 child 会因 broker binding 5s 超时失败。此处沿 resume intent
  // 链（integration-queue 持久记录的 sourceRunId→resumedRun）把旧祖先 id 解析为同一
  // workspace lineage 的当前 owner run：从本 root session 拥有的全部 workspace record
  // 出发连接 coordinator 收集 intents，逐跳校验 workspace/lease 与首跳一致；环、跨
  // workspace、歧义或深度超限一律视为不可解析，交由 fail-closed 分支处置。
  const resolveManagedResumeLineageOwner = async (sourceRunId: string): Promise<{
    resolvedRunId?: string; record?: any; chain: string[]; sourceAsyncDir?: string; lineageWorkspaceId?: string; ownedByRoot: any[];
  }> => {
    if (!broker || !workspaceService) throw repositoryError();
    const currentBroker = broker;
    const intentsBySource = new Map<string, any>();
    const ownedByRoot: any[] = [];
    try { ownedByRoot.push(...ownedReceipts()); } catch (error) {
      // 枚举失败不猜 lineage：按不可解析处理（fail-closed 分支仍会复核 descriptor）。
      managedResumeDiagnostic("managed-resume-lineage-enumeration-failed", { sourceRunId, error, cause: (error as any)?.cause });
    }
    const visitedRepositories = new Set<string>();
    for (const ownedReceipt of ownedByRoot) {
      let context: RepositoryContext;
      try { ({ context } = await selectReceipt(ownedReceipt.run?.runId, ownedReceipt.workspaceId)); }
      catch (error) {
        managedResumeDiagnostic("managed-resume-lineage-repository-unavailable", { sourceRunId, workspaceId: ownedReceipt?.workspaceId, error, cause: (error as any)?.cause });
        continue;
      }
      if (visitedRepositories.has(context.identity.repositoryId)) continue;
      visitedRepositories.add(context.identity.repositoryId);
      let intents: unknown;
      try { intents = await (await context.requireClient()).recoveryStatus(); } catch (error) {
        managedResumeDiagnostic("managed-resume-lineage-intents-unavailable", { sourceRunId, repositoryId: context.identity.repositoryId, error, cause: (error as any)?.cause });
        continue;
      }
      if (!Array.isArray(intents)) continue;
      for (const entry of intents) {
        if (entry?.version !== "integration-resume-intent.v1" || typeof entry.sourceRunId !== "string") continue;
        if (entry.ownerScope?.rootSessionId !== currentBroker.rootSessionId) continue;
        const prior = intentsBySource.get(entry.sourceRunId);
        if (!prior || (entry.attempt ?? 0) >= (prior.attempt ?? 0)) intentsBySource.set(entry.sourceRunId, entry);
      }
    }
    const chain = [sourceRunId];
    const seen = new Set(chain);
    const first = intentsBySource.get(sourceRunId);
    const lineageBinding = first ? { workspaceId: first.workspaceId, leaseId: first.leaseId } : undefined;
    const sourceAsyncDir = typeof first?.sourceAsyncDir === "string" && path.isAbsolute(first.sourceAsyncDir) ? first.sourceAsyncDir : undefined;
    let current = sourceRunId;
    for (let hop = 0; hop < 16; hop++) {
      const intent = intentsBySource.get(current);
      if (!intent) break;
      const next = typeof intent.resumedRun?.runId === "string" ? intent.resumedRun.runId : undefined;
      if (!next || seen.has(next)) break;
      // 续跑链不允许跨 workspace/lease：与首跳不一致即视为链证据不可信。
      if (lineageBinding && (intent.workspaceId !== lineageBinding.workspaceId || intent.leaseId !== lineageBinding.leaseId)) break;
      chain.push(next);
      seen.add(next);
      current = next;
      let ownedAtNext: any[];
      try { ownedAtNext = ownedReceipts(next); } catch { break; }
      if (ownedAtNext.length === 1) {
        const record = ownedAtNext[0];
        if (lineageBinding && record.workspaceId === lineageBinding.workspaceId && record.leaseId === lineageBinding.leaseId
            && record.owner?.kind === "standalone-subagent" && record.owner.rootSessionId === currentBroker.rootSessionId) {
          return { resolvedRunId: current, record, chain, sourceAsyncDir, lineageWorkspaceId: lineageBinding?.workspaceId, ownedByRoot };
        }
        // ledger 记录与 intent lineage 证据不一致：不猜，按不可解析处置。
        break;
      }
      if (ownedAtNext.length > 1) {
        managedResumeDiagnostic("managed-resume-lineage-ambiguous-owner", { sourceRunId, runId: next, matches: ownedAtNext.length });
        break;
      }
      // 该 run 已被再次续跑改绑（owned receipts 为空）：沿链继续。
    }
    return { chain, sourceAsyncDir, lineageWorkspaceId: lineageBinding?.workspaceId, ownedByRoot };
  };
  // 执行服务血缘解析（计划 T2，lineage(ref) 的收集与复核闭包）：intents 收集复用
  // 上方 resolveManagedResumeLineageOwner 的同一证据面（本 root session 拥有的
  // workspace records → repositories → recoveryStatus()）；ledger 复核用
  // readOwned(ref.workspaceId) 直读（不传 runId：superseded 旧 run 与 ledger 当前
  // run 必然不同，runId 限定查会误判）。核心链解析提为模块级纯函数
  // resolvePlanExecutionLineage，闭包只负责收集与复核后调用。装配不可用、枚举/
  // 读取不可达、复核失败一律返回 null（fail-closed），不降级、不使用 blocker 文案
  // 或内存缓存。诊断事件沿用 managedResumeDiagnostic 通道（plan-lineage-* 前缀）。
  const resolvePlanLineage = async (ref: PlanRunRef): Promise<PlanLineageResolution | null> => {
    if (!broker || !workspaceService) return null;
    const currentBroker = broker;
    if (ref.rootSessionId !== currentBroker.rootSessionId) return null;
    let ownedByRoot: any[];
    try { ownedByRoot = ownedReceipts(); } catch (error) {
      // 枚举失败不猜 lineage：intents 不可达，按规则返回 null。
      managedResumeDiagnostic("plan-lineage-enumeration-failed", { runId: ref.runId, workspaceId: ref.workspaceId, error, cause: (error as any)?.cause });
      return null;
    }
    const visitedRepositories = new Set<string>();
    const collected: any[] = [];
    let queriedRepositories = 0;
    for (const ownedReceipt of ownedByRoot) {
      let context: RepositoryContext;
      try { ({ context } = await selectReceipt(ownedReceipt.run?.runId, ownedReceipt.workspaceId)); }
      catch (error) {
        managedResumeDiagnostic("plan-lineage-repository-unavailable", { runId: ref.runId, workspaceId: ownedReceipt?.workspaceId, error, cause: (error as any)?.cause });
        continue;
      }
      if (visitedRepositories.has(context.identity.repositoryId)) continue;
      visitedRepositories.add(context.identity.repositoryId);
      let intents: unknown;
      try { intents = await (await context.requireClient()).recoveryStatus(); } catch (error) {
        managedResumeDiagnostic("plan-lineage-intents-unavailable", { runId: ref.runId, repositoryId: context.identity.repositoryId, error, cause: (error as any)?.cause });
        continue;
      }
      if (!Array.isArray(intents)) continue;
      queriedRepositories += 1;
      collected.push(...intents);
    }
    if (ownedByRoot.length > 0 && queriedRepositories === 0) {
      // 有 workspace 但一个 repository 的 intents 都不可达：证据不完整，按不可达
      // 返回 null，不把零证据当作「无任何跳」。
      managedResumeDiagnostic("plan-lineage-intents-unreachable", { runId: ref.runId, workspaceId: ref.workspaceId, repositories: visitedRepositories.size });
      return null;
    }
    let record: any;
    try {
      record = workspaceService.readOwned({ workspaceId: ref.workspaceId, ownerScope: { kind: "standalone-subagent", rootSessionId: currentBroker.rootSessionId } });
    } catch (error) {
      managedResumeDiagnostic("plan-lineage-record-read-failed", { runId: ref.runId, workspaceId: ref.workspaceId, error, cause: (error as any)?.cause });
      return null;
    }
    const resolution = resolvePlanExecutionLineage(collected, record, ref);
    if (!resolution) {
      managedResumeDiagnostic("plan-lineage-unresolved", { runId: ref.runId, workspaceId: ref.workspaceId });
      return null;
    }
    managedResumeDiagnostic("plan-lineage-resolved", { runId: ref.runId, workspaceId: ref.workspaceId, currentRunId: resolution.run.runId, chain: resolution.chain, superseded: resolution.superseded });
    return resolution;
  };
  // 归一化不可行时仍保留 managed 身份与未知身份的阻塞；全局 requiredExtensions
  // 不构成身份。generic owner receipt 也会持久化，不能仅以 owned 判为 coding。
  const blockOrPassUnresolvableLineageResume = (sourceRunId: string, lineage: Awaited<ReturnType<typeof resolveManagedResumeLineageOwner>>, ownerState: string, note?: string) => {
    const asyncDir = lineage.sourceAsyncDir ?? path.join(resolveAsyncRunsRootDir(), sourceRunId);
    const descriptorRead = readResumeTargetDescriptor(asyncDir);
    const replay = descriptorRead.status === "read" ? descriptorBrokerBindingReplay(descriptorRead.descriptor)
      : { replays: false, rootBinding: false, brokerRequiredExtension: false };
    const currentOwnerRunId = lineage.lineageWorkspaceId !== undefined
      ? lineage.ownedByRoot.find((record: any) => record.workspaceId === lineage.lineageWorkspaceId)?.run?.runId : undefined;
    const codingBinding = broker?.inspectExecutionProof(sourceRunId);
    const ownerKnown = ownerState === "owned" || ownerState === "unowned";
    if (replay.replays || codingBinding || lineage.lineageWorkspaceId !== undefined || !ownerKnown
        || (ownerState === "owned" && descriptorRead.status !== "read")) {
      managedResumeDiagnostic("managed-resume-binding-blocked", {
        sourceRunId, chain: lineage.chain, asyncDir, descriptorStatus: descriptorRead.status,
        descriptorRootBinding: replay.rootBinding, descriptorBrokerRequiredExtension: replay.brokerRequiredExtension,
        codingBinding: Boolean(codingBinding), ownerState,
        lineageWorkspaceId: lineage.lineageWorkspaceId, currentOwnerRunId, note,
      });
      throw Object.assign(new Error(
        `managed resume broker binding blocked: run ${sourceRunId} 的 workspace lineage 归一化未达成${note ? `（${note}）` : ""}；存在 Root Broker/workspace 绑定事实或无法确认非托管身份，不能绕过 owner、lease 与 proof 门禁。`
        + (currentOwnerRunId ? `next: 请改用当前 owner run id（${currentOwnerRunId}）重新发起 resume，或放弃续跑改为 fresh 派发新 run。` : "next: 请改用该 lineage 当前 owner run id 重新发起 resume（可经 subagent status 或 workspace 记录查询），或放弃续跑改为 fresh 派发新 run。")
        + (lineage.chain.length > 1 ? `lineage 链：${lineage.chain.join(" -> ")}。` : ""),
      ), { code: "RESUME_BINDING_BLOCKED" });
    }
    // 非托管目标（descriptor 无 broker 绑定装配）保持现状静默放行；仅补记诊断。
    managedResumeDiagnostic("managed-resume-unmanaged-passthrough", {
      sourceRunId, chain: lineage.chain, asyncDir, descriptorStatus: descriptorRead.status, note,
    });
    if (singleRepositoryHost) return undefined;
    // 跨 scope 复查只跳过明确 v1 legacy 并记诊断；v2/未知 schema 仍阻断。
    const crossScope = createManagedWorkspaceLedger({ stateRoot: process.env.PI_CODING_WORKSPACE_DIR })
      .list({ onInvalid: (diagnostic: unknown) => forwardLedgerInvalidRecord(diagnosticSink, diagnostic) })
      .filter((record: any) => record.run?.runId === sourceRunId);
    if (crossScope.length > 0) throw repositoryError();
    return undefined;
  };
  const supervisorControlPlane = createSupervisorControlPlane({
    persistenceRoot: (typeof process.env.PI_CODING_WORKSPACE_DIR === "string" && process.env.PI_CODING_WORKSPACE_DIR.length > 0
      ? process.env.PI_CODING_WORKSPACE_DIR
      : typeof process.env.PI_CODING_AGENT_DIR === "string" && process.env.PI_CODING_AGENT_DIR.length > 0
        ? process.env.PI_CODING_AGENT_DIR : undefined)
      ? path.join((process.env.PI_CODING_WORKSPACE_DIR || process.env.PI_CODING_AGENT_DIR) as string, "supervisor-control") : undefined,
    diagnosticSink,
    readOwnerReceipt: async (runId) => {
      // 不得把「broker 未就绲 / 读取失败」降级成 undefined：那会让控制面把
      // 「无法确认是否受管」误判为「确认非受管」，从而绕过 steer 围栏。
      // 三态判定见 supervisor-control-plane.ts 的 readOwnerState。
      if (!brokerReady || !broker) {
        if (process.env.T11B1_DEBUG === "1") console.error(`[t11b1-debug] owner-read unavailable brokerReady=${brokerReady} broker=${!!broker} runId=${runId}`);
        // code 故意不用 unknown_run：后者是「权威确认非受管」的专用信号，
        // broker 未就绲属于「无法确认」，必须被归为 unavailable 而 fail-closed。
        throw Object.assign(new Error("ROOT_BROKER_UNAVAILABLE"), { code: "authority_store_unavailable" });
      }
      try {
        const receipt = await broker.readOwnerReceipt(runId);
        if (process.env.T11B1_DEBUG === "1") console.error(`[t11b1-debug] owner-read receipt=${JSON.stringify(receipt)}`);
        return receipt;
      } catch (error) {
        if (process.env.T11B1_DEBUG === "1") console.error(`[t11b1-debug] owner-read error=${error instanceof Error ? error.message : String(error)} runId=${runId}`);
        throw error;
      }
    },
    // 双源判定：主链（rpc.status → runtimeFromStatus）判 running 零变化；缺源场景
    // （session-guard 空快照等）经 broker 生命周期登记二次判定，拒绝路径落诊断。
    // 实现与语义见 src/subagent-dispatch/supervisor-runtime-source.ts。
    readRuntime: createSupervisorRuntimeReader({
      brokerReady: () => brokerReady,
      broker: () => broker,
      status: (args: { id: string }) => rpc.status(args),
      diagnosticSink: () => diagnosticSink,
    }),
  });
  // 首派 workspace.run 依法只有 runId/asyncDir；profile 归官方 broker binding 所有。
  const managedCodingBinding = (record: any, owner: any, currentBroker: RootBrokerServer) => {
    const snapshot = currentBroker.inspectExecutionProof(record?.run?.runId);
    const binding = snapshot?.binding;
    if (!binding || snapshot.terminalConflict || binding.rootSessionId !== currentBroker.rootSessionId
        || binding.runId !== record?.run?.runId || binding.asyncDir !== record?.run?.asyncDir
        || binding.sessionId !== currentBroker.lifecycleSessionId
        || record?.owner?.kind !== "standalone-subagent" || record.owner.rootSessionId !== binding.rootSessionId
        || owner?.rootSessionId !== binding.rootSessionId || owner?.runId !== binding.runId
        || typeof binding.agentProfile !== "string" || !binding.agentProfile
        || (record.run.agentProfile !== undefined && record.run.agentProfile !== binding.agentProfile)
        || (record.run.sessionId !== undefined && record.run.sessionId !== binding.sessionId)
        || (record.run.pid !== undefined && record.run.pid !== binding.pid)) {
      throw Object.assign(new Error("managed resume source binding is unavailable: broker execution proof 与 workspace record 的 owner/run/session/profile 不一致或已撤销（不能按非托管续跑）；next: 用 subagent_run_status 核对当前 run 身份；owner 已换代时按 lineage 当前 owner run 重新 resume，已终态则 fresh 派发新 run。"), { code: "RESUME_BINDING_BLOCKED" });
    }
    return snapshot;
  };
  const consumptionFlights = new Set<Promise<void>>();
  const observeConsumption = (event: any) => {
    const currentBroker = broker;
    if (!brokerReady || !currentBroker || typeof event?.runId !== 'string') return;
    // broker自己的同步terminal listener先接受proof，再读取canonical会话。
    const flight = Promise.resolve().then(async () => {
      await reconcileSupervisorConsumption({ broker: currentBroker, plane: supervisorControlPlane, runId: event.runId, rootSessionId: currentBroker.rootSessionId, diagnosticSink });
    }).catch(error => {
      try { diagnosticSink?.({ phase: 'supervisor-consumption-failed', runId: event.runId, error, cause: error?.cause }); } catch {}
    });
    consumptionFlights.add(flight);
    void flight.finally(() => consumptionFlights.delete(flight));
  };
  const unsubscribeConsumption = pi.events.on("subagent:process-terminal", observeConsumption);
  const enabledSupervisorControlPlane = Object.freeze({
    ...supervisorControlPlane,
    async registerSupervisorRequest(native: any, root?: string) {
      if (!brokerReady || !broker || root !== broker.rootSessionId) throw new Error('ROOT_BROKER_UNAVAILABLE');
      return supervisorControlPlane.registerSupervisorRequest({ ...native, correlation: await captureSupervisorCorrelation(broker, native) }, root);
    },
    enabled: () => brokerReady && !!broker,
  });
  try {
  installHeadlessTypedSubagentRuntime(pi, {
    diagnosticSink,
    workingStateTrace: diagnosticSink,
    requiredSharedChildExtension: agentsSharedChildExtension,
    extraDisposables: [
      { dispose() { unsubscribeConsumption(); } },
      ...(diagnosticSink ? [diagnosticSink] : []),
      completionNotices,
      { dispose() { builtinAdmission?.dispose(); builtinAdmission = undefined; } },
    ],
    bootstrap: dependencies.bootstrap ?? upstreamSubagentRuntime,
    afterBootstrap: registerBuiltinAgents,
    async discoverAgents(...args: [string, string, string?]) {
      if (dependencies.discoverAgents) return dependencies.discoverAgents(...args);
      if (!builtinAdmission) {
        const error = new Error("AGENT_ADMISSION_UNAVAILABLE");
        (error as Error & { code?: string }).code = "AGENT_ADMISSION_UNAVAILABLE";
        throw error;
      }
      return builtinAdmission.discoverAgents(...args);
    },
    workspaceCompletionReminderFactory(api: ExtensionAPI) {
      return createWorkspaceCompletionReminder({
        events: api.events,
        sendMessage: (message, options) => api.sendMessage(message as any, options),
        onDiagnostic: (diagnostic) => {
          try { diagnosticSink?.({ version: 1, phase: "workspace-completion-reminder", diagnostic }); }
          catch (diagnosticError) { console.error("[subagent-runtime] workspace reminder diagnostic sink failed", diagnosticError); }
        },
        getContext() {
          // reminder 的 run-only lookup 走与 ownedReceipts 同一条逐记录隔离枚举：
          // 无关 foreign v1 只产生诊断，不阻断提醒；lookup 失败由 reminder 记
          // 结构化 lookup debt，不制造未处理 event-handler exception。
          return workspaceService && workspaceRootSessionId && workspaceLifecycleSessionId
            ? {
                service: { listOwned: (input: any) => enumerateOwnedReceipts(input.ownerScope, input.runId) },
                rootSessionId: workspaceRootSessionId,
                lifecycleSessionId: workspaceLifecycleSessionId,
              }
            : undefined;
        },
      });
    },
    // Completion delivery and acknowledgement rely on upstream native notify
    // (pi-subagents 0.71 registerSubagentNotify in extension/index.js:440); the
    // enhanced layer no longer forwards subagent:async-complete into custom
    // subagent-notify messages.
    resolveSessionId: resolveCurrentSessionId,
    async resolveCanonicalOrigin({ requestedCwd }) {
      if (!singleRepositoryHost) {
        const identity = await admitHostRepositoryOrigin(hostCwd, requestedCwd);
        return realpathSync(identity.originRoot);
      }
      return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: requestedCwd, encoding: "utf8" }).trim());
    },
    async beforeUpstreamSessionStart(_event, ctx) {
      if (brokerReady) return;
      if (brokerStarted) throw new Error("Root subagent broker startup is incomplete");
      rpc.renew();
      const rootSessionId = resolveRootSessionId(ctx.sessionManager);
      await supervisorControlPlane.ready(rootSessionId);
      const lifecycleSessionId = readSessionIdentity(ctx.sessionManager).sessionFile ?? resolveCurrentSessionId(ctx.sessionManager);
      // Host ceiling是显式opt-in；无配置时不得改变既有frontmatter工具行为。
      // 0.84.0 上游 ceiling 查找统一用 ctx.sessionManager.getSessionId()（subagent-executor.js
      // :1538/:1835 resolveCurrentSubagentCapabilityCeiling(input.ctx.sessionManager.getSessionId())），
      // 因此注册键必须是同一 session ID；lifecycleSessionId 的 sessionFile 优先语义只服务
      // broker/workspace/completion 生命周期，不能用作 ceiling 键。
      childToolCeilingRegistration = registerConfiguredChildToolCeiling({
        agentDir: process.env.PI_CODING_AGENT_DIR ?? "",
        sessionId: rootSessionId,
      });
      // Root broker is the sole completion owner (contract §2.5); no upstream
      // completion-owner identity is generated in this integration layer.
      readSessionIdentity(ctx.sessionManager);
      const upstream = createRootBrokerUpstream({ rpc });
      const stateRoot = process.env.PI_CODING_WORKSPACE_DIR;
      // This is an independent private authority root, never a workspace ledger.
      const authorityStore = typeof stateRoot === "string" && stateRoot.length > 0
        ? new AuthorityStore({ root: path.join(stateRoot, "root-broker-authority", rootSessionId) })
        : undefined;
      const startingBroker = new RootBrokerServer({ rootSessionId, lifecycleSessionId, upstream, events: pi.events, authorityStore });
      previousBrokerMarker = process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
      try {
        await startAndBindRootBroker(pi, startingBroker);
        broker = startingBroker;
        brokerStarted = true;
        hostCwd = (ctx.sessionManager as { getCwd(): string }).getCwd();
        singleRepositoryHost = shouldStartRepositoryCoordinator(hostCwd);
        hostClosing = false;
        repositoriesClosing = false;
        workspaceRootSessionId = rootSessionId;
        workspaceLifecycleSessionId = lifecycleSessionId;
        const fixedContext = singleRepositoryHost && stateRoot ? await selectRepository(hostCwd) : undefined;
        workspaceService = makeWorkspaceService(startingBroker, fixedContext);
        registeredWorkspaceService = workspaceService;
        // 每代 Host 只安装一次，所有仓库连接均不得覆盖或卸载这些回调。
        startingBroker.coordinatorRequest = async (runId, operation, input) => {
          if (broker !== startingBroker || repositoriesClosing) throw repositoryError();
          const context = fixedContext ?? (await selectReceipt(runId)).context;
          return context.coordinatorRequest(runId, operation, input);
        };
        startingBroker.recordTerminalProof = async (run, proof) => {
          if (broker !== startingBroker || repositoriesClosing) throw repositoryError();
          if (fixedContext) return fixedContext.recordTerminalProof(run, proof);
          if (ownedReceipts(run.runId).length === 0) {
            // 跨 scope 复查只跳过明确 v1 legacy 并记诊断（T1 无 owner 扫描合同）；
            // v2/未知 schema 仍抛错阻断，不把复查失败解释为「run 无 workspace」。
            const crossScope = createManagedWorkspaceLedger({ stateRoot })
              .list({ onInvalid: (diagnostic: unknown) => forwardLedgerInvalidRecord(diagnosticSink, diagnostic) })
              .filter((record: any) => record.run?.runId === run.runId);
            if (crossScope.length > 0) throw repositoryError();
            return { state: "not-applicable", reason: "run owns no managed workspace" };
          }
          const { context } = await selectReceipt(run.runId);
          return context.recordTerminalProof(run, proof);
        };
        bindManagedWorkspaceServiceSession(pi, rootSessionId, registeredWorkspaceService);
        process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = "1";
        brokerReady = true;
      } catch (error) {
        if (workspaceService && workspaceRootSessionId) {
          unbindManagedWorkspaceServiceSession(pi, workspaceRootSessionId, registeredWorkspaceService);
          registeredWorkspaceService = undefined;
          workspaceService = undefined;
          workspaceRootSessionId = undefined;
          workspaceLifecycleSessionId = undefined;
        }
        childToolCeilingRegistration?.dispose();
        childToolCeilingRegistration = undefined;
        if (brokerStarted) {
          await closeAndUnbindRootBroker(pi, startingBroker);
          for (const [key, context] of repositories) {
            await context.close();
            repositories.delete(key);
          }
          startingBroker.recordTerminalProof = undefined;
          startingBroker.coordinatorRequest = undefined;
          brokerStarted = false;
        }
        if (previousBrokerMarker === undefined) delete process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
        else process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = previousBrokerMarker;
        previousBrokerMarker = undefined;
        throw error;
      }
    },
    async beforeRuntimeDispose() {
      // Keep coordinator callbacks alive while Root Broker drains accepted child
      // integration requests and terminal proof delivery.
      hostClosing = true;
      // 连接失败由原请求报告；关闭仍须排空其他已建立的上下文。
      await Promise.allSettled([...connectionFlights.values()]);
      await Promise.all([...consumptionFlights]);
      if (brokerReady && broker) await supervisorControlPlane.closeRootRequests(broker.rootSessionId);
      const cleanupErrors: unknown[] = [];
      if (brokerStarted && broker) {
        try { await closeAndUnbindRootBroker(pi, broker); } catch (error) {
          cleanupErrors.push(error);
          try { diagnosticSink?.({ version: 1, phase: "root-broker-close-failed", error, cause: error?.cause }); } catch (diagnosticError) { console.error("[subagent-runtime] cleanup diagnostic sink failed", diagnosticError); }
        }
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "subagent runtime cleanup failed", { cause: cleanupErrors[0] });
      repositoriesClosing = true;
      await Promise.allSettled([...connectionFlights.values()]);
      for (const [key, context] of repositories) {
        try {
          await context.close();
          repositories.delete(key);
        } catch (error) {
          cleanupErrors.push(error);
          try { diagnosticSink?.({ version: 1, phase: "coordinator-close-failed", repositoryId: key, error, cause: error?.cause }); } catch (diagnosticError) { console.error("[subagent-runtime] cleanup diagnostic sink failed", diagnosticError); }
        }
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "subagent runtime cleanup failed", { cause: cleanupErrors[0] });
      if (broker) {
        broker.recordTerminalProof = undefined;
        broker.coordinatorRequest = undefined;
      }
      if (workspaceService && workspaceRootSessionId) {
        unbindManagedWorkspaceServiceSession(pi, workspaceRootSessionId, registeredWorkspaceService);
        registeredWorkspaceService = undefined;
        workspaceService = undefined;
        workspaceRootSessionId = undefined;
        workspaceLifecycleSessionId = undefined;
      }
      childToolCeilingRegistration?.dispose();
      childToolCeilingRegistration = undefined;
      if (brokerStarted && broker) {
        if (previousBrokerMarker === undefined) delete process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
        else process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = previousBrokerMarker;
        previousBrokerMarker = undefined;
        broker = undefined;
        brokerStarted = false;
        brokerReady = false;
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "subagent runtime cleanup failed", { cause: cleanupErrors[0] });
    },
    renderSubagentCall,
    renderSubagentResult,
    renderSupervisorCall,
    renderSupervisorResult,
    rpc,
    supervisorControlPlane: enabledSupervisorControlPlane,
    resolveRootSessionId: (sessionManager: any) => resolveRootSessionId(sessionManager),
    registerAuthorizedRun: async (authorization: any) => {
      if (!brokerReady || !broker) {
        const error = new Error("FACADE_PROOF_UNAVAILABLE");
        error.code = "FACADE_PROOF_UNAVAILABLE";
        throw error;
      }
      await registerRootBrokerAuthorizedRun(pi, authorization, broker.rootSessionId);
    },
    planExecution: {
      notify(runId) { broker?.notifyExecutionFacts(runId); },
      subscribe(listener) {
        if (!brokerReady || !broker) throw new Error("PLAN_EXECUTION_SESSION_UNAVAILABLE");
        return broker.subscribeExecutionFacts(listener);
      },
      async inspect(ref: PlanRunRef): Promise<PlanRunFacts> {
        const facts: PlanRunFacts = {
          run: { ...ref }, terminal: "unknown", terminalProofRef: null,
          integration: "blocked", integrationReceiptRef: null, workspaceState: "unknown",
          recovery: "unknown", wakeup: "unavailable", blocker: "PLAN_EXECUTION_FACTS_UNAVAILABLE",
        };
        const currentBroker = broker;
        if (!brokerReady || !currentBroker || !workspaceService
            || ref.rootSessionId !== currentBroker.rootSessionId) return facts;
        const ownerScope = { kind: "standalone-subagent", rootSessionId: ref.rootSessionId };
        try {
          const { record, context: coordinatorRuntime } = await selectReceipt(ref.runId, ref.workspaceId);
          // 利用类（D5）：plan facts inspect 是查询面，daemon 存在则用，缺位时降级
          // 本地 ledger+queue 适配器（同一 durable 数据），绝不拉起 daemon。
          const coordinator = await coordinatorRuntime.preferClient()
            ?? localCoordinatorView(coordinatorRuntime, ref.rootSessionId);
          const remoteEntries = await coordinator.listOwned({ runId: ref.runId });
          const remote = Array.isArray(remoteEntries) && remoteEntries.length === 1 ? remoteEntries[0] : undefined;
          if (!record || !remote || record.workspaceId !== ref.workspaceId || remote.workspaceId !== ref.workspaceId
              || record.leaseId !== remote.leaseId || record.originRoot !== remote.originRoot || record.run?.runId !== ref.runId || remote.run?.runId !== ref.runId
              || record.owner?.kind !== ownerScope.kind || record.owner.rootSessionId !== ref.rootSessionId
              || remote.owner?.kind !== ownerScope.kind || remote.owner.rootSessionId !== ref.rootSessionId) {
            facts.blocker = "PLAN_RUN_WORKSPACE_BINDING_UNKNOWN";
            return facts;
          }
          facts.workspaceState = remote.state;
          const binding = { workspaceId: ref.workspaceId, leaseId: remote.leaseId, runId: ref.runId, ownerScope };
          const integration = await coordinator.inspectIntegrationState(binding);
          const completion = coordinatorRuntime.workspaceService.inspectIntegrationCompletion(binding);
          const owner = await currentBroker.readOwnerReceipt(ref.runId);
          const liveSnapshot = currentBroker.inspectExecutionProof(ref.runId);
          // 新 Host 不重授旧 run 权限；仅核对 coordinator 持久化身份与官方 sidecar。
          const terminal = liveSnapshot
            ? managedCodingBinding(remote, owner, currentBroker).terminal
            : await currentBroker.inspectPersistedTerminalProof(remote, integration.terminalProof);
          const outcome = terminal?.outcome;
          if (terminal && outcome !== "succeeded" && outcome !== "failed") throw new Error("PLAN_OFFICIAL_PROOF_INVALID");
          facts.terminal = outcome === "succeeded" || outcome === "failed" ? outcome : "pending";
          facts.terminalProofRef = terminal?.proofId ?? null;
          facts.recovery = "none";
          facts.workspaceState = integration.workspaceState;
          const receipt = completion.integrationReceipt;
          createSubagentDispatchTrace(ref.runId, diagnosticSink)("integration-observed", {
            requestOrigin: record.originRoot, repositoryId: coordinatorRuntime.identity.repositoryId,
            storageRepositoryId: coordinatorRuntime.identity.storageRepositoryId, workspaceId: ref.workspaceId,
            leaseId: remote.leaseId, runId: ref.runId, queueState: integration.queueState,
            proofId: facts.terminalProofRef, receiptId: receipt?.receiptId,
          });
          const receiptMatches = integration.integrationReceipt === true && integration.queueState === "completed"
            && completion.workspaceState === integration.workspaceState && typeof receipt?.receiptId === "string";
          if (receiptMatches) {
            facts.integration = "completed";
            facts.integrationReceiptRef = receipt.receiptId;
          } else if (integration.workspaceState === "released") {
            // 当前只读面不能区分 no-payload 结算与人工 discard，不把释放冒充交付。
            facts.blocker = "no-payload settlement identity unavailable";
            return facts;
          } else if (integration.workspaceState === "active"
              && !["preserved", "cancelled", "blocked"].includes(integration.queueState)) {
            facts.integration = "pending";
          }
          if (facts.terminal !== "pending" && facts.integration === "completed" && facts.workspaceState === "released") {
            facts.blocker = null;
            return facts;
          }
          const intents = await coordinator.recoveryStatus();
          if (!Array.isArray(intents)) throw new Error("PLAN_RECOVERY_FACTS_UNAVAILABLE");
          const candidates = intents.filter(entry => entry?.sourceRunId === ref.runId || entry?.runId === ref.runId);
          if (candidates.length > 0) {
            facts.integration = "blocked";
            const candidate = candidates.length === 1 && candidates[0]?.version === "integration-resume-intent.v1"
              ? parseIntegrationResumeIntentV1(candidates[0], { rootSessionId: ref.rootSessionId }) : undefined;
            // daemon 化后 intent 的正常前置态是 debt/delivered（durable 落盘后由 Host 泵
            // 重放送达）；typed-resume 的门禁应以 intent 自身 pending 为主，delivery
            // 仅排除显式失败（delivered 后仍未激活同样可 typed-resume 唤醒）。
            if (!candidate || !["pending", "debt", "delivered"].includes(candidate.delivery.state) || candidate.state === "preserved"
                || ["preserved", "cancelled", "blocked"].includes(integration.queueState)
                || facts.workspaceState !== "active") {
              facts.recovery = "manual-integration";
              facts.blocker = "subagent-integration-handoff";
              return facts;
            }
            // 旧官方终态、当前 owner、合同及 pending intent 是恢复准入；不是新 PID 的证明。
            if (facts.terminalProofRef && candidate.sourceProofId === facts.terminalProofRef
                && candidate.workspaceId === ref.workspaceId && candidate.leaseId === remote.leaseId
                && candidate.sourceAsyncDir === remote.run.asyncDir && candidate.state === "pending"
                && candidate.resumedRun === null) {
              const status: any = await rpc.status({ id: ref.runId });
              const state = status?.details?.state ?? status?.asyncSnapshot?.runs?.find(entry => entry.id === ref.runId)?.state;
              if (status?.isError !== true && (state === "completed" || state === "failed")) {
                facts.recovery = "typed-resume";
                facts.blocker = "PLAN_TYPED_RESUME_REQUIRED";
                return facts;
              }
            }
            facts.recovery = "unknown";
            facts.blocker = "PLAN_RESUME_BINDING_UNKNOWN";
            return facts;
          }
          facts.wakeup = currentBroker.hasExecutionFactWakeup(ref.runId) ? "subscribed" : "unavailable";
          facts.blocker = facts.wakeup === "subscribed" && facts.integration !== "blocked"
            ? null : "PLAN_FACT_WAKEUP_UNAVAILABLE";
          if (facts.wakeup === "unavailable" && facts.terminal !== "pending") facts.recovery = "unknown";
          return facts;
        } catch (error) {
          // 保留已核实的 terminal/workspace 字段；读取失败不降级为可重派或已完成。
          try { diagnosticSink?.({ version: 1, phase: "plan-facts-inspect-failed", runId: ref.runId, workspaceId: ref.workspaceId, error: String((error as Error)?.message ?? error), code: (error as { code?: string })?.code }); } catch { /* 诊断失败不影响降级 */ }
          facts.recovery = "unknown";
          facts.wakeup = "unavailable";
          facts.blocker = "PLAN_EXECUTION_FACTS_UNAVAILABLE";
          return facts;
        }
      },
      // 执行服务血缘查询（计划 T2）：与 inspect 同界（仅本 root session 装配可用
      // 时实现），核心解析在 resolvePlanLineage 闭包 + 模块级纯函数
      // resolvePlanExecutionLineage 内完成。
      lineage(ref: PlanRunRef): Promise<PlanLineageResolution | null> {
        return resolvePlanLineage(ref);
      },
    },
    managedCodingResume: {
      events: pi.events,
      async prepare({ sourceRunId, ownerState, owner }: any) {
        if (!brokerReady || !broker || !workspaceService) {
          if (ownerState === "owned") throw Object.assign(new Error("managed resume coordinator identity is unavailable: broker 或 workspace service 未装配，而 owner 已确认受管（不能按非托管放行）；next: 先在 Host 侧确认 Root Broker 与 workspace service 就绪后重试一次，仍不可用按阻断上报，不要绕过 resume 直接把同一 workspace 当 fresh 派发。"), { code: "RESUME_BINDING_BLOCKED" });
          return undefined;
        }
        let localOwned: any[];
        try {
          localOwned = ownedReceipts(sourceRunId);
        } catch (error) {
          // 枚举被 same-owner/unknown invalid record 阻断时无法确认绑定：转换为
          // 既有 resume 阻塞语义（保留 cause），不降级为「没有 workspace」。
          throw Object.assign(new Error("managed resume owned receipts are unavailable: 本 root 的 workspace receipt 枚举被非法/无法确认归属的记录阻断，无法确认绑定；next: 按阻断上报并核对 ledger 记录（workspace 审计或 service.reconcile），修掉损坏记录后重试 resume；不要把该失败解释成「没有 workspace」。"), { code: "RESUME_BINDING_BLOCKED", cause: error });
        }
        // 绑定键归一化：默认按请求 id；请求 id 是旧祖先 id（ledger 已改绑到续跑后的新
        // run）时改写为 lineage 当前 owner run，后续 register+activate 全部按 owner run
        // 走既有合同（复活 child 的新 run 注册仍按当次 processBirth 写入，与首次
        // resume 语义一致）。
        let bindingRunId = sourceRunId;
        let bindingOwner = owner;
        let bindingOwnerState = ownerState;
        if (localOwned.length === 0) {
          // 合法 generic descriptor 不携带 root binding；Broker coding 事实与直接
          // workspace receipt 均缺位且 owner 查询已成功时，保留 upstream resume。
          // 不按 agent 名称/cwd 分类，也不把 owner 读取失败当作「无 managed 身份」。
          const descriptorRead = readResumeTargetDescriptor(path.join(resolveAsyncRunsRootDir(), sourceRunId));
          if (descriptorRead.status === "read" && !descriptorBrokerBindingReplay(descriptorRead.descriptor).replays
              && !broker.inspectExecutionProof(sourceRunId) && (ownerState === "owned" || ownerState === "unowned")) {
            return blockOrPassUnresolvableLineageResume(sourceRunId, { chain: [sourceRunId], ownedByRoot: [] }, ownerState);
          }
          const lineage = await resolveManagedResumeLineageOwner(sourceRunId);
          if (lineage.resolvedRunId) {
            try {
              // owner 身份按 owner run 的 authority receipt 复核；请求 id 的旧身份
              // 不再作为绑定键。读取失败（已 revoke/superseded 或存储不可用）时按
              // 归一化不可行处置，交由 fail-closed 分支。
              bindingOwner = await broker.readOwnerReceipt(lineage.resolvedRunId);
              bindingOwnerState = "owned";
              bindingRunId = lineage.resolvedRunId;
              managedResumeDiagnostic("managed-resume-lineage-normalized", {
                sourceRunId, resolvedRunId: bindingRunId, chain: lineage.chain, workspaceId: lineage.lineageWorkspaceId,
              });
            } catch (error) {
              managedResumeDiagnostic("managed-resume-lineage-owner-unavailable", {
                sourceRunId, resolvedRunId: lineage.resolvedRunId, chain: lineage.chain, error, cause: (error as any)?.cause,
              });
              return blockOrPassUnresolvableLineageResume(sourceRunId, lineage, ownerState, "归一化命中的 owner run 无当前 authority receipt");
            }
          } else {
            return blockOrPassUnresolvableLineageResume(sourceRunId, lineage, ownerState);
          }
        }
        const { record: selected, context: coordinatorRuntime } = await selectReceipt(bindingRunId);
        let owned: any;
        try {
          owned = await (await coordinatorRuntime.requireClient()).listOwned({ runId: bindingRunId });
        } catch (error) {
          // coordinator run-only 枚举被无关 invalid record 阻断时，退回本地唯一
          // receipt 继续复核（唯一性与身份已由 selectReceipt 的直读+分区复核确
          // 认）；目标 record 损坏/owner 不匹配在该路径已 fail-closed，此处不放宽
          // 任何身份校验，也不把远端失败解释为「没有 workspace」。
          try { diagnosticSink?.({ version: 1, phase: "managed-resume-owned-receipts-fallback", runId: bindingRunId, error, cause: (error as any)?.cause }); }
          catch (diagnosticError) { console.error("[subagent-runtime] managed resume diagnostic sink failed", diagnosticError); }
          owned = [selected];
        }
        if (!Array.isArray(owned)) throw Object.assign(new Error("managed resume workspace ownership is unavailable: coordinator listOwned 返回非法结构，无法确认 workspace 归属；next: 按阻断上报并核对 coordinator 记录与连接状态，不要重试同一 resume。"), { code: "RESUME_BINDING_BLOCKED" });
        if (owned.length === 0) return undefined;
        if (owned.length !== 1) throw Object.assign(new Error(`managed resume requires exactly one owned workspace: 该 run 对应 ${owned.length} 条 owned workspace（续跑要求恰好一条）；next: 先用 subagent_run_status 或 workspace list 核对唯一 workspace；多于一条属歧义，保持现场按阻断上报，不要挑一条强行 resume。`), { code: "RESUME_BINDING_BLOCKED" });
        if (bindingOwnerState !== "owned" || !bindingOwner || bindingOwner.runId !== bindingRunId || bindingOwner.rootSessionId !== broker.rootSessionId) {
          throw Object.assign(new Error("managed resume owner identity is unavailable: owner receipt 缺失或 ownerState 不是 owned（读不到 ≠ 非受管）；next: 稍后重试一次，仍不可用按阻断上报，不要以非托管身份续跑。"), { code: "RESUME_BINDING_BLOCKED" });
        }
        const record = owned[0];
        if (record.workspaceId !== selected.workspaceId || record.leaseId !== selected.leaseId || record.originRoot !== selected.originRoot
            || record?.owner?.kind !== "standalone-subagent" || record.owner.rootSessionId !== broker.rootSessionId
            || record?.run?.runId !== bindingRunId || !Number.isSafeInteger(bindingOwner.ownerGeneration) || bindingOwner.ownerGeneration <= 0) {
          throw Object.assign(new Error("managed resume owner binding is invalid: workspace record 的 lease/origin/owner/run/ownerGeneration 与本次请求不一致；next: 以 workspace 记录里的 owner run 与 lease 核对请求参数；身份确实换代时按 lineage 当前 owner run 重新 resume。"), { code: "RESUME_BINDING_BLOCKED" });
        }
        const expectedAgent = managedCodingBinding(record, bindingOwner, broker).binding.agentProfile;
        const intents = await (await coordinatorRuntime.requireClient()).recoveryStatus();
        const matches = Array.isArray(intents)
          ? intents.filter((entry: any) => entry?.version === "integration-resume-intent.v1" && entry.sourceRunId === bindingRunId)
          : [];
        // 0 条即单向结算门已关闭 intent（preserve/cancel 结算顺手关闭）：恢复出口是 fresh 派发，不是重开 intent。
        if (matches.length !== 1) throw Object.assign(new Error(`managed resume intent is unavailable or ambiguous: 该 run 有 ${matches.length} 条 pending resume intent（要求恰好一条）；next: 0 条说明该 workspace 的 resume intent 已被结算关闭（preserve/cancel 结算单向关 intent），即该 workspace 已完成处置，如需继续工作请 fresh 派发新 run；多条属歧义，保持现场按阻断上报，不要手工挑一条激活。`), { code: "RESUME_BINDING_BLOCKED" });
        const intent = parseIntegrationResumeIntentV1(matches[0], { rootSessionId: broker.rootSessionId });
        if (intent.workspaceId !== record.workspaceId || intent.leaseId !== record.leaseId || intent.state !== "pending" || intent.resumedRun !== null) {
          throw Object.assign(new Error("managed resume intent is not activatable: intent 已激活（resumedRun 已绑定）或与当前 workspace/lease/generation 不匹配；next: 不要重复 resume；用 subagent_run_status 查看该 run 当前状态，需要继续工作则按当前 owner run 重新 resume 或 fresh 派发。"), { code: "RESUME_BINDING_BLOCKED" });
        }
        return Object.freeze({ intent, expectedAgent, expectedSessionId: broker.lifecycleSessionId });
      },
      async register(binding: any) {
        if (!brokerReady || !broker) throw Object.assign(new Error("Root Broker is unavailable for managed resume: 新 run 无法登记授权，续跑链路不可达；next: 等 broker 就绪后重试一次，仍不可用按阻断上报，不要绕过 broker 直接拉起 child。"), { code: "RESUME_BINDING_BLOCKED" });
        const authorization = createRunAuthorization({ kind: "coding", binding, goal: null });
        await registerRootBrokerAuthorizedRun(pi, authorization, broker.rootSessionId);
      },
      async activate({ plan, resumedRun }: any) {
        if (!brokerReady || !broker) throw Object.assign(new Error("managed resume coordinator is unavailable: 无法激活 resume intent（workspace 仍停在 disposing/preserved）；next: 确认 coordinator daemon 在跑（workspace status 的 blocked 原因会显示集成协调不可用）后就绪重试一次；仍不可用按阻断上报并保留 workspace 现场。"), { code: "RESUME_BINDING_BLOCKED" });
        const intent = plan.intent;
        const { context: coordinatorRuntime } = await selectReceipt(intent.sourceRunId, intent.workspaceId);
        return (await coordinatorRuntime.requireClient()).activateResume({
          resumeIntentId: intent.resumeIntentId,
          workspaceId: intent.workspaceId,
          leaseId: intent.leaseId,
          sourceRunId: intent.sourceRunId,
          resumedRun,
          ownerScope: intent.ownerScope,
          generation: intent.generation,
          authorization: "root",
        });
      },
    },
    inspectExecutionProof: (runId: string) => {
      if (!brokerReady || !broker) return { state: "unknown" };
      try { return inspectRootBrokerExecutionProof(pi, runId, broker.rootSessionId) ?? { state: "unknown" }; } catch { return { state: "unknown" }; }
    },
    retainOnBeforeDisposeFailure: true,
  });
  } catch (error) {
    completionNotices.dispose();
    diagnosticSink?.dispose?.();
    throw error;
  }
  // Upstream registers the same custom type during bootstrap; the project renderer must win last-write ownership.
  pi.registerMessageRenderer("subagent-workspace-reminder", (message, { outputPad }, theme) => {
    void outputPad;
    return new Text(theme.fg("dim", formatCompactSubagentWorkspaceReminder(message)), 0, 0);
  });
  pi.registerMessageRenderer("subagent-notify", (message, { outputPad }, theme) => {
    void outputPad;
    return renderCompletionNotification(message, theme);
  });
  pi.registerMessageRenderer("subagent_supervisor_request", renderSupervisorRequest);
  pi.registerMessageRenderer("subagent_control_notice", renderControlNotice);
  // 上游 bootstrap 经 membrane 把 registerEntryRenderer("subagent_supervisor_reply")
  // 转发进本扩展的同一 entryRenderers Map（runner.getEntryRenderer 按扩展加载序
  // 取首个命中，同名 customType 在同扩展内后注册覆盖先注册）；此处后注册覆盖
  // 上游大框，仅改展示，不碰 entry 数据与会话内容。entry 本身不进 LLM 上下文。
  pi.registerEntryRenderer("subagent_supervisor_reply", renderSupervisorReplyEntry);
}
