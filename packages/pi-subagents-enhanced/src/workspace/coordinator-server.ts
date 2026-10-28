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
import { createIntegrationQueue } from "./integration-queue.ts";
import { auditManagedWorkspaces } from "./administration.ts";
import { toCoordinatorErrorInfo } from "./coordinator-errors.ts";
import { createWorkspaceDispositionSettlement } from "./disposition-settlement.ts";

type CoordinatorFault = (event: { operation: string; phase: string; queueItemId?: string; workspaceId?: string }) => void;
type CoordinatorDiagnostic = (entry: unknown) => void;

const RESUMABLE_PROOF_QUEUE_STATES = ["queued", "admitted", "resolving-conflict", "prepared"];

export function createCoordinatorServer(options: { endpoint: string; repositoryId: string; storageRepositoryId?: string; stateRoot?: string; capability?: string; instanceId?: string; idleGraceMs?: number; handler?: (request: any) => unknown; challengeBroker?: typeof challengeRootBroker; recoveryEventSink?: (event: any) => Promise<any> | any; fault?: CoordinatorFault; diagnosticSink?: CoordinatorDiagnostic; admissionProbe?: () => void }) {
  const diagnose = (entry: unknown) => { try { options.diagnosticSink?.(entry); } catch (diagnosticError) { console.error("[coordinator-server] diagnostic sink failed", { entry, diagnosticError }); } };
  const instanceId = options.instanceId ?? randomUUID();
  const challengeBroker = options.challengeBroker ?? challengeRootBroker;
  const registrations = new Map<string, TrustedBrokerRegistration>();
  const registrationBindings = new Map<string, any>();
  const brokerCapabilities = new Map<string, string>();
  const socketCapabilities = new Map<net.Socket, Set<string>>();
  const clients = new Set<net.Socket>(); let active = 0; let retained = 0; let timer: NodeJS.Timeout | undefined;
  let startupReady = false;
  // The durable queue, ledger records and proof outbox must share the ledger's
  // canonical partition; a symlinked alias would otherwise split the bucket.
  const declaredStateRoot = options.stateRoot ?? process.env.PI_CODING_WORKSPACE_DIR;
  const stateRoot = declaredStateRoot ? canonicalWorkspaceStateRoot(declaredStateRoot) : undefined;
  const storageRepositoryId = options.storageRepositoryId ?? options.repositoryId;
  const workspaceService = stateRoot
    ? createManagedWorkspaceService({ stateRoot, storageRepositoryId, fault: event => options.fault?.({ ...event }), admissionProbe: options.admissionProbe })
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
    const entry = workspaceService.listOwned({ ownerScope: input.ownerScope }).find(candidate => candidate.workspaceId === input.workspaceId);
    if (!entry) throw Object.assign(new Error("workspace does not belong to this owner"), { code: "MANAGED_WORKSPACE_OWNER_SCOPE" });
    const binding = { workspaceId: entry.workspaceId, leaseId: entry.leaseId, runId: entry.run?.runId ?? null, ownerScope: input.ownerScope };
    const queueItem = integrationQueue.findByBinding(binding);
    const prepared = workspaceService.prepareOwnedDisposition({ ...input, operation }, { settlementId: randomUUID(), queueItem });
    const result = dispositionSettlement.settlePrepared(prepared);
    void pumpResumeIntents().catch(error => diagnose({ version: 1, phase: "coordinator-settlement-pump-failed", error, cause: error?.cause }));
    return result;
  }

  function trustedWorkspace(binding: any) {
    if (!workspaceService) throw new Error("coordinator workspace service is unavailable");
    const owned = workspaceService.listOwned({ ownerScope: binding.ownerScope });
    const entry = Array.isArray(owned) ? owned.find((candidate: any) => candidate.workspaceId === binding.workspaceId) : undefined;
    if (!entry || entry.run?.runId !== binding.runId) throw new Error("trusted run binding is unavailable");
    if (entry.leaseId !== binding.leaseId) throw new Error("trusted workspace lease mismatch");
    return entry;
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
      });
      return { ...inspectAutoIntegration(binding), conflictDigest, continuationAttempt: conflict.continuationAttempt, noProgress: conflict.noProgress };
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

  function reconcileIntegrations() {
    if (!integrationQueue || !workspaceService) return [];
    const results = [];
    for (const item of integrationQueue.listQueue()) {
      if (!["queued", "admitted", "rebasing", "resolving-conflict", "prepared"].includes(item.state)) continue;
      const binding = { workspaceId: item.workspaceId, leaseId: item.leaseId, ownerScope: item.ownerScope, runId: item.childRunId };
      try {
        results.push(item.state === "prepared"
          ? publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: item.queueLeaseId, candidateHead: item.candidateHead }, binding)
          : advanceAutoIntegration({}, binding));
      }
      catch (error) {
        try { preserveIntegrationDebt(binding, "coordinator-reconcile-rejected"); } catch (secondaryError) { diagnose({ version: 1, phase: "coordinator-reconcile-preserve-failed", error, cause: error?.cause, secondaryError, secondaryCause: secondaryError?.cause, queueItemId: item.queueItemId }); }
        results.push({ queueItemId: item.queueItemId, state: "preserved", error: String((error as any)?.message ?? error) });
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
      if (prepared.phase !== "settled" || prepared.proofHash !== terminalProof.proofId
          || prepared.binding.runId !== terminalProof.runId || prepared.binding.asyncDir !== terminalProof.asyncDir
          || prepared.queueReceiptRef !== item.dispositionReceiptRef) throw new Error("terminal proof does not match settled disposition receipt");
      integrationQueue!.verifyDispositionBinding(prepared);
      const receipt = workspaceService!.markDispositionSettled({ workspaceId, ownerScope: proofOwnerScope, settlementId: prepared.settlementId, queueReceiptRef: prepared.queueReceiptRef });
      return { accepted: true, proofId: terminalProof.proofId, receipt };
    }
    if (item && item.state !== "completed") {
      if (item.childRunId !== terminalProof.runId || item.ownerScope?.rootSessionId !== proofOwnerScope?.rootSessionId) {
        throw new Error("terminal proof does not match trusted child binding");
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
      if (item.state !== "completed") throw new Error("terminal proof delivery remains pending until the child integration completes");
    }
    if (!item) throw new Error("terminal proof requires a completed child integration");
    if (item.childRunId !== terminalProof.runId || item.ownerScope?.rootSessionId !== proofOwnerScope?.rootSessionId) {
      throw new Error("terminal proof does not match trusted child binding");
    }
    // Replay after a crash between discard and receipt persistence must stay
    // idempotent; a released workspace already settled this proof.
    const released = workspaceService!.listOwned({ ownerScope: proofOwnerScope }).find((entry: any) => entry.workspaceId === workspaceId);
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
      return { ...audit, recoveryIntents: integrationQueue?.listRecoveryIntents() ?? [], notificationDeliveryDebt: integrationQueue?.notificationDeliveryDebt() ?? [] };
    }
    if (request.request.method === "record_terminal_proof" && workspaceService && integrationQueue && proofOutbox) {
      const params = request.request.params ?? {};
      const ownerScope = request.ownerScope;
      const existing = await proofOutbox.receipt(params.proof?.proofId);
      if (existing !== undefined) return existing;
      await proofOutbox.enqueue({ ...structuredClone(params.proof), workspaceId: params.workspaceId, ownerScope: structuredClone(ownerScope) });
      await replayTerminalProofs();
      const delivered = await proofOutbox.receipt(params.proof.proofId);
      if (delivered === undefined) throw new Error("terminal proof delivery remains pending");
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
      const entry = workspaceService?.listOwned({ ownerScope }).find((candidate: any) => candidate.workspaceId === input.workspaceId);
      if (!entry) throw Object.assign(new Error("workspace does not belong to this owner"), { code: "MANAGED_WORKSPACE_OWNER_SCOPE" });
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
        const owned = workspaceService.listOwned({ ownerScope }).some((item: any) => item.workspaceId === input.workspaceId);
        if (!owned) throw new Error("workspace does not belong to the current standalone session");
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
    socket.setEncoding("utf8"); socket.on("data", async (chunk) => { buffer += chunk; let index;
      while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue;
        let requestId = "unknown"; let handling = false;
        try {
          const raw = JSON.parse(line); requestId = raw.requestId;
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
      socketCapabilities.delete(socket); schedule();
    }); });
  function schedule() { if (clients.size || active || retained || timer) return; timer = setTimeout(() => { if (!clients.size && !active && !retained) server.close(); timer = undefined; }, options.idleGraceMs ?? 30_000); timer.unref(); }
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
        schedule(); resolve();
      }).catch((error) => { void closeAfterPermissionFailure(error).then(() => undefined, reject); });
    });
    server.once("error", reject);
    server.listen(options.endpoint);
  });
  function beginActivity() { retained++; if (timer) { clearTimeout(timer); timer = undefined; } let released = false; return () => { if (released) return; released = true; retained--; schedule(); }; }
  async function finishStartupRecovery() {
    startupReady = false;
    // Terminal proof is the authority required by destructive workspace settlement.
    // Replay it before any prepared disposition can release the worktree; a proof
    // that remains pending stays in the durable outbox for the next Host.
    await replayTerminalProofs();
    dispositionSettlement?.replay();
    await pumpResumeIntents();
    startupReady = true;
  }
  async function listen() {
    try {
      await listenOnEndpoint();
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
      await finishStartupRecovery();
    }
  }
  const internal = workspaceService && integrationQueue ? Object.freeze({ workspaceService, integrationQueue, enqueueIntegration, awaitIntegrationAdmission, publishRebasedCandidate, reportResolvingConflict, abandonIntegration, inspectIntegrationState, prepareAutoIntegration, inspectAutoIntegration, advanceAutoIntegration, preserveIntegrationDebt, reconcileIntegrations }) : undefined;
  return { server, clients, instanceId, internal, proofOutbox, proofOutboxDirectory, listen, beginActivity, close: async () => { if (timer) clearTimeout(timer); timer = undefined; registrations.clear(); registrationBindings.clear(); brokerCapabilities.clear(); socketCapabilities.clear(); for (const socket of clients) socket.destroy(); if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); await unlink(options.endpoint).catch(() => undefined); } };
}
