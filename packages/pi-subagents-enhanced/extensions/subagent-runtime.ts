import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
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
import { createSubagentDispatchTraceFileSink, installHeadlessTypedSubagentRuntime } from "../src/subagent-dispatch/extension.ts";
import { captureSupervisorCorrelation, reconcileSupervisorConsumption } from "../src/subagent-dispatch/supervisor-consumption.ts";
import { registerConfiguredChildToolCeiling } from "../src/subagent-dispatch/child-tool-policy.ts";
import { createSupervisorControlPlane, supervisorCanonicalDigest } from "../src/subagent-dispatch/supervisor-control-plane.ts";
import { runtimeFromStatus } from "../src/subagent-dispatch/runtime-state.ts";
import { createRenewableTypedSubagentRpcClient, createTypedSubagentRpcClient } from "../src/subagent-dispatch/rpc-client.ts";
import { createCoordinatorProofOutbox } from "../src/subagent-dispatch/coordinator-proof-outbox.ts";
import { classifyTerminalProofBinding } from "../src/subagent-dispatch/terminal-proof-binding.ts";
import { resolveRootSessionId } from "../src/subagent-dispatch/root-broker-protocol.ts";
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
import { createWorkspaceCompletionReminder } from "../src/workspace/completion-reminder.ts";
import { bindManagedWorkspaceServiceSession, unbindManagedWorkspaceServiceSession } from "../src/workspace/registry.ts";

export function shouldStartRepositoryCoordinator(cwd: string): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return false;
  }
}

/** Connect the Host to the common-dir singleton after the Root Broker exists. */
export async function connectRuntimeCoordinator({ pi, cwd, broker, stateRoot, rpc, diagnosticSink }: { pi: object; cwd: string; broker: RootBrokerServer; stateRoot?: string; rpc?: any; diagnosticSink?: (entry: unknown) => void }) {
  if (!shouldStartRepositoryCoordinator(cwd) || typeof stateRoot !== "string" || stateRoot.length === 0) return undefined;
  const identity = await resolveRepositoryIdentity(cwd);
  const registry = createCoordinatorRegistry({ commonDir: identity.commonDir, stateRoot });
  const metadata = await registry.claim({ repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId });
  let server: any;
  const ownsServer = metadata.pid === process.pid;
  if (ownsServer) {
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
          }
        }
        return broker.publishRecoveryEvent(intent);
      },
    });
    try { await server.listen(); } catch (error) {
      try { await registry.release(); } catch (cleanupError) {
        try { diagnosticSink?.({ version: 1, phase: "coordinator-start-cleanup-failed", error, cause: error?.cause, secondaryError: cleanupError }); } catch (diagnosticError) { console.error("[subagent-runtime] recovery diagnostic sink failed", diagnosticError); }
        throw new AggregateError([error, cleanupError], "coordinator startup and cleanup failed", { cause: error });
      }
      throw error;
    }
  }
  try {
    const client = await connectRepositoryCoordinator(identity, await rootBrokerRegistryEntry(pi, broker.rootSessionId), { metadata });
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
    broker.coordinatorRequest = async (runId, operation, input) => {
      if (!COORDINATOR_OPERATIONS.includes(operation as any)) throw new Error("unsupported coordinator operation");
      const binding = await bindingResolver.resolve(runId);
      const method = operationMethods[operation as keyof typeof operationMethods];
      return method({ ...input, ...binding });
    };
    broker.recordTerminalProof = async (run, proof): Promise<TerminalProofDeliveryOutcome> => {
      const proofId = rootBrokerTerminalProofId(proof);
      return classifyTerminalProofBinding({
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
    };
    // 已结束 child 不再自动 resume；recovery.status 仍由 coordinator 保留，
    // 由主 Agent 接管 worktree 并完成 merge queue 收尾。普通控制面 resume 不受影响。
    return Object.freeze({ client, server, registry, ownsServer, identity, async close() {
      await client.close();
      if (ownsServer) {
        await server.close();
        await registry.release();
      }
      bindingResolver.dispose();
      broker.recordTerminalProof = undefined;
      broker.coordinatorRequest = undefined;
    } });
  } catch (error) {
    if (ownsServer) { await server.close().catch(() => undefined); await registry.release().catch(() => undefined); }
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
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1") return;
  // 0.71 config is write-only at the public boundary (contract §4, types.d.ts:2592-2600).
  // Provider policy is owned by this package; do not read upstream private config.
  const providerBlacklist = ["deepseek"];
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
  const rpc = createRenewableTypedSubagentRpcClient(() => createTypedSubagentRpcClient(pi.events));
  let diagnosticSink: (((entry: unknown) => void) & { dispose?: () => void }) | undefined;
  try {
    diagnosticSink = createSubagentDispatchTraceFileSink();
  } catch {
    // 无效的显式诊断文件不能影响生产派发。
  }
  let broker: RootBrokerServer | undefined;
  let coordinatorRuntime: Awaited<ReturnType<typeof connectRuntimeCoordinator>>;
  let workspaceService: any;
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
    providerBlacklist,
    diagnosticSink,
    workingStateTrace: diagnosticSink,
    requiredSharedChildExtension: agentsSharedChildExtension,
    extraDisposables: [
      { dispose() { unsubscribeConsumption(); } },
      ...(diagnosticSink ? [diagnosticSink] : []),
      completionNotices,
      { dispose() { builtinAdmission?.dispose(); builtinAdmission = undefined; } },
    ],
    bootstrap: upstreamSubagentRuntime,
    afterBootstrap: registerBuiltinAgents,
    async discoverAgents(...args: [string, string, string?]) {
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
        coordinatorRuntime = await connectRuntimeCoordinator({
          pi,
          cwd: (ctx.sessionManager as { getCwd(): string }).getCwd(),
          broker: startingBroker,
          stateRoot: process.env.PI_CODING_WORKSPACE_DIR,
          rpc,
          diagnosticSink,
        });
        workspaceRootSessionId = rootSessionId;
        workspaceLifecycleSessionId = lifecycleSessionId;
        workspaceService = createManagedWorkspaceService({
          stateRoot: process.env.PI_CODING_WORKSPACE_DIR,
          storageRepositoryId: coordinatorRuntime?.identity.storageRepositoryId,
          diagnosticSink,
          terminalProofProvider({ run }: { run: { runId?: string } | null }) {
            const snapshot = run?.runId ? startingBroker.inspectExecutionProof(run.runId) : null;
            return projectManagedWorkspaceTerminalProof(run, snapshot);
          },
        });
        bindManagedWorkspaceServiceSession(pi, rootSessionId, workspaceService);
        process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = "1";
        brokerReady = true;
      } catch (error) {
        if (workspaceService && workspaceRootSessionId) {
          unbindManagedWorkspaceServiceSession(pi, workspaceRootSessionId, workspaceService);
          workspaceService = undefined;
          workspaceRootSessionId = undefined;
          workspaceLifecycleSessionId = undefined;
        }
        childToolCeilingRegistration?.dispose();
        childToolCeilingRegistration = undefined;
        if (brokerStarted) {
          await coordinatorRuntime?.close().catch(() => undefined);
          coordinatorRuntime = undefined;
          await closeAndUnbindRootBroker(pi, startingBroker);
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
      try { await coordinatorRuntime?.close(); } catch (error) {
        cleanupErrors.push(error);
        try { diagnosticSink?.({ version: 1, phase: "coordinator-close-failed", error, cause: error?.cause }); } catch (diagnosticError) { console.error("[subagent-runtime] cleanup diagnostic sink failed", diagnosticError); }
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "subagent runtime cleanup failed", { cause: cleanupErrors[0] });
      coordinatorRuntime = undefined;
      if (workspaceService && workspaceRootSessionId) {
        unbindManagedWorkspaceServiceSession(pi, workspaceRootSessionId, workspaceService);
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
