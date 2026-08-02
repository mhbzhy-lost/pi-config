import { createTypedSubagentExtension } from "../../scripts/lib/subagent-dispatch/extension.ts";
import { createRootBrokerClient } from "../../scripts/lib/subagent-dispatch/root-broker-client.ts";
import { createSupervisorTool } from "../../scripts/lib/subagent-dispatch/supervisor-adapter.ts";
import { materializeChildRuntimeEntry } from "../../scripts/lib/subagent-dispatch/child-runtime-entry.ts";

const prepareRootOwnerEntry = async (ir: { agent: string; execution: { cwd?: string } }) => {
  if (ir.agent !== "executor") return;
  await materializeChildRuntimeEntry({
    cwd: ir.execution.cwd!,
    fileName: "root-session-owner-entry.mjs",
    targetUrl: new URL("./root-session-owner.ts", import.meta.url),
  });
};

export function installRootOwnedSubagent(pi: any, { rootSessionId = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID, callerRunId = process.env.PI_SUBAGENT_RUN_ID, createClient = createRootBrokerClient, lifecycleDedupeLimit = 1024, prepareCodingSpawn = prepareRootOwnerEntry, resolveCodingSpawnIdentity, recordSupervisorRequest } = {}) {
  if (!Number.isSafeInteger(lifecycleDedupeLimit) || lifecycleDedupeLimit <= 0) throw new Error("Lifecycle dedupe limit must be a positive safe integer");
  if (recordSupervisorRequest !== undefined && typeof recordSupervisorRequest !== "function") throw new Error("Supervisor request recorder must be a function");
  if (!rootSessionId || !callerRunId) throw new Error("Root-owned subagent requires PI_SUBAGENT_RUN_ID and PI_SUBAGENT_ORCHESTRATOR_SESSION_ID");
  const rpc = createClient({ rootSessionId, callerRunId });
  let disposed = false;
  let subscription: any;
  let subscribing: Promise<void> | undefined;
  const lifecycleDedupe = new Set<string>();
  const supervisorRequestIds = new Set<string>();
  const pendingSupervisorRequests: Array<{ message: any; executorRunId: string; recorded: boolean }> = [];
  let drainingSupervisorRequests: Promise<void> | undefined;
  let compensatedDrainSource: Promise<void> | undefined;
  let compensatedSupervisorDrain: Promise<void> | undefined;
  let supervisorContext: unknown;
  let hasSupervisorContext = false;

  const drainSupervisorPass = async (ctx: unknown) => {
    const blockedExecutors = new Set<string>();
    let firstError: unknown;
    for (const item of [...pendingSupervisorRequests]) {
      if (blockedExecutors.has(item.executorRunId) || !pendingSupervisorRequests.includes(item)) continue;
      try {
        if (!item.recorded) {
          await recordSupervisorRequest(item.message, { ctx });
          item.recorded = true;
        }
        await rpc.supervisorAcknowledge(item.message.details.id);
        const index = pendingSupervisorRequests.indexOf(item);
        if (index >= 0) pendingSupervisorRequests.splice(index, 1);
      } catch (error) {
        blockedExecutors.add(item.executorRunId);
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  };

  const drainSupervisorRequests = async (ctx: unknown, allowCompensation = true): Promise<void> => {
    if (!recordSupervisorRequest || pendingSupervisorRequests.length === 0) return;
    const active = drainingSupervisorRequests;
    if (active) {
      try {
        await active;
        if (pendingSupervisorRequests.length > 0) await drainSupervisorRequests(ctx);
        return;
      } catch (error) {
        if (pendingSupervisorRequests.length > 0 && allowCompensation) {
          if (compensatedDrainSource !== active) {
            compensatedDrainSource = active;
            compensatedSupervisorDrain = drainSupervisorRequests(ctx, false);
          }
          return await compensatedSupervisorDrain;
        }
        throw error;
      }
    }
    let tracked: Promise<void>;
    tracked = drainSupervisorPass(ctx).finally(() => {
      if (drainingSupervisorRequests === tracked) drainingSupervisorRequests = undefined;
    });
    drainingSupervisorRequests = tracked;
    await tracked;
    if (pendingSupervisorRequests.length > 0) await drainSupervisorRequests(ctx);
  };

  const onPush = (push: any) => {
    if (disposed) return;
    if (push?.type === "supervisor.request") {
      const data = push.data;
      const requestId = data?.requestId;
      if (supervisorRequestIds.has(requestId)) return;
      supervisorRequestIds.add(requestId);
      const message = { customType: "subagent_supervisor_request", content: data.content, display: true, details: { id: data.requestId, reason: data.reason, expectsReply: data.expectsReply, runId: data.executorRunId, agent: data.agent, childIndex: data.childIndex } };
      if (recordSupervisorRequest) {
        pendingSupervisorRequests.push({ message, executorRunId: data.executorRunId, recorded: false });
        if (hasSupervisorContext) void drainSupervisorRequests(supervisorContext).catch(() => undefined);
      } else pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      return;
    }
    if (!push || (push.type !== "execution.started" && push.type !== "execution.completed")) return;
    const data = push.data;
    const key = `${push.type}\u0000${data?.dispatchId}\u0000${data?.runId}\u0000${data?.state}`;
    if (lifecycleDedupe.has(key)) return;
    lifecycleDedupe.add(key);
    if (lifecycleDedupe.size > lifecycleDedupeLimit) lifecycleDedupe.delete(lifecycleDedupe.values().next().value!);
    pi.events.emit(push.type === "execution.started" ? "subagent:async-started" : "subagent:async-complete", data);
    pi.sendMessage({ customType: "pi-root-subagent-lifecycle-v1", content: "A lifecycle update arrived. Call plan_status.", details: { dispatchId: data.dispatchId, runId: data.runId, state: data.state } }, { triggerTurn: true, deliverAs: "followUp" });
  };

  const startLifecycleSubscription = (ctx?: unknown) => {
    supervisorContext = ctx;
    hasSupervisorContext = ctx !== undefined;
    if (subscription) return drainSupervisorRequests(ctx);
    if (subscribing) return subscribing.then(() => drainSupervisorRequests(ctx));
    subscribing = rpc.subscribe(onPush).then(async (handle: any) => {
      subscription = handle;
      handle.closed?.catch(() => undefined);
      if (disposed) handle.dispose();
      await drainSupervisorRequests(ctx);
    }).finally(() => { subscribing = undefined; });
    return subscribing;
  };

  if (recordSupervisorRequest) {
    pi.on("agent_settled", (_event: unknown, ctx: unknown) => {
      supervisorContext = ctx;
      hasSupervisorContext = true;
      return drainSupervisorRequests(ctx);
    });
    pi.on("session_shutdown", (_event: unknown, ctx: unknown) => {
      supervisorContext = ctx;
      hasSupervisorContext = true;
      return drainSupervisorRequests(ctx);
    });
  }

  const typed = createTypedSubagentExtension(pi, { rpc, prepareCodingSpawn, resolveCodingSpawnIdentity });
  const supervisorTool = createSupervisorTool({
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (params.action === "pending") return rpc.supervisorPending();
      if (params.action === "status") return rpc.supervisorPending();
      if (params.action === "reply") return rpc.supervisorReply(params);
      throw new Error("Unsupported supervisor action");
    },
  }, { name: "plan_executor_supervisor", label: "Plan Executor Supervisor" });
  pi.registerTool(supervisorTool);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    supervisorRequestIds.clear();
    lifecycleDedupe.clear();
    subscription?.dispose();
    typed.dispose();
  };
  return Object.freeze({ rpc, ...typed, dispose, startLifecycleSubscription, supervisorTool });
}
