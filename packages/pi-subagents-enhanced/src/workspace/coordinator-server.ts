import net from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { challengeRootBroker } from "../subagent-dispatch/root-broker-client.ts";
import { createCoordinatorProofOutbox } from "../subagent-dispatch/coordinator-proof-outbox.ts";
import { RECOVERY_RESUME_ACTIVATION_VERSION, createManualIntegrationHandoff, parseRecoveryResumeActivationV1 } from "../subagent-dispatch/recovery-resume-contract.ts";
import { parseCoordinatorRequest, parseCoordinatorRegistrationRequest, authorizeCoordinatorRequest } from "./coordinator-protocol.ts";
import type { TrustedBrokerRegistration } from "./coordinator-auth.ts";
import { canonicalWorkspaceStateRoot } from "./coordinator-registry.ts";
import { createManagedWorkspaceService } from "./service.ts";
import { createManagedWorkspaceLedger } from "./ledger.ts";
import { createIntegrationQueue, processAliveStatus } from "./integration-queue.ts";
import { auditManagedWorkspaces } from "./administration.ts";
import { toCoordinatorErrorInfo } from "./coordinator-errors.ts";
import { createWorkspaceDispositionSettlement } from "./disposition-settlement.ts";
import { readDurableObservedTerminalProof } from "./durable-terminal-proof.ts";

type CoordinatorFault = (event: { operation: string; phase: string; queueItemId?: string; workspaceId?: string }) => void;
type CoordinatorDiagnostic = (entry: unknown) => void;

const RESUMABLE_PROOF_QUEUE_STATES = ["queued", "admitted", "resolving-conflict", "prepared"];

export function createCoordinatorServer(options: { endpoint: string; repositoryId: string; storageRepositoryId?: string; stateRoot?: string; capability?: string; instanceId?: string; idleGraceMs?: number; handler?: (request: any) => unknown; challengeBroker?: typeof challengeRootBroker; recoveryEventSink?: (event: any) => Promise<any> | any; fault?: CoordinatorFault; diagnosticSink?: CoordinatorDiagnostic; admissionProbe?: () => void; onListening?: () => Promise<void> | void }) {
  const diagnose = (entry: unknown) => { try { options.diagnosticSink?.(entry); } catch (diagnosticError) { console.error("[coordinator-server] diagnostic sink failed", { entry, diagnosticError }); } };
  const instanceId = options.instanceId ?? randomUUID();
  const challengeBroker = options.challengeBroker ?? challengeRootBroker;
  const registrations = new Map<string, TrustedBrokerRegistration>();
  const registrationBindings = new Map<string, any>();
  const brokerCapabilities = new Map<string, string>();
  const socketCapabilities = new Map<net.Socket, Set<string>>();
  const clients = new Set<net.Socket>(); let active = 0; let retained = 0;
  let startupReady = false;
  // The durable queue, ledger records and proof outbox must share the ledger's
  // canonical partition; a symlinked alias would otherwise split the bucket.
  const declaredStateRoot = options.stateRoot ?? process.env.PI_CODING_WORKSPACE_DIR;
  const stateRoot = declaredStateRoot ? canonicalWorkspaceStateRoot(declaredStateRoot) : undefined;
  const storageRepositoryId = options.storageRepositoryId ?? options.repositoryId;
  const workspaceService = stateRoot
    ? createManagedWorkspaceService({ stateRoot, storageRepositoryId, fault: event => options.fault?.({ ...event }), admissionProbe: options.admissionProbe,
      // 证明权威统一（审计 #9 / INV-OWNER-UNIQ）：coordinator 侧与 Host 侧消费同一
      // durable 异步事实（run.asyncDir 下官方 process-terminal.json），同步解析为
      // 同形 7 字段证明；事实缺失/不一致时返回 undefined，保持原 fail-closed。
      // INV-EXIT：解析失败原因与 next 随诊断输出（durable-terminal-proof-unresolved），
      // 使「release 被拒」能归因到具体缺失事实。
      terminalProofProvider: ({ run, rootSessionId }) => readDurableObservedTerminalProof({ run, rootSessionId, onDiagnostic: diagnose }),
      integrationFallback: { blockedReasons: integrationFallbackBlockedReasons, execute: integrateTerminalWorkspace } })
    : undefined;
  const integrationQueue = workspaceService
    ? createIntegrationQueue({ stateRoot, repositoryId: options.repositoryId, storageRepositoryId })
    : undefined;
  const proofOutboxDirectory = stateRoot
    ? path.join(stateRoot, "repositories", storageRepositoryId, "terminal-proof-outbox")
    : undefined;
  const proofOutbox = proofOutboxDirectory ? createCoordinatorProofOutbox(proofOutboxDirectory) : undefined;
  const processBirthIdentity = createHash("sha256").update(execFileSync("/bin/ps", ["-ww", "-p", String(process.pid), "-o", "lstart=", "-o", "command="], { encoding: "buffer" })).digest("hex");
  const daemonIdentity = { instanceId, pid: process.pid, birthIdentity: processBirthIdentity };
  const dispositionSettlement = workspaceService && integrationQueue
    ? createWorkspaceDispositionSettlement({ workspaceService, integrationQueue, fault: options.fault }) : undefined;

  function assertChildBinding(item: any, binding: any) {
    if (!item || binding?.workspaceId !== item.workspaceId || binding?.leaseId !== item.leaseId
        || binding?.runId !== item.childRunId || binding?.ownerScope?.kind !== item.ownerScope?.kind
        || binding?.ownerScope?.rootSessionId !== item.ownerScope?.rootSessionId) throw new Error("trusted child binding does not match queue item");
  }

  function enqueueIntegration(input: any, binding: any) {
    if (!integrationQueue || !workspaceService) throw new Error("coordinator workspace service is unavailable");
    // enqueue 不再执行重 Git admission inspection：只写 queue item，权威 target head
    // 由 claim 的 admissionFactsForClaim 在 FIFO head 推进时填入（T3）。
    return integrationQueue.enqueueIntegration({
      ...input,
      repositoryId: options.repositoryId,
      ownerScope: structuredClone(binding.ownerScope),
      childRunId: binding.runId,
      strategy: "rebase-ff",
      observedTargetHead: null,
    });
  }

  function awaitIntegrationAdmission(queueItemId: string, binding: any) {
    if (!integrationQueue || !workspaceService) throw new Error("coordinator workspace service is unavailable");
    const item = integrationQueue.getItem(queueItemId);
    assertChildBinding(item, binding);
    if (item.state === "admitted" || item.state === "rebasing" || item.state === "resolving-conflict" || item.state === "prepared") {
      return { queueLeaseId: item.queueLeaseId, targetRef: item.targetRef, targetHead: item.admittedTargetHead, admissionGeneration: item.admissionGeneration };
    }
    if (item.state !== "queued") return null;
    const head = integrationQueue.listQueue().find((entry: any) => !["completed", "cancelled", "preserved"].includes(entry.state));
    if (head?.queueItemId !== queueItemId) return null;
    const admitted = integrationQueue.claimNext(daemonIdentity, current => {
      assertChildBinding(current, binding);
      const facts = workspaceService.admissionFactsForClaim(current, binding);
      return { admittedTargetHead: facts.targetHead };
    });
    if (!admitted || admitted.queueItemId !== queueItemId) return null;
    options.fault?.({ operation: "integration", phase: "after-admission", queueItemId, workspaceId: admitted.workspaceId });
    return { queueLeaseId: admitted.queueLeaseId, targetRef: admitted.targetRef, targetHead: admitted.admittedTargetHead, admissionGeneration: admitted.admissionGeneration };
  }

  function publishRebasedCandidate(input: any, binding: any) {
    if (!integrationQueue || !workspaceService) throw new Error("coordinator workspace service is unavailable");
    let item = integrationQueue.getItem(input.queueItemId);
    assertChildBinding(item, binding);
    if (item.state === "completed") throw new Error("queue lease was replayed after completion");
    if (item.queueLeaseId !== input.queueLeaseId) throw new Error("queue lease mismatch");
    item = integrationQueue.prepareCandidate({ ...input, admissionGeneration: item.admissionGeneration });
    options.fault?.({ operation: "integration", phase: "after-prepared", queueItemId: item.queueItemId, workspaceId: item.workspaceId });
    const state = workspaceService.integrationState(item, binding);
    const intent = workspaceService.prepareIntegrationIntent({ ...item, targetHead: item.admittedTargetHead, integrationIntentId: state.intent?.integrationIntentId }, binding);
    const integrationReceipt = workspaceService.completeIntegrationIntent({ ...item, integrationIntentId: intent.integrationIntentId }, binding);
    options.fault?.({ operation: "integration", phase: "before-queue-complete", queueItemId: item.queueItemId, workspaceId: item.workspaceId });
    const completed = integrationQueue.completePrepared({ ...item, integrationIntentId: intent.integrationIntentId, workspaceDispositionReceiptId: integrationReceipt.receiptId });
    // Completing a queue item unlocks terminal proofs that arrived while this
    // item (or an earlier FIFO head) was still integrating. Replay
    // asynchronously so a queued follower settles without a new proof RPC or a
    // daemon restart: the fire-and-forget call never blocks the queue commit,
    // undeliverable proofs stay pending for the next trigger, and receipts
    // make repeated triggers idempotent.
    void replayTerminalProofs().catch((error) => { diagnose({ version: 1, phase: "coordinator-proof-replay-failed", error, cause: error?.cause }); });
    // 完成队首后立即升级并投递下一个 waiting-head resume intent，不唤醒其余
    // followers；投递失败记 delivery debt，由下次触发或 R5 轮询通道重放。
    void pumpResumeIntents().catch((error) => { diagnose({ version: 1, phase: "coordinator-resume-pump-failed", error, cause: error?.cause }); });
    return completed;
  }

  function reportResolvingConflict(input: any, binding: any) {
    if (!integrationQueue) throw new Error("coordinator integration queue is unavailable");
    const item = input.queueItemId ? integrationQueue.getItem(input.queueItemId) : integrationQueue.findByBinding(binding);
    assertChildBinding(item, binding);
    return integrationQueue.markResolvingConflict({ queueItemId: item.queueItemId, queueLeaseId: input.queueLeaseId ?? item.queueLeaseId });
  }

  function abandonIntegration(input: any, binding: any) {
    if (!integrationQueue || !workspaceService) throw new Error("coordinator integration queue is unavailable");
    const item = integrationQueue.getItem(input.queueItemId); assertChildBinding(item, binding);
    if (item.queueLeaseId !== input.queueLeaseId) throw new Error("queue lease mismatch");
    workspaceService.abandonIntegrationIntent(item, binding);
    const preserved = integrationQueue.failItem({ queueItemId: item.queueItemId, queueLeaseId: item.queueLeaseId, revision: item.revision });
    return input.retry === true ? integrationQueue.retryItem({ queueItemId: preserved.queueItemId, queueLeaseId: preserved.queueLeaseId, revision: preserved.revision }) : preserved;
  }

  function settleOwnedDisposition(input: any, operation: "preserve" | "discard" | "release") {
    if (!workspaceService || !integrationQueue || !dispositionSettlement) throw new Error("coordinator settlement is unavailable");
    // 已知 workspaceId 直读目标 receipt，不经过全局枚举；owner 不匹配或 ID 不
    // 存在时由 readOwned fail-closed，不把空结果当成无 workspace。
    const entry = workspaceService.readOwned({ workspaceId: input.workspaceId, ownerScope: input.ownerScope });
    const binding = { workspaceId: entry.workspaceId, leaseId: entry.leaseId, runId: entry.run?.runId ?? null, ownerScope: input.ownerScope };
    const queueItem = integrationQueue.findByBinding(binding);
    const prepared = workspaceService.prepareOwnedDisposition({ ...input, operation }, { settlementId: randomUUID(), queueItem });
    const result = dispositionSettlement.settlePrepared(prepared);
    void pumpResumeIntents().catch(error => diagnose({ version: 1, phase: "coordinator-settlement-pump-failed", error, cause: error?.cause }));
    return result;
  }

  function trustedWorkspace(binding: any) {
    if (!workspaceService) throw new Error("coordinator workspace service is unavailable");
    // 目标 workspaceId 直读：owner 不匹配或记录损坏由 readOwned fail-closed，
    // 这里只继续校验可信 run/lease 绑定本身。
    const entry = workspaceService.readOwned({ workspaceId: binding.workspaceId, ownerScope: binding.ownerScope });
    if (entry.run?.runId !== binding.runId) throw new Error("trusted run binding is unavailable");
    if (entry.leaseId !== binding.leaseId) throw new Error("trusted workspace lease mismatch");
    return entry;
  }

  function integrationFallbackBlockedReasons(binding: any): string[] {
    if (!integrationQueue || !workspaceService || !proofOutbox) return ["integration-coordinator-unavailable"];
    trustedWorkspace(binding);
    const items = integrationQueue.listQueue().filter(item => item.workspaceId === binding.workspaceId);
    const item = integrationQueue.findByBinding(binding);
    if (items.some(current => current.leaseId !== binding.leaseId || current.childRunId !== binding.runId
        || current.ownerScope?.kind !== binding.ownerScope.kind || current.ownerScope?.rootSessionId !== binding.ownerScope.rootSessionId)) return ["queue-binding-mismatch"];
    if (integrationQueue.listResumeIntents().some(intent => intent.workspaceId === binding.workspaceId
        && ["starting", "activated"].includes(intent.state))) return ["queue-resume-in-progress"];
    if (!item) return workspaceService.integrationState({}, binding).intent ? ["queue-intent-orphaned"] : [];
    if (item.autoManaged !== true) return ["queue-child-authorization-required"];
    if (!["queued", "admitted", "prepared", "completed"].includes(item.state)) return ["queue-recovery-required"];
    const completion = workspaceService.inspectIntegrationCompletion(binding);
    if (item.state === "completed" && (!completion.integrationReceipt
        || item.workspaceDispositionReceiptId !== completion.integrationReceipt.receiptId
        || item.candidateHead !== completion.integrationReceipt.candidateHead
        || item.integrationIntentId !== completion.integrationReceipt.integrationIntentId)) return ["queue-receipt-mismatch"];
    if (item.state !== "completed" && completion.integrationReceipt && item.state !== "prepared") return ["queue-receipt-mismatch"];
    return [];
  }

  async function integrateTerminalWorkspace(binding: any, terminalProof: any, additionalWritePaths: readonly string[] = []) {
    const blocked = integrationFallbackBlockedReasons(binding);
    if (blocked.length) throw Object.assign(new Error(`integration fallback blocked: ${blocked.join(", ")}`), { code: "MANAGED_WORKSPACE_INTEGRATE" });
    // 合法 coding allocation/bindRun 可能因 child 工具未装载而没有 queue item。
    // 首次偏离是 publication 从未入队；父侧授权由 service 的 proof+快照 CAS 消费，
    // 随后复用原 auto queue，绝不建立第二份 workspace 或 publication 账本。
    prepareAutoIntegration(binding);
    // 父会话对派发合同未声明路径的显式补授权：在准入前持久写入队列项，
    // 授权事实（会话身份、时间、路径）随队列项留痕；queue 层独立做文法与
    // 终态 fail-closed，不信任 service 已验证过的输入。
    if (additionalWritePaths.length > 0) {
      integrationQueue!.authorizeAdditionalWritePaths({ ...binding, additionalWritePaths: [...additionalWritePaths] });
    }
    let item = integrationQueue!.findByBinding(binding);
    if (item.state === "prepared") {
      publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: item.queueLeaseId, candidateHead: item.candidateHead }, binding);
    } else if (item.state !== "completed") {
      advanceAutoIntegration({}, binding);
    }
    item = integrationQueue!.findByBinding(binding);
    // FIFO 尚未准入、冲突和失败不能被当成成功；已有 queue/proof 现场供后续恢复。
    if (item.state !== "completed") throw Object.assign(new Error(`integration queue is ${item.state}; query status before retrying`), { code: "MANAGED_WORKSPACE_INTEGRATE" });
    const completion = workspaceService!.inspectIntegrationCompletion(binding);
    if (!completion.integrationReceipt || item.workspaceDispositionReceiptId !== completion.integrationReceipt.receiptId) throw new Error("integration queue receipt is incomplete");
    // 已发布的 completed 项只补证明/回收，禁止再次应用候选或重写后续用户提交。
    await proofOutbox!.enqueue({ ...terminalProof, workspaceId: binding.workspaceId, ownerScope: binding.ownerScope });
    await replayTerminalProofs();
    const accepted: any = await proofOutbox!.receipt(terminalProof.proofId);
    if (!accepted?.accepted || accepted.receipt?.workspaceId !== binding.workspaceId || accepted.receipt?.leaseId !== binding.leaseId
        || accepted.receipt?.state !== "released") throw new Error("integration terminal proof settlement remains pending");
    return accepted.receipt;
  }

  function inspectAutoIntegration(binding: any) {
    const entry = trustedWorkspace(binding);
    const item = integrationQueue?.findByBinding(binding) ?? null;
    const completion = workspaceService!.inspectIntegrationCompletion(binding);
    return Object.freeze({
      queueItem: item ? { queueItemId: item.queueItemId, requestId: item.requestId, state: item.state, revision: item.revision } : null,
      queueState: item?.state ?? "absent",
      admissionGeneration: item?.admissionGeneration ?? 0,
      targetHead: item?.admittedTargetHead ?? item?.observedTargetHead ?? null,
      workspaceState: completion.workspaceState,
      ...(typeof item?.conflictDigest === "string" ? { conflictDigest: item.conflictDigest, continuationAttempt: item.continuationAttempt ?? 0 } : {}),
    });
  }

  function prepareAutoIntegration(binding: any) {
    const entry = trustedWorkspace(binding);
    const existing = integrationQueue?.findByBinding(binding);
    if (existing) {
      // child 的首个 agent_end 可能早于其业务 commit（纯文本 turn）：入队会
      // 固化过早的 authorizedWorkspaceHead。child 后续自有 commit 使 HEAD
      // 前进为旧授权头的后代时刷新授权头；非后代/漂移保持不变，由
      // admission 失败 fail closed 进入人工处置。
      refreshAuthorizedWorkspaceHead(existing, entry);
      return inspectAutoIntegration(binding);
    }
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: entry.path, encoding: "utf8" }).trim();
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("workspace HEAD is invalid");
    const targetRef = entry.originRef;
    if (typeof targetRef !== "string" || !targetRef) throw new Error("workspace origin ref is unavailable");
    const requestId = createHash("sha256").update(`${options.repositoryId}\u0000${binding.ownerScope.rootSessionId}\u0000${binding.runId}\u0000${entry.workspaceId}\u0000${entry.leaseId}\u0000${head}\u0000${targetRef}`).digest("hex");
    enqueueIntegration({ requestId, workspaceId: entry.workspaceId, leaseId: entry.leaseId, authorizedWorkspaceHead: head, targetRef, autoManaged: true }, binding);
    return inspectAutoIntegration(binding);
  }

  function refreshAuthorizedWorkspaceHead(item: any, entry: any) {
    if (!integrationQueue || item?.state !== "queued" || item?.autoManaged !== true) return;
    if (item.workspaceId !== entry.workspaceId || item.leaseId !== entry.leaseId) return;
    let head: string;
    try {
      head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: entry.path, encoding: "utf8" }).trim();
    } catch (error) {
      diagnose({ version: 1, phase: "coordinator-authorized-head-read-failed", error, cause: error?.cause, queueItemId: item.queueItemId, workspaceId: item.workspaceId });
      return;
    }
    if (head === item.authorizedWorkspaceHead) return;
    // 只接受旧授权头的后代：child 纯新增 commit。任何其它漂移都不刷新。
    let descendant = false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", item.authorizedWorkspaceHead, head], { cwd: entry.path, stdio: ["ignore", "ignore", "ignore"] });
      descendant = true;
    } catch (error) {
      diagnose({ version: 1, phase: "coordinator-authorized-head-ancestry-check-failed", error, cause: error?.cause, queueItemId: item.queueItemId, workspaceId: item.workspaceId, authorizedWorkspaceHead: item.authorizedWorkspaceHead, observedHead: head });
      descendant = false;
    }
    if (!descendant) return;
    integrationQueue.refreshAuthorizedWorkspaceHead({ queueItemId: item.queueItemId, authorizedWorkspaceHead: head });
  }

  function advanceAutoIntegration(input: any, binding: any) {
    if (!integrationQueue || !workspaceService) throw new Error("coordinator workspace service is unavailable");
    let item = integrationQueue.findByBinding(binding);
    if (!item) throw new Error("auto integration queue item is absent");
    if (item.state === "completed" || item.state === "preserved" || item.state === "cancelled") return inspectAutoIntegration(binding);
    const admission = awaitIntegrationAdmission(item.queueItemId, binding);
    if (!admission) return inspectAutoIntegration(binding);
    item = integrationQueue.getItem(item.queueItemId);
    // Conflict continuation is a trusted durable queue fact. The child broker
    // wire carries an empty input, so never depend on a model/runtime flag to
    // resume an already resolving rebase.
    const candidate = workspaceService.managedRebase({ targetHead: admission.targetHead, queueLeaseId: admission.queueLeaseId, admissionGeneration: admission.admissionGeneration, continue: item.state === "resolving-conflict" || input?.continue === true }, binding);
    if (candidate.state === "resolving-conflict") {
      const conflictDigest = createHash("sha256").update(`${candidate.head}:${candidate.changedFiles?.join("\u0000") ?? ""}`).digest("hex");
      const conflict = integrationQueue.markResolvingConflict({
        queueItemId: item.queueItemId,
        queueLeaseId: admission.queueLeaseId,
        admissionGeneration: admission.admissionGeneration,
        conflictDigest,
        // 只有无人认领的推进（reconcile）才把同一冲突摘要的重复计为一次空转续轮；
        // child 主动 continue 的计数职责仍是它自己的 guard。
        countNoProgress: input?.unattended === true,
      });
      return { ...inspectAutoIntegration(binding), conflictDigest, continuationAttempt: conflict.continuationAttempt, noProgress: conflict.noProgress, exhausted: conflict.exhausted === true };
    }
    return publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: candidate.head }, binding);
  }

  function inspectIntegrationState(binding: any) {
    if (!integrationQueue || !workspaceService) throw new Error("coordinator integration state is unavailable");
    const completion = workspaceService.inspectIntegrationCompletion(binding);
    const item = integrationQueue.findByBinding(binding);
    const receipt = completion.integrationReceipt;
    return Object.freeze({
      queueState: item?.state ?? "absent",
      workspaceState: completion.workspaceState,
      integrationReceipt: Boolean(receipt && item?.workspaceDispositionReceiptId === receipt.receiptId),
      proofState: completion.proofState,
      terminalProof: completion.terminalProof,
      revision: item?.revision ?? 0,
    });
  }

  function preserveIntegrationDebt(binding: any, reason = "integration recovery required") {
    if (!integrationQueue || !workspaceService) throw new Error("coordinator integration state is unavailable");
    const item = integrationQueue.findByBinding(binding);
    if (item) {
      integrationQueue.preserveByBinding(binding, reason);
      const intent = integrationQueue.recoveryIntent({ queueItemId: item.queueItemId, workspaceId: item.workspaceId, ownerScope: binding.ownerScope, runId: binding.runId,
        attempt: item.attempt, generation: item.admissionGeneration, reason, requiredAction: "preserve" });
      void Promise.resolve(options.recoveryEventSink?.(intent)).then((delivery) => integrationQueue.markRecoveryDelivery(intent.recoveryIntentId, delivery ?? { state: "debt", reason: "recovery event sink unavailable" })).catch((error) => integrationQueue.markRecoveryDelivery(intent.recoveryIntentId, { state: "debt", reason: String(error?.message ?? error) }).catch((secondaryError) => { diagnose({ version: 1, phase: "coordinator-recovery-debt-record-failed", error, cause: error?.cause, secondaryError, secondaryCause: secondaryError?.cause, recoveryIntentId: intent.recoveryIntentId }); }));
    }
    workspaceService.preserveIntegrationDebt(binding);
    return inspectIntegrationState(binding);
  }

  /**
   * reconcile 是「无人认领」的推进：只有该项记录的 daemon claim 已不可用（死进程或被
   * 复用的 pid）时，重复冲突才计入无进展上限。认领方仍活着的项由 child 自己继续
   * rebase，reconcile 不得抢先判无进展；liveness 不可判定同样不计入（宁可空转也不误判）。
   */
  function claimOwnerUnavailable(item: any) {
    const claim = item?.daemonClaim;
    if (!claim || typeof claim.pid !== "number" || typeof claim.birthIdentity !== "string") return true;
    const status = processAliveStatus(claim.pid, claim.birthIdentity);
    if (status.state === "undetermined") {
      diagnose({ version: 1, phase: "coordinator-reconcile-claim-liveness-undetermined", state: status.state, error: (status as any).error, errno: (status as any).errno, queueItemId: item.queueItemId, instanceId: claim.instanceId });
      return false;
    }
    return status.state !== "alive";
  }

  function reconcileIntegrations() {
    if (!integrationQueue || !workspaceService) return [];
    const results = [];
    for (const item of integrationQueue.listQueue()) {
      if (!["queued", "admitted", "rebasing", "resolving-conflict", "prepared"].includes(item.state)) continue;
      const binding = { workspaceId: item.workspaceId, leaseId: item.leaseId, ownerScope: item.ownerScope, runId: item.childRunId };
      try {
        if (item.state === "prepared") { results.push(publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: item.queueLeaseId, candidateHead: item.candidateHead }, binding)); continue; }
        const advance = advanceAutoIntegration({ unattended: claimOwnerUnavailable(item) }, binding);
        // 无进展上限命中：与 resume intent 耗尽路径同一收敛形态（preserve + recovery intent /
        // delivery debt），把静默空转变成可归因终态。preserve 自身失败仍走下面的 catch 分支。
        if (advance?.exhausted === true) {
          const preserved = preserveIntegrationDebt(binding, "resolving-conflict repeated without progress under coordinator reconcile");
          results.push({ queueItemId: item.queueItemId, state: preserved?.queueState ?? "preserved", error: null, reason: "conflict-no-progress-exhausted" });
          continue;
        }
        results.push(advance);
      }
      catch (error) {
        // preserve 本身也可能失败（workspace 已不在 active）：结果必须如实投影，
        // 不能让「preserve 失败」被误报为「已 preserve」。
        let preserved = false;
        try { preserveIntegrationDebt(binding, "coordinator-reconcile-rejected"); preserved = true; }
        catch (secondaryError) { diagnose({ version: 1, phase: "coordinator-reconcile-preserve-failed", error, cause: error?.cause, secondaryError, secondaryCause: secondaryError?.cause, queueItemId: item.queueItemId }); }
        results.push({ queueItemId: item.queueItemId, state: preserved ? "preserved" : "unchanged", error: String((error as any)?.message ?? error) });
      }
    }
    return results;
  }
  /**
   * proof debt 重投（审计 #7 的唯一恢复 owner）。
   *
   * Host 侧 `classifyTerminalProofBinding` 在绑定不可解析时把证明记成 debt，但
   * outbox 的 replay 只重投 pending：一旦 durable 事实后来补齐（ledger 重新可读、
   * workspace 绑定稳定、官方 process-terminal.json 落盘），debt 没有任何泵，证明
   * 永久不可达。这里在启动恢复里按 runId 直读 ledger：恰好一条 owned workspace、
   * 且能重建出与 debt 同一 proofId 的完整 7 字段证明时，把它重新入 pending 并从
   * debts 移除（`enqueue` 的既有语义）；找不到、歧义、身份不一致或与已记录证明
   * 冲突时保持 debt，只落诊断，不猜测、不降级。
   */
  async function reconcileProofDebts() {
    if (!proofOutbox || !workspaceService) return { reinjected: [] as string[], retained: [] as string[] };
    const debts = await proofOutbox.debts();
    const reinjected: string[] = [];
    const retained: string[] = [];
    if (debts.length === 0) return { reinjected, retained };
    let records: any[];
    try {
      // 与 proof outbox 同一 storage partition；legacy v1 record 只跳过并转发诊断，
      // v2/未知 schema 仍 fail-closed（T1 合同）。
      records = createManagedWorkspaceLedger({ stateRoot, storageRepositoryId }).list({
        storagePartitionOnly: true,
        onInvalid: (diagnostic) => diagnose({ version: 1, phase: "coordinator-proof-debt-ledger-invalid", diagnostic }),
      });
    } catch (error) {
      diagnose({ version: 1, phase: "coordinator-proof-debt-ledger-failed", error, cause: (error as any)?.cause,
        reason: "workspace ledger 不可读，无法按 run 重建证明",
        next: "核对 state root 与 ledger 文件权限/结构后重跑启动对账；修好前 debt 保持不变，不要手工改 outbox 或 ledger。" });
      return { reinjected, retained: debts.map((debt) => debt.proofId) };
    }
    for (const debt of debts) {
      // INV-EXIT（审计 #7）：保持 debt 时必须给出原因与 next——reconcileProofDebts 就是
      // 这类债务的唯一恢复 owner，回执不能只说「还不行」。
      const retain = (phase: string, reason: string, next: string, detail: Record<string, unknown> = {}) => {
        diagnose({ version: 1, phase, proofId: debt.proofId, runId: debt.runId, reason, next, ...detail });
        retained.push(debt.proofId);
      };
      const matches = records.filter((record: any) => record?.run?.runId === debt.runId);
      if (matches.length !== 1) {
        retain("coordinator-proof-debt-binding-ambiguous", `ledger 中该 run 对应 workspace 为 ${matches.length} 条（要求恰好一条）`,
          "先用 workspace 审计/queue audit 核对唯一绑定；多条属歧义，保持 debt 交人工处置，不要挑一条重投。", { matched: matches.length });
        continue;
      }
      const record: any = matches[0];
      const ownerScope = { kind: "standalone-subagent" as const, rootSessionId: record.request?.owner?.rootSessionId };
      let durableFailure: any;
      const proof = readDurableObservedTerminalProof({ run: record.run, rootSessionId: ownerScope.rootSessionId,
        onDiagnostic: (entry) => { durableFailure = entry; } });
      if (!proof) {
        retain("coordinator-proof-debt-durable-fact-unavailable",
          durableFailure?.reason ?? "durable 终局事实不可用",
          durableFailure?.next ?? "确认 child 已终止并产出官方 process-terminal.json 后重跑对账；仍缺失按阻断上报（debt 保持）。",
          { workspaceId: record.workspaceId });
        continue;
      }
      if (proof.proofId !== debt.proofId) {
        retain("coordinator-proof-debt-identity-mismatch", "durable 制品的 proofId 与 debt 记录的 proofId 不一致",
          "确认证明来源（是否被改写或换了 run）；跨 run 不一致不得重投，按阻断上报并保留现场。",
          { workspaceId: record.workspaceId, durableProofId: proof.proofId });
        continue;
      }
      // broker 侧的 terminalConflict 是内存标志，coordinator 可见的 durable 等价物
      // 是 workspace 已记录的另一份 observed 证明：同一 run 出现两个 proofId 即冲突。
      if (record.terminalProof?.state === "observed" && record.terminalProof.proofId !== proof.proofId) {
        retain("coordinator-proof-debt-terminal-conflict", "同一 workspace 已记录另一份 observed 证明",
          "保持 debt 并按阻断上报；不要覆盖已记录 proof、不要删除 ledger 记录。",
          { workspaceId: record.workspaceId, recordedProofId: record.terminalProof.proofId });
        continue;
      }
      try {
        await proofOutbox.enqueue({ ...proof, workspaceId: record.workspaceId, ownerScope });
        const status = await proofOutbox.status(debt.proofId);
        // delivered 说明债务已被既有 receipt 覆盖（无待办）；pending 即本次重投成功。
        if (status.state === "pending" || status.state === "delivered") { reinjected.push(debt.proofId); continue; }
        retain("coordinator-proof-debt-reinject-incomplete", `重投后 outbox 状态仍为 ${String((status as any).state)}`,
          "检查 outbox 文件与并发写入（terminal-proofs.json）；仍不成功按阻断上报并保留 outbox 现场。",
          { workspaceId: record.workspaceId, observedState: status.state });
      } catch (error) {
        diagnose({ version: 1, phase: "coordinator-proof-debt-reinject-failed", error, cause: (error as any)?.cause, proofId: debt.proofId, runId: debt.runId,
          reason: error instanceof Error ? (error.message || "重投写入失败") : String(error),
          next: "核对 state root 与 outbox 目录的权限/磁盘后重试；不要手工改 outbox 文件。" });
        retained.push(debt.proofId);
      }
    }
    if (reinjected.length > 0) diagnose({ version: 1, phase: "coordinator-proof-debt-reinjected", reinjected, retained });
    return { reinjected, retained };
  }
  /**
   * 死 daemon claim 回收（审计 #13 / INV-WIRING）：`recoverClaims` 早已实现但全仓
   * 零调用方，死 daemon 留下的 admitted claim 会永久卡住 FIFO。启动恢复用本 daemon
   * 自己的 instanceIdentity 调用；具体回收对象由 queue 侧按 claim 自己记录的 daemon
   * 身份做四态活性判定（undetermined 保持不动，绝不按时间推断）。结果落诊断。
   */
  function recoverDeadClaims() {
    if (!integrationQueue) return [];
    try {
      const recovered = integrationQueue.recoverClaims(daemonIdentity);
      diagnose({ version: 1, phase: "coordinator-recover-claims", count: recovered.length,
        recovered: recovered.map((item: any) => ({ queueItemId: item.queueItemId, workspaceId: item.workspaceId, state: item.state })) });
      return recovered;
    } catch (error) {
      diagnose({ version: 1, phase: "coordinator-recover-claims-failed", error, cause: (error as any)?.cause });
      return [];
    }
  }
  /** 启动对账残余（审计 #14 / INV-WIRING）：released 孤儿解除阻塞后，剩余非终态项
   * 做一次全量对账（推进或 preserve），结果落诊断；失败不阻断 startupReady。 */
  function reconcileIntegrationsAtStartup() {
    if (!integrationQueue || !workspaceService) return [];
    try {
      const results = reconcileIntegrations();
      diagnose({ version: 1, phase: "coordinator-startup-reconcile", visited: results.length,
        results: results.map((entry: any) => ({ queueItemId: entry?.queueItemId ?? null, state: entry?.state ?? null, error: entry?.error ?? null, ...(entry?.reason === undefined ? {} : { reason: entry.reason }) })) });
      return results;
    } catch (error) {
      diagnose({ version: 1, phase: "coordinator-startup-reconcile-failed", error, cause: (error as any)?.cause });
      return [];
    }
  }
  /**
   * 启动孤儿项对账：workspace 已 release 终态但队列项仍 queued 的组合是永久
   * 孤儿（工作树已删、无任何合法认领方），会阻塞整个 durable FIFO。按队列项
   * 自身记录的 binding（与 reconcileIntegrations 同权限模型）转 preserved 终态
   * 并写回执事件；其余非终态项留给正常集成/恢复路径，不抢占活跃 claim。
   * 纯 ledger 读写，可在启动恢复内联完成。
   */
  function reconcileReleasedOrphanQueueItems() {
    if (!integrationQueue || !workspaceService) return [];
    const results = [];
    for (const item of integrationQueue.listQueue()) {
      if (item.state !== "queued") continue;
      try {
        const entry = workspaceService.readOwned({ workspaceId: item.workspaceId, ownerScope: item.ownerScope });
        if (entry?.state !== "released") continue;
        const preserved = integrationQueue.preserveByBinding(
          { workspaceId: item.workspaceId, leaseId: item.leaseId, runId: item.childRunId, ownerScope: item.ownerScope },
          "workspace released: orphan queue item unblocked at coordinator startup",
        );
        if (preserved?.state === "preserved") results.push({ queueItemId: item.queueItemId, workspaceId: item.workspaceId, state: preserved.state });
        else diagnose({ version: 1, phase: "coordinator-orphan-reconcile-skip", queueItemId: item.queueItemId, workspaceId: item.workspaceId, observedState: preserved?.state ?? null });
      } catch (error) {
        diagnose({ version: 1, phase: "coordinator-orphan-reconcile-item-failed", error, cause: (error as any)?.cause, queueItemId: item.queueItemId, workspaceId: item.workspaceId });
      }
    }
    return results;
  }
  // FIFO 队首升级 + 主 Agent 接管提示：只升级队首的 waiting-head intent。
  // 已结束 child 不自动 resume；检查与 durable intent 保留，交由主 Agent 接管 worktree。
  // receipt 与 delivery 状态均以 coordinator durable 存储为权威，重复触发幂等。
  async function pumpResumeIntents() {
    if (!integrationQueue) return { promoted: null, delivered: 0 };
    const promoted = integrationQueue.promoteRecoverableHead();
    const deliverable = integrationQueue.listResumeIntents().filter((intent: any) => intent.state === "pending" && intent.delivery?.state !== "delivered");
    for (const intent of deliverable) {
      try {
        const handoff = createManualIntegrationHandoff({ resumeIntentId: intent.resumeIntentId, sourceRunId: intent.sourceRunId, workspaceId: intent.workspaceId, queueItemId: intent.queueItemId });
        const delivery = await options.recoveryEventSink?.({ ...structuredClone(intent), handoff });
        integrationQueue.markResumeDelivery(intent.resumeIntentId, delivery ?? { state: "debt", reason: "manual handoff notification unavailable" });
      } catch (error) {
        try { integrationQueue.markResumeDelivery(intent.resumeIntentId, { state: "debt", reason: String((error as any)?.message ?? error) }); } catch (secondaryError) { diagnose({ version: 1, phase: "coordinator-resume-debt-record-failed", error, cause: error?.cause, secondaryError, secondaryCause: secondaryError?.cause, resumeIntentId: intent.resumeIntentId }); }
      }
    }
    return { promoted, delivered: deliverable.length };
  }
  async function deliverTerminalProof(proof: any) {
    const { workspaceId, ownerScope: proofOwnerScope, ...terminalProof } = proof;
    let item = integrationQueue?.listQueue().filter((entry: any) => entry.workspaceId === workspaceId
      && entry.childRunId === terminalProof.runId && entry.ownerScope?.kind === proofOwnerScope?.kind
      && entry.ownerScope?.rootSessionId === proofOwnerScope?.rootSessionId).at(-1);
    if (item?.dispositionSettlementId && ["cancelled", "preserved"].includes(item.state)) {
      const prepared = workspaceService!.readPreparedDisposition({ workspaceId, ownerScope: proofOwnerScope, settlementId: item.dispositionSettlementId });
      // 结算 binding 全等是「同一事实」的唯一判据：后到证明的 run/asyncDir 与
      // owner scope 必须与 prepare 时持久记录的 binding 完全一致。
      const bindingMatches = prepared.binding.runId === terminalProof.runId
        && prepared.binding.asyncDir === terminalProof.asyncDir
        && prepared.binding.rootSessionId === proofOwnerScope?.rootSessionId
        && prepared.queueReceiptRef === item.dispositionReceiptRef;
      if (prepared.phase !== "settled" || !bindingMatches) throw new Error(`terminal proof does not match settled disposition receipt: 证明的 runId/asyncDir/owner scope 或 queue receipt 与已结算 disposition 不一致；next: 按 queue.audit 的 receipt/结算记录核对证明来源，不要重复投递同一 proof；确实属同事实时由 reconcile 重放，仍不一致按阻断上报。`);
      if (prepared.proofHash === null) {
        // 审计 #8：结算时「证明未观察」（proofHash null）不等于「后到真证明非法」。
        // binding 全等时把证明补记到 workspace 记录，再走既有 settle 幂等路径；
        // 同一 workspace 已记录另一份 observed 证明（proofId 不同）仍按冲突拒绝，
        // 防伪造语义不变。
        const recorded = workspaceService!.readOwned({ workspaceId, ownerScope: proofOwnerScope }).terminalProof;
        if (recorded?.state === "observed" && recorded.proofId !== terminalProof.proofId) throw new Error("terminal proof does not match the recorded terminal proof: 同一 workspace 已记录另一份 observed 证明（后到证明与已记录证明 proofId 不同）；next: 保持现场并按阻断上报，不要覆盖已记录 proof 或伪造后到证明。");
        if (recorded?.proofId !== terminalProof.proofId) workspaceService!.recordTerminalProof({ workspaceId, ownerScope: proofOwnerScope, proof: terminalProof });
      } else if (prepared.proofHash !== terminalProof.proofId) {
        // 结算时已观察证明：proofId 必须全等（防伪造）。
        throw new Error("terminal proof does not match settled disposition receipt: 结算时已记录另一份 observed 证明，proofId 必须全等；next: 核对证明来源后按阻断上报，不要覆盖已结算证明。");
      }
      integrationQueue!.verifyDispositionBinding(prepared);
      const receipt = workspaceService!.markDispositionSettled({ workspaceId, ownerScope: proofOwnerScope, settlementId: prepared.settlementId, queueReceiptRef: prepared.queueReceiptRef });
      return { accepted: true, proofId: terminalProof.proofId, receipt };
    }
    if (item && item.state !== "completed") {
      if (item.childRunId !== terminalProof.runId || item.ownerScope?.rootSessionId !== proofOwnerScope?.rootSessionId) {
        throw new Error("terminal proof does not match trusted child binding: queue item 的 childRunId/owner scope 与证明不一致；next: 用 queue.audit 核对队列项 binding，不一致即证明不属于该队列项，按阻断上报，不要改队列项后重试。");
      }
      workspaceService!.recordTerminalProof({ workspaceId, ownerScope: proofOwnerScope, proof: terminalProof });
      const binding = { workspaceId, leaseId: item.leaseId, runId: terminalProof.runId, ownerScope: proofOwnerScope };
      if (item.state === "queued" && workspaceService!.noPayloadFacts(binding).eligible) {
        const issued = workspaceService!.issueOwnedDisposition({ workspaceId, ownerScope: proofOwnerScope, terminalProof });
        const receipt = settleOwnedDisposition({ workspaceId, ownerScope: proofOwnerScope, terminalProof, actionToken: issued.actionToken }, "discard");
        return { accepted: true, proofId: terminalProof.proofId, receipt };
      }
      // 官方终局证明已落盘，child 不再执行；仅接续自动集成的机械阶段。
      // admission/rebase 的原门禁照常执行，冲突或拒绝仍由 durable intent 交接人工。
      if (item.autoManaged === true && ["queued", "prepared"].includes(item.state)) {
        try {
          if (item.state === "queued") {
            refreshAuthorizedWorkspaceHead(item, trustedWorkspace(binding));
            advanceAutoIntegration({}, binding);
          } else {
            publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: item.queueLeaseId, candidateHead: item.candidateHead }, binding);
          }
        } catch (error) {
          diagnose({ version: 1, phase: "coordinator-terminal-integration-blocked", error, queueItemId: item.queueItemId });
        }
        item = integrationQueue!.getItem(item.queueItemId);
      }
      // child 在 integration 完成前退出：proof 保持 pending，同时创建/更新
      // durable resume intent；队首 intent 升级后只发送主 Agent 接管提示，
      // 不再调用 upstream resume 拉起已结束的 child。
      if (RESUMABLE_PROOF_QUEUE_STATES.includes(item.state)) {
        integrationQueue!.requestChildResume({ queueItemId: item.queueItemId, sourceRunId: terminalProof.runId, sourceAsyncDir: terminalProof.asyncDir, sourceProofId: terminalProof.proofId });
        await pumpResumeIntents().catch((error) => { diagnose({ version: 1, phase: "coordinator-resume-pump-failed", error, cause: error?.cause }); });
      }
      if (item.state !== "completed") throw new Error("terminal proof delivery remains pending until the child integration completes: 队列项仍未到 completed（集成未完成或已交人工）；next: 等 child integration 完成或由启动对账/auto-integration 推进；不要重复投递同一 proof，集成冲突时按 durable resume intent 交接处置。");
    }
    if (!item) throw new Error("terminal proof requires a completed child integration: 该 workspace 没有对应队列项，证明无处交付；next: 确认 run 是否以 worktree 派发且已入队（queue.audit），缺项属事实不匹配，按阻断上报，不要伪造队列项。");
    if (item.childRunId !== terminalProof.runId || item.ownerScope?.rootSessionId !== proofOwnerScope?.rootSessionId) {
      throw new Error("terminal proof does not match trusted child binding: queue item 的 childRunId/owner scope 与证明不一致；next: 用 queue.audit 核对队列项 binding；不一致即证明不属于该队列项，按阻断上报。");
    }
    // Replay after a crash between discard and receipt persistence must stay
    // idempotent; a released workspace already settled this proof.
    const released = workspaceService!.readOwned({ workspaceId, ownerScope: proofOwnerScope });
    if (released?.state === "released") return { accepted: true, proofId: terminalProof.proofId, receipt: released };
    workspaceService!.recordTerminalProof({ workspaceId, ownerScope: proofOwnerScope, proof: terminalProof });
    const status = workspaceService!.statusOwned({ workspaceId, ownerScope: proofOwnerScope, terminalProof });
    const issued = workspaceService!.issueAction({ workspaceId, ownerScope: proofOwnerScope, action: "discard", terminalProof, snapshotHash: status.snapshotHash });
    const receipt = workspaceService!.discardOwned({ workspaceId, ownerScope: proofOwnerScope, terminalProof, actionToken: issued.actionToken });
    return { accepted: true, proofId: terminalProof.proofId, receipt };
  }
  async function replayTerminalProofs() {
    if (!proofOutbox || !workspaceService || !integrationQueue) return { delivered: 0, pending: 0 };
    return proofOutbox.replay(deliverTerminalProof);
  }
  async function handle(request: any) {
    if (request.request.method === "queue.audit") {
      const audit = auditManagedWorkspaces({ stateRoot: declaredStateRoot });
      // 回执事件全量聚合（含 delivered/debt）供运维审计（计划 T4）；pending 拉取走 queue.receipt-events。
      return { ...audit, recoveryIntents: integrationQueue?.listRecoveryIntents() ?? [], notificationDeliveryDebt: integrationQueue?.notificationDeliveryDebt() ?? [], receiptEvents: integrationQueue?.listReceiptEvents() ?? [] };
    }
    if (request.request.method === "record_terminal_proof" && workspaceService && integrationQueue && proofOutbox) {
      const params = request.request.params ?? {};
      const ownerScope = request.ownerScope;
      const existing = await proofOutbox.receipt(params.proof?.proofId);
      if (existing !== undefined) return existing;
      await proofOutbox.enqueue({ ...structuredClone(params.proof), workspaceId: params.workspaceId, ownerScope: structuredClone(ownerScope) });
      await replayTerminalProofs();
      const delivered = await proofOutbox.receipt(params.proof.proofId);
      if (delivered === undefined) throw new Error("terminal proof delivery remains pending: enqueue 后未产生 receipt（交付被拒或仍在 pending）；next: 用 queue.audit 与 coordinator 诊断（coordinator-proof-delivery-failed）定位拒绝原因，按原因修复后重试；不要伪造 receipt。");
      return delivered;
    }
    if (request.request.method !== "binding.register") return options.handler?.(request);
    if (!workspaceService) throw new Error("coordinator workspace service is unavailable");
    const params = request.request.params ?? {};
    const input = params.input ?? {};
    const ownerScope = request.ownerScope;
    const ownedInput = { ...input, ownerScope };
    // Child wire calls intentionally contain no private identity.  Resolve an
    // omitted binding inside the authenticated broker registration scope, then
    // validate it against the durable workspace ledger before use.
    const registeredBinding = () => {
      const supplied = input.workspaceId && input.leaseId && input.runId
        ? { workspaceId: input.workspaceId, leaseId: input.leaseId, runId: input.runId, ownerScope }
        : undefined;
      if (supplied) {
        trustedWorkspace(supplied);
        registrationBindings.set(request.registration.capability, structuredClone(supplied));
        return supplied;
      }
      const trusted = registrationBindings.get(request.registration.capability);
      if (!trusted) throw new Error("trusted run binding is unavailable");
      return structuredClone(trusted);
    };
    const publicBinding = () => {
      const entry = workspaceService!.readOwned({ workspaceId: input.workspaceId, ownerScope });
      return { workspaceId: entry.workspaceId, leaseId: entry.leaseId, runId: entry.run?.runId ?? null, ownerScope };
    };
    const binding = ["prepare_auto_integration", "inspect_auto_integration", "advance_auto_integration"].includes(params.operation)
      ? registeredBinding()
      : ["dispose", "release"].includes(params.operation) && (!input.leaseId || !input.runId)
        ? publicBinding()
        : { workspaceId: input.workspaceId, leaseId: input.leaseId, runId: input.runId, ownerScope };
    switch (params.operation) {
      case "reserve": return workspaceService.reserve({ ...input, owner: { ...(input.owner ?? {}), kind: ownerScope.kind, rootSessionId: ownerScope.rootSessionId } });
      case "ensureAllocated": return workspaceService.ensureAllocated({ ...input, owner: { ...(input.owner ?? {}), kind: ownerScope.kind, rootSessionId: ownerScope.rootSessionId } });
      case "bindRun": {
        // 已知 workspaceId 直读：owner 不匹配/ID 不存在由 readOwned fail-closed，
        // 不再把枚举空结果解释为未归属。
        workspaceService.readOwned({ workspaceId: input.workspaceId, ownerScope });
        return workspaceService.bindRun(input);
      }
      case "listOwned": return workspaceService.listOwned(ownedInput);
      case "statusOwned": return workspaceService.statusOwned(ownedInput);
      case "issueDisposition": return workspaceService.issueOwnedDisposition(ownedInput);
      case "dispose": {
        if (input.disposition === "integrate") return workspaceService.disposeOwned(ownedInput);
        return settleOwnedDisposition(ownedInput, input.disposition);
      }
      case "release": return settleOwnedDisposition(ownedInput, "release");
      case "reconcile": return workspaceService.reconcile(input);
      case "enqueueIntegration": {
        if (integrationQueue?.findByBinding(binding)?.autoManaged === true) throw new Error("auto integration generation rejects manual mutation");
        return enqueueIntegration(input, binding);
      }
      case "awaitIntegrationAdmission": return awaitIntegrationAdmission(input.queueItemId, binding);
      case "reportResolvingConflict": {
        if (integrationQueue?.findByBinding(binding)?.autoManaged === true) throw new Error("auto integration generation rejects manual mutation");
        return reportResolvingConflict(input, binding);
      }
      case "publishRebasedCandidate": {
        if (integrationQueue?.findByBinding(binding)?.autoManaged === true) throw new Error("auto integration generation rejects manual mutation");
        return publishRebasedCandidate(input, binding);
      }
      case "abandonIntegration": {
        if (integrationQueue?.findByBinding(binding)?.autoManaged === true) throw new Error("auto integration generation rejects manual mutation");
        return abandonIntegration(input, binding);
      }
      case "inspectIntegrationState": return inspectIntegrationState(binding);
      case "prepare_auto_integration": return prepareAutoIntegration(binding);
      case "inspect_auto_integration": return inspectAutoIntegration(binding);
      case "advance_auto_integration": return advanceAutoIntegration(input, binding);
      case "preserveIntegrationDebt": return preserveIntegrationDebt(binding, input.reason);
      case "queue.receipt-events": {
        // 回执事件只读拉取（计划 T4）：按注册 owner scope 过滤且仅返回 pending。
        // 独立方法，不改 recovery.status 的扁平数组返回形状（四个调用方按数组判别）。
        if (!integrationQueue) throw new Error("coordinator integration queue is unavailable");
        return integrationQueue.listPendingReceiptEvents(binding.ownerScope.rootSessionId);
      }
      case "queue.receipt-event-delivered": {
        // D7：Host 泵 notifyExecutionFacts 成功后回写 delivered、childRunId 缺位回写
        // debt（终态）；注册风格与 recovery.resume-delivered 一致——root 授权 +
        // owner scope 匹配；回写幂等（重放收敛、attempts 递增），未知 eventId 报错。
        if (!integrationQueue) throw new Error("coordinator integration queue is unavailable");
        if (input.authorization !== "root" || binding.ownerScope.rootSessionId !== input.ownerScope?.rootSessionId) throw new Error("root authorization required for receipt event delivery");
        return integrationQueue.markReceiptEventDelivery({ eventIds: input.eventIds, state: input.state, ...(typeof input.reason === "string" ? { reason: input.reason } : {}), ownerRootSessionId: binding.ownerScope.rootSessionId });
      }
      case "recovery.status": return [
        ...(integrationQueue?.listRecoveryIntents().filter((intent: any) => intent.ownerScope?.rootSessionId === binding.ownerScope.rootSessionId) ?? []),
        ...(integrationQueue?.listResumeIntents(binding.ownerScope.rootSessionId) ?? []),
      ];
      case "recovery.audit": return integrationQueue?.listRecoveryIntents() ?? [];
      case "recovery.preserve": return integrationQueue?.mutateRecovery({ ...input, ownerScope: binding.ownerScope }, "preserved");
      case "recovery.recover":
        if (binding.ownerScope.rootSessionId !== input.ownerScope?.rootSessionId || input.authorization !== "root") throw new Error("root authorization required for recovery");
        if (input.newRunId !== binding.runId || input.newLeaseId !== binding.leaseId) throw new Error("recovery must bind the original workspace lease and run");
        return integrationQueue?.mutateRecovery({ ...input, ownerScope: binding.ownerScope }, "recovered");
      case "recovery.retry": return integrationQueue?.mutateRecovery({ ...input, ownerScope: binding.ownerScope }, "retry");
      case "recovery.resume-debt": {
        if (!integrationQueue) throw new Error("coordinator integration queue is unavailable");
        if (input.authorization !== "root" || binding.ownerScope.rootSessionId !== input.ownerScope?.rootSessionId) throw new Error("root authorization required for recovery");
        const intent = integrationQueue.listResumeIntents().find((entry: any) => entry.resumeIntentId === input.resumeIntentId);
        if (!intent || intent.ownerScope?.rootSessionId !== binding.ownerScope.rootSessionId) throw new Error("resume intent owner scope denied");
        return integrationQueue.markResumeDelivery(intent.resumeIntentId, { state: "debt", reason: String(input.reason ?? "resume failed").slice(0, 240) });
      }
      case "recovery.resume-delivered": {
        // D7：Host 轮询泵送达 handoff followUp 后的幂等回执；daemon 自身无
        // pi.sendMessage 快路径，送达标记必须由持引用的 Host 回写。
        if (!integrationQueue) throw new Error("coordinator integration queue is unavailable");
        if (input.authorization !== "root" || binding.ownerScope.rootSessionId !== input.ownerScope?.rootSessionId) throw new Error("root authorization required for recovery");
        const delivered = integrationQueue.listResumeIntents().find((entry: any) => entry.resumeIntentId === input.resumeIntentId);
        if (!delivered || delivered.ownerScope?.rootSessionId !== binding.ownerScope.rootSessionId) throw new Error("resume intent owner scope denied");
        return integrationQueue.markResumeDelivery(input.resumeIntentId, { state: "delivered", reason: String(input.reason ?? "host handoff delivered").slice(0, 240) });
      }
      case "recovery.activate-resume": {
        if (!integrationQueue || !workspaceService) throw new Error("coordinator integration queue is unavailable");
        if (input.authorization !== "root" || binding.ownerScope.rootSessionId !== input.ownerScope?.rootSessionId) throw new Error("root authorization required for recovery");
        const intent = integrationQueue.listResumeIntents().find((entry: any) => entry.resumeIntentId === input.resumeIntentId);
        if (!intent || intent.ownerScope?.rootSessionId !== binding.ownerScope.rootSessionId) throw new Error("resume intent owner scope denied");
        const activation = parseRecoveryResumeActivationV1({
          version: RECOVERY_RESUME_ACTIVATION_VERSION, resumeIntentId: input.resumeIntentId, queueItemId: intent.queueItemId,
          workspaceId: input.workspaceId, leaseId: input.leaseId, sourceRunId: input.sourceRunId, resumedRun: input.resumedRun,
          ownerScope: input.ownerScope, generation: input.generation, authorization: input.authorization,
        }, intent);
        // durable 序列：intent starting → workspace rebind → queue rebind → intent
        // activated；每阶段幂等，crash 后重放收敛。
        integrationQueue.markResumeStarting(activation.resumeIntentId, activation.resumedRun);
        const workspace = workspaceService.rebindRunForRecovery({
          workspaceId: activation.workspaceId, ownerScope: activation.ownerScope, leaseId: activation.leaseId,
          sourceRunId: activation.sourceRunId, resumedRun: activation.resumedRun, resumeIntentId: activation.resumeIntentId, generation: activation.generation,
        }, { authorizeResumeIntent: (rebindInput: any) => {
          const current = integrationQueue.listResumeIntents().find((entry: any) => entry.resumeIntentId === rebindInput.resumeIntentId);
          if (!current || current.workspaceId !== rebindInput.workspaceId || current.leaseId !== rebindInput.leaseId
            || current.sourceRunId !== rebindInput.sourceRunId || current.generation !== rebindInput.generation) throw new Error("resume intent does not authorize this rebind");
          if (current.state !== "starting" && current.state !== "activated") throw new Error("resume intent is not starting");
        } });
        const queueItem = integrationQueue.rebindChildRunForRecovery({ queueItemId: activation.queueItemId, resumeIntentId: activation.resumeIntentId, sourceRunId: activation.sourceRunId, resumedRunId: activation.resumedRun.runId, generation: activation.generation });
        const resumeIntent = integrationQueue.markResumeActivated(activation.resumeIntentId, activation.resumedRun);
        // activation 成功后永久失效旧 run 的 terminal proof：移出 pending、不可
        // 重入队、不计 debt；重放幂等，伪造不同 resumedRun 拒绝。
        if (proofOutbox) {
          await proofOutbox.supersede({ sourceProofId: intent.sourceProofId, sourceRunId: activation.sourceRunId, resumedRunId: activation.resumedRun.runId, resumeIntentId: activation.resumeIntentId });
        }
        return { resumeIntent, workspace, queueItem };
      }
      case "recovery.discard":
        if (typeof input.actionToken !== "string" || !input.terminalProof) throw new Error("discard recovery requires action token and terminal proof");
        return settleOwnedDisposition(ownedInput, "discard");
      case "recovery.release":
        if (typeof input.actionToken !== "string" || !input.terminalProof) throw new Error("release recovery requires action token and terminal proof");
        return settleOwnedDisposition(ownedInput, "release");
      default: throw new Error("unsupported coordinator operation");
    }
  }
  const server = net.createServer((socket) => { clients.add(socket); let buffer = "";
    // 客户端连接 socket 必须监听 error：对端提前断开（如拉起器 startup.ping
    // 超时自毁后 daemon 才完成恢复并写回响应）会产生 EPIPE/ECONNRESET，未监听
    // 会以未捕获异常击穿整个 daemon。仅记录诊断，注册清理由既有 close 路径接管。
    socket.on("error", (error) => { diagnose({ phase: "coordinator-client-socket-error", code: (error as { code?: string })?.code, message: String((error as Error)?.message ?? error) }); });
    socket.setEncoding("utf8"); socket.on("data", async (chunk) => { buffer += chunk; let index;
      while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue;
        let requestId = "unknown"; let handling = false;
        try {
          const raw = JSON.parse(line); requestId = raw.requestId;
          // 拉起器的 startupReady 握手探测：免认证、无状态泄漏，只报告本实例
          // 是否已完成 startup recovery（未就绪期间普通业务请求仍会被拒）。
          if (raw.method === "startup.ping") {
            socket.write(`${JSON.stringify({ protocol: raw.protocol ?? "repository-workspace-coordinator.v1", requestId, repositoryId: options.repositoryId, ok: true, result: { instanceId, ready: startupReady } })}\n`);
            continue;
          }
          if (raw.method === "broker.register") {
            const registrationRequest = parseCoordinatorRegistrationRequest(raw);
            if (registrationRequest.repositoryId !== options.repositoryId) throw new TypeError("Coordinator repository scope mismatch");
            const nonce = randomBytes(32).toString("hex");
            const proof = await challengeBroker(registrationRequest.brokerRegistry, { nonce, repositoryId: options.repositoryId, coordinatorInstanceId: instanceId });
            const previous = brokerCapabilities.get(proof.rootSessionId);
            if (previous) { registrations.delete(previous); registrationBindings.delete(previous); }
            const capability = randomBytes(32).toString("hex");
            const registration: TrustedBrokerRegistration = Object.freeze({
              capability, role: "root-broker", repositoryId: options.repositoryId, coordinatorInstanceId: instanceId,
              brokerProcessIdentity: proof.brokerProcessIdentity,
              ownerScope: Object.freeze({ kind: "standalone-subagent", rootSessionId: proof.rootSessionId }),
            });
            registrations.set(capability, registration); brokerCapabilities.set(proof.rootSessionId, capability);
            const owned = socketCapabilities.get(socket) ?? new Set<string>(); owned.add(capability); socketCapabilities.set(socket, owned);
            socket.write(`${JSON.stringify({ protocol: raw.protocol, requestId, repositoryId: options.repositoryId, ok: true, result: { capability, instanceId, endpoint: options.endpoint, role: registration.role, storageRepositoryId } })}\n`);
            continue;
          }
          const parsed = parseCoordinatorRequest(raw);
          const registration = registrations.get(parsed.capability);
          if (!registration) throw new TypeError("Coordinator registration capability mismatch");
          const request = authorizeCoordinatorRequest(parsed, registration);
          if (!startupReady && !["workspace.status", "receipt.query", "queue.audit"].includes(request.request.method)) throw Object.assign(new Error("coordinator recovery is not ready"), { code: "COORDINATOR_RECOVERY_NOT_READY" });
          active++; handling = true;
          const result = await handle({ ...request, registration });
          socket.write(`${JSON.stringify({ protocol: raw.protocol, requestId, repositoryId: options.repositoryId, ok: true, result })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ protocol: "repository-workspace-coordinator.v1", requestId, repositoryId: options.repositoryId, ok: false, error: String((error as any)?.message || error), errorInfo: toCoordinatorErrorInfo(error) })}\n`);
        } finally { if (handling) active--; }
      }
    }); socket.on("close", () => {
      clients.delete(socket);
      for (const capability of socketCapabilities.get(socket) ?? []) {
        const registration = registrations.get(capability);
        registrations.delete(capability); registrationBindings.delete(capability);
        if (registration && brokerCapabilities.get(registration.ownerScope.rootSessionId) === capability) brokerCapabilities.delete(registration.ownerScope.rootSessionId);
      }
      socketCapabilities.delete(socket);
    }); });
  async function closeAfterPermissionFailure(error: unknown) {
    let actualMode: number | undefined;
    try { actualMode = (await stat(options.endpoint)).mode & 0o777; } catch (statError) { error = new Error("coordinator socket permission verification failed", { cause: new AggregateError([error, statError], "coordinator socket permission verification failed") }); }
    const permissionError = new Error("coordinator socket chmod failed", { cause: error });
    permissionError.code = "COORDINATOR_SOCKET_PERMISSION_FAILED";
    (permissionError as any).socketPath = options.endpoint;
    (permissionError as any).expectedMode = 0o600;
    (permissionError as any).actualMode = actualMode;
    await new Promise<void>((resolve) => { if (server.listening) server.close(() => resolve()); else resolve(); });
    throw permissionError;
  }
  const listenOnEndpoint = () => new Promise<void>((resolve, reject) => {
    server.once("listening", () => {
      void chmod(options.endpoint, 0o600).then(async () => {
        const actualMode = (await stat(options.endpoint)).mode & 0o777;
        if (actualMode !== 0o600) throw new Error(`coordinator socket mode is ${actualMode.toString(8)}, expected 600`);
        resolve();
      }).catch((error) => { void closeAfterPermissionFailure(error).then(() => undefined, reject); });
    });
    server.once("error", reject);
    server.listen(options.endpoint);
  });
  // listener 生命周期 = 宿主进程生命周期：idle 不再收缩 listener（收缩后
  // 注册仍在名下会造成「owner 活着但聋」的永久缺口），归零退出由 daemon
  // 进程退出承担。retained/active 仅用于统一 idle 快照。
  function beginActivity() { retained++; let released = false; return () => { if (released) return; released = true; retained--; }; }
  async function finishStartupRecovery() {
    startupReady = false;
    // 证明债务重投先于 replay（审计 #7）：durable 事实已补齐的 debt 重分类为
    // pending，与原 pending 在同一轮交付，既有 replay 语义（幂等、失败留 pending）
    // 不变。债务重投自身的失败不得阻断恢复：debt 保持 durable 待下一轮。
    try { await reconcileProofDebts(); }
    catch (error) { diagnose({ version: 1, phase: "coordinator-proof-debt-reconcile-failed", error, cause: (error as any)?.cause }); }
    // Terminal proof is the authority required by destructive workspace settlement.
    // Replay it before any prepared disposition can release the worktree; a proof
    // that remains pending stays in the durable outbox for the next Host.
    await replayTerminalProofs();
    dispositionSettlement?.replay();
    await pumpResumeIntents();
    // 死 daemon 的 admitted claim 回收（#13）先于队列对账：回收后项回到 queued，
    // 参与下面的孤儿解除阻塞与全量对账。
    recoverDeadClaims();
    // durable FIFO 孤儿项对账：released 终态 workspace 遗留的 queued 项直接
    // preserve 解除阻塞，避免无人可认领的历史项永久卡死队列。
    reconcileReleasedOrphanQueueItems();
    // 剩余非终态项的全量对账（#14 接线）：推进或 preserve，结果落诊断。
    reconcileIntegrationsAtStartup();
    startupReady = true;
  }
  // 计划契约：startupReady 供拉起器/宿主等待（Promise 形式），与 isStartupReady 同源。
  // endpoint 绑定完成、startup recovery 尚未开始时调用 onListening：daemon 据此
  // 在「已接管 endpoint」时就发布 durable owner 事实，不在自身存活但未登记的窗口里
  // 留下「本仓无 coordinator」的假事实（审计 #18）。
  let whenStartupReadyPromise: Promise<void> | undefined;
  async function listen() {
    whenStartupReadyPromise = (async () => {
      try {
        await listenOnEndpoint();
        await options.onListening?.();
        await finishStartupRecovery();
      } catch (error: any) {
        if (error?.code !== "EADDRINUSE") throw error;
        // A killed daemon can leave the UNIX socket inode behind. Probe it
        // first so a live coordinator is never displaced.
        const live = await new Promise<boolean>((resolve) => {
          const probe = net.createConnection(options.endpoint);
          probe.once("connect", () => { probe.destroy(); resolve(true); });
          probe.once("error", () => resolve(false));
        });
        if (live) throw error;
        await unlink(options.endpoint).catch(() => undefined);
        await listenOnEndpoint();
        await options.onListening?.();
        await finishStartupRecovery();
      }
    })();
    await whenStartupReadyPromise;
  }
  const internal = workspaceService && integrationQueue ? Object.freeze({ workspaceService, integrationQueue, enqueueIntegration, awaitIntegrationAdmission, publishRebasedCandidate, reportResolvingConflict, abandonIntegration, inspectIntegrationState, prepareAutoIntegration, inspectAutoIntegration, advanceAutoIntegration, preserveIntegrationDebt, reconcileIntegrations }) : undefined;
  // 统一 idle 快照：daemon 的引用计数归零判定依据（连接/在途/保留全零）。
  function idleSnapshot() { return Object.freeze({ clients: clients.size, active, retained }); }
  return { server, clients, instanceId, internal, proofOutbox, proofOutboxDirectory, listen, whenStartupReady: () => { if (!whenStartupReadyPromise) throw new Error("coordinator server has not started listening"); return whenStartupReadyPromise; }, beginActivity, idleSnapshot, isStartupReady: () => startupReady, close: async (closeOptions?: { unlinkEndpoint?: boolean }) => { registrations.clear(); registrationBindings.clear(); brokerCapabilities.clear(); socketCapabilities.clear(); for (const socket of clients) socket.destroy(); if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); // unlinkEndpoint:false 用于「新实例已接管 endpoint」时防止旧进程误删新 socket。
    if (closeOptions?.unlinkEndpoint !== false) await unlink(options.endpoint).catch(() => undefined); } };
}
