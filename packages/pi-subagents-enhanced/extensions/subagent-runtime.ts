import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PlanRunFacts, PlanRunRef } from "../src/execution/index.ts";
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
import { runtimeFromStatus } from "../src/subagent-dispatch/runtime-state.ts";
import { createRenewableTypedSubagentRpcClient, createTypedSubagentRpcClient } from "../src/subagent-dispatch/rpc-client.ts";
import { createCoordinatorProofOutbox } from "../src/subagent-dispatch/coordinator-proof-outbox.ts";
import { classifyTerminalProofBinding } from "../src/subagent-dispatch/terminal-proof-binding.ts";
import { resolveRootSessionId } from "../src/subagent-dispatch/root-broker-protocol.ts";
import { createRunAuthorization } from "../src/subagent-dispatch/run-authorization.ts";
import { parseIntegrationResumeIntentV1 } from "../src/subagent-dispatch/recovery-resume-contract.ts";
import { COORDINATOR_OPERATIONS } from "../src/subagent-dispatch/root-broker-protocol.ts";
import { closeAndUnbindRootBroker, inspectRootBrokerExecutionProof, registerRootBrokerAuthorizedRun, startAndBindRootBroker } from "../src/subagent-dispatch/root-broker-registry.ts";
import { RootBrokerServer, rootBrokerTerminalProofId, type TerminalProofDeliveryOutcome } from "../src/subagent-dispatch/root-broker-server.ts";
import { AuthorityStore } from "../src/subagent-dispatch/authority-store.ts";
import { rootBrokerRegistryEntry } from "../src/subagent-dispatch/root-broker-registry.ts";
import { createTrustedRunBindingResolver } from "../src/subagent-dispatch/run-binding-resolver.ts";
import { connectRepositoryCoordinator } from "../src/workspace/coordinator-client.ts";
import { createCoordinatorRegistry } from "../src/workspace/coordinator-registry.ts";
import { createCoordinatorServer } from "../src/workspace/coordinator-server.ts";
import { createManagedWorkspaceLedger } from "../src/workspace/ledger.ts";
import { resolveRepositoryIdentity } from "../src/workspace/repository-identity.ts";
import { createManagedWorkspaceService } from "../src/workspace/service.ts";
import { createCoordinatorDispositionFacade } from "../src/workspace/disposition-facade.ts";
import { createWorkspaceCompletionReminder } from "../src/workspace/completion-reminder.ts";
import { bindManagedWorkspaceServiceSession, unbindManagedWorkspaceServiceSession } from "../src/workspace/registry.ts";

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

/** 连接只持有仓库资源；独立单仓库调用方可保留既有 broker 接线。 */
export async function connectRuntimeCoordinator({ pi, cwd, broker, stateRoot, rpc, diagnosticSink, bindBrokerCallbacks = true }: { pi: object; cwd: string; broker: RootBrokerServer; stateRoot?: string; rpc?: any; diagnosticSink?: (entry: unknown) => void; bindBrokerCallbacks?: boolean }) {
  if (!shouldStartRepositoryCoordinator(cwd) || typeof stateRoot !== "string" || stateRoot.length === 0) return undefined;
  const identity = await resolveRepositoryIdentity(cwd);
  const registry = createCoordinatorRegistry({ commonDir: identity.commonDir, stateRoot });
  const metadata = await registry.claim({ repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId });
  let server: any;
  const ownsServer = metadata.pid === process.pid;
  if (ownsServer) {
    try {
      server = createCoordinatorServer({
        endpoint: metadata.endpoint,
        repositoryId: metadata.repositoryId,
        storageRepositoryId: metadata.storageRepositoryId,
        instanceId: metadata.instanceId,
        stateRoot: metadata.canonicalStateRoot,
        diagnosticSink,
        recoveryEventSink: async (intent: any) => {
          // resume intent 的快路径：本 Host 的 orchestrator 直接消费（仅限本
          // root 拥有的 intent，submit 内部校验 owner scope）；跨 Host 投递由
          // durable recovery.status 轮询通道负责。legacy preserve 事件仍走
          // broker push。coordinator 的 durable 状态仍是唯一权威。
          if (intent?.requiredAction === "resume-child") {
            const handoff = intent.handoff;
            if (!handoff || handoff.customType !== "subagent-integration-handoff") {
              diagnosticSink?.({ version: 1, phase: "recovery-handoff-invalid", resumeIntentId: intent?.resumeIntentId, sourceRunId: intent?.sourceRunId });
              return { state: "debt", reason: "manual handoff notification is invalid" };
            }
            try {
              await (pi as any).sendMessage(handoff, { deliverAs: "followUp", triggerTurn: true });
              return { state: "delivered" };
            } catch (error) {
              diagnosticSink?.({ version: 1, phase: "recovery-handoff-delivery-failed", error, cause: error?.cause, resumeIntentId: intent?.resumeIntentId, sourceRunId: intent?.sourceRunId });
              return { state: "debt", reason: "manual handoff notification failed" };
            } finally {
              // coordinator 尚需落盘 delivery；proof delivery 完成后还会再发最终失效提示。
              broker.notifyExecutionFacts(intent.sourceRunId);
            }
          }
          return broker.publishRecoveryEvent(intent);
        },
      });
      await server.listen();
    } catch (error) {
      try {
        // listen 失败可能是已有活 socket；只清理本连接实际监听的 server。
        if (server?.server.listening) await server.close();
        await registry.release();
      } catch (cleanupError) {
        try { diagnosticSink?.({ version: 1, phase: "coordinator-start-cleanup-failed", error, cause: error?.cause, secondaryError: cleanupError }); } catch (diagnosticError) { console.error("[subagent-runtime] recovery diagnostic sink failed", diagnosticError); }
        throw new AggregateError([error, cleanupError], "coordinator startup and cleanup failed", { cause: error });
      }
      throw error;
    }
  }
  let client: Awaited<ReturnType<typeof connectRepositoryCoordinator>> | undefined;
  try {
    client = await connectRepositoryCoordinator(identity, await rootBrokerRegistryEntry(pi, broker.rootSessionId), { metadata });
    const proofOwnerScope = Object.freeze({ kind: "standalone-subagent" as const, rootSessionId: broker.rootSessionId });
    // One durable proof outbox shared with the coordinator daemon; the broker
    // writes pending/debt entries when the daemon cannot settle them.
    const proofOutbox = createCoordinatorProofOutbox(path.join(metadata.canonicalStateRoot, "repositories", identity.storageRepositoryId, "terminal-proof-outbox"));
    const operationMethods = Object.freeze({
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
    });
    const bindingResolver = createTrustedRunBindingResolver(client, { rootSessionId: broker.rootSessionId });
    let closing = false;
    const coordinatorRequest: NonNullable<RootBrokerServer["coordinatorRequest"]> = async (runId, operation, input) => {
      if (closing) throw new Error("repository connection is closing");
      if (!COORDINATOR_OPERATIONS.includes(operation as any)) throw new Error("unsupported coordinator operation");
      const binding = await bindingResolver.resolve(runId);
      const method = operationMethods[operation as keyof typeof operationMethods];
      return method({ ...input, ...binding });
    };
    const recordTerminalProof: NonNullable<RootBrokerServer["recordTerminalProof"]> = async (run, proof): Promise<TerminalProofDeliveryOutcome> => {
      if (closing) throw new Error("repository connection is closing");
      const proofId = rootBrokerTerminalProofId(proof);
      const outcome = await classifyTerminalProofBinding({
        client,
        proofOutbox,
        readLedger: () => createManagedWorkspaceLedger({ stateRoot: metadata.canonicalStateRoot })
          .listScoped({ owner: proofOwnerScope }).filter((record: any) => record.run?.runId === run.runId),
        // 跨 owner scope 复查：scoped 查询为空时区分「run 真没有 workspace」与
        // 「workspace 挂在别的 owner scope 下」（后者记债暴露，不静默）。
        readCrossScope: () => createManagedWorkspaceLedger({ stateRoot: metadata.canonicalStateRoot })
          .list().filter((record: any) => record.run?.runId === run.runId),
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
    return Object.freeze({ client, server, registry, ownsServer, identity, coordinatorRequest, recordTerminalProof, async close() {
      closing = true;
      await client.close();
      if (ownsServer) {
        await server.close();
        await registry.release();
      }
      bindingResolver.dispose();
      if (bindBrokerCallbacks) {
        if (broker.recordTerminalProof === recordTerminalProof) broker.recordTerminalProof = undefined;
        if (broker.coordinatorRequest === coordinatorRequest) broker.coordinatorRequest = undefined;
      }
      createSubagentDispatchTrace(broker.rootSessionId, diagnosticSink)("repository-closed", { repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId });
    } });
  } catch (error) {
    const errors: unknown[] = [error];
    try { await client?.close(); } catch (cleanupError) { errors.push(cleanupError); }
    if (ownsServer) {
      try { await server.close(); } catch (cleanupError) { errors.push(cleanupError); }
      try { await registry.release(); } catch (cleanupError) { errors.push(cleanupError); }
    }
    if (errors.length > 1) throw new AggregateError(errors, "coordinator connection and cleanup failed", { cause: error });
    throw error;
  }
}

export function createRootBrokerUpstream({ rpc }: { rpc: any }) {
  return Object.freeze({
    ping: (...args: any[]) => rpc.ping(...args),
    stop: (...args: any[]) => rpc.stop(...args),
    dispose: (...args: any[]) => rpc.dispose(...args),
  });
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
  // 唯一同 owner 的本地持久回执是已有 workspace/run 的唯一选路来源。
  const ownedReceipts = (runId?: string) => {
    if (!broker || !workspaceService || repositoriesClosing) throw repositoryError();
    return workspaceService.listOwned({ ownerScope: { kind: "standalone-subagent", rootSessionId: broker.rootSessionId }, ...(runId === undefined ? {} : { runId }) });
  };
  const selectReceipt = async (runId?: string, workspaceId?: string) => {
    const entries = ownedReceipts(runId).filter((entry: any) => runId !== undefined || entry.workspaceId === workspaceId);
    if (entries.length !== 1 || (workspaceId !== undefined && entries[0].workspaceId !== workspaceId)) throw repositoryError();
    const record = entries[0];
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
      coordinatorClient: fixedContext.client, resolveTerminalProof });
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
        return (await selectReceipt(entry.run?.runId, entry.workspaceId)).context.client;
      },
      resolveTerminalProof,
    });
  };
  let workspaceRootSessionId: string | undefined;
  let workspaceLifecycleSessionId: string | undefined;
  let childToolCeilingRegistration: { dispose(): void } | undefined;
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
    readRuntime: async (runId) => {
      if (!brokerReady) return undefined;
      try {
        const status: any = await rpc.status({ id: runId });
        const owner = broker ? await broker.readOwnerReceipt(runId) : undefined;
        const runtime = runtimeFromStatus(runId, status);
        return { ...runtime, ...(owner?.ownerGeneration !== undefined ? { ownerGeneration: owner.ownerGeneration } : {}) };
      } catch (error) {
        if (process.env.T11B1_DEBUG === "1") console.error(`[t11b1-debug] runtime-read error=${error instanceof Error ? error.message : String(error)} runId=${runId}`);
        return undefined;
      }
    },
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
      throw Object.assign(new Error("managed resume source binding is unavailable"), { code: "RESUME_BINDING_BLOCKED" });
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
        getContext() {
          return workspaceService && workspaceRootSessionId && workspaceLifecycleSessionId
            ? { service: workspaceService, rootSessionId: workspaceRootSessionId, lifecycleSessionId: workspaceLifecycleSessionId }
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
      childToolCeilingRegistration = registerConfiguredChildToolCeiling({
        agentDir: process.env.PI_CODING_AGENT_DIR ?? "",
        sessionId: lifecycleSessionId,
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
            const crossScope = createManagedWorkspaceLedger({ stateRoot }).list().filter((record: any) => record.run?.runId === run.runId);
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
          const coordinator = coordinatorRuntime.client;
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
            if (!candidate || candidate.delivery.state !== "pending" || candidate.state === "preserved"
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
        } catch {
          // 保留已核实的 terminal/workspace 字段；读取失败不降级为可重派或已完成。
          facts.recovery = "unknown";
          facts.wakeup = "unavailable";
          facts.blocker = "PLAN_EXECUTION_FACTS_UNAVAILABLE";
          return facts;
        }
      },
    },
    managedCodingResume: {
      events: pi.events,
      async prepare({ sourceRunId, ownerState, owner }: any) {
        if (!brokerReady || !broker || !workspaceService) {
          if (ownerState === "owned") throw Object.assign(new Error("managed resume coordinator identity is unavailable"), { code: "RESUME_BINDING_BLOCKED" });
          return undefined;
        }
        if (ownedReceipts(sourceRunId).length === 0) {
          if (singleRepositoryHost) return undefined;
          const crossScope = createManagedWorkspaceLedger({ stateRoot: process.env.PI_CODING_WORKSPACE_DIR }).list().filter((record: any) => record.run?.runId === sourceRunId);
          if (crossScope.length > 0) throw repositoryError();
          return undefined;
        }
        const { record: selected, context: coordinatorRuntime } = await selectReceipt(sourceRunId);
        const owned = await coordinatorRuntime.client.listOwned({ runId: sourceRunId });
        if (!Array.isArray(owned)) throw Object.assign(new Error("managed resume workspace ownership is unavailable"), { code: "RESUME_BINDING_BLOCKED" });
        if (owned.length === 0) return undefined;
        if (owned.length !== 1) throw Object.assign(new Error("managed resume requires exactly one owned workspace"), { code: "RESUME_BINDING_BLOCKED" });
        if (ownerState !== "owned" || !owner || owner.runId !== sourceRunId || owner.rootSessionId !== broker.rootSessionId) {
          throw Object.assign(new Error("managed resume owner identity is unavailable"), { code: "RESUME_BINDING_BLOCKED" });
        }
        const record = owned[0];
        if (record.workspaceId !== selected.workspaceId || record.leaseId !== selected.leaseId || record.originRoot !== selected.originRoot
            || record?.owner?.kind !== "standalone-subagent" || record.owner.rootSessionId !== broker.rootSessionId
            || record?.run?.runId !== sourceRunId || !Number.isSafeInteger(owner.ownerGeneration) || owner.ownerGeneration <= 0) {
          throw Object.assign(new Error("managed resume owner binding is invalid"), { code: "RESUME_BINDING_BLOCKED" });
        }
        const expectedAgent = managedCodingBinding(record, owner, broker).binding.agentProfile;
        const intents = await coordinatorRuntime.client.recoveryStatus();
        const matches = Array.isArray(intents)
          ? intents.filter((entry: any) => entry?.version === "integration-resume-intent.v1" && entry.sourceRunId === sourceRunId)
          : [];
        if (matches.length !== 1) throw Object.assign(new Error("managed resume intent is unavailable or ambiguous"), { code: "RESUME_BINDING_BLOCKED" });
        const intent = parseIntegrationResumeIntentV1(matches[0], { rootSessionId: broker.rootSessionId });
        if (intent.workspaceId !== record.workspaceId || intent.leaseId !== record.leaseId || intent.state !== "pending" || intent.resumedRun !== null) {
          throw Object.assign(new Error("managed resume intent is not activatable"), { code: "RESUME_BINDING_BLOCKED" });
        }
        return Object.freeze({ intent, expectedAgent, expectedSessionId: broker.lifecycleSessionId });
      },
      async register(binding: any) {
        if (!brokerReady || !broker) throw Object.assign(new Error("Root Broker is unavailable for managed resume"), { code: "RESUME_BINDING_BLOCKED" });
        const authorization = createRunAuthorization({ kind: "coding", binding, goal: null });
        await registerRootBrokerAuthorizedRun(pi, authorization, broker.rootSessionId);
      },
      async activate({ plan, resumedRun }: any) {
        if (!brokerReady || !broker) throw Object.assign(new Error("managed resume coordinator is unavailable"), { code: "RESUME_BINDING_BLOCKED" });
        const intent = plan.intent;
        const { context: coordinatorRuntime } = await selectReceipt(intent.sourceRunId, intent.workspaceId);
        return coordinatorRuntime.client.activateResume({
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
