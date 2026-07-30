import { createTypedSubagentExtension } from "../../scripts/lib/subagent-dispatch/extension.ts";
import { createRootBrokerClient } from "../../scripts/lib/subagent-dispatch/root-broker-client.ts";
import { createSupervisorTool } from "../../scripts/lib/subagent-dispatch/supervisor-adapter.ts";

export function installRootOwnedSubagent(pi: any, { rootSessionId = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID, callerRunId = process.env.PI_SUBAGENT_RUN_ID, createClient = createRootBrokerClient, lifecycleDedupeLimit = 1024, resolveCodingSpawnIdentity } = {}) {
  if (!Number.isSafeInteger(lifecycleDedupeLimit) || lifecycleDedupeLimit <= 0) throw new Error("Lifecycle dedupe limit must be a positive safe integer");
  if (!rootSessionId || !callerRunId) throw new Error("Root-owned subagent requires PI_SUBAGENT_RUN_ID and PI_SUBAGENT_ORCHESTRATOR_SESSION_ID");
  const rpc = createClient({ rootSessionId, callerRunId });
  const typed = createTypedSubagentExtension(pi, { rpc, resolveCodingSpawnIdentity });
  const supervisorTool = createSupervisorTool({
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (params.action === "pending") return rpc.supervisorPending();
      if (params.action === "status") return rpc.supervisorPending();
      if (params.action === "reply") return rpc.supervisorReply(params);
      throw new Error("Unsupported supervisor action");
    },
  }, { name: "plan_executor_supervisor", label: "Plan Executor Supervisor" });
  pi.registerTool(supervisorTool);
  let disposed = false;
  let subscription: any;
  let subscribing: Promise<void> | undefined;
  const dedupe = new Set<string>();
  const onPush = (push: any) => {
    if (push?.type === "supervisor.request") {
      const data = push.data;
      const key = `supervisor.request\u0000${data?.requestId}`;
      if (dedupe.has(key)) return;
      dedupe.add(key);
      if (dedupe.size > lifecycleDedupeLimit) dedupe.delete(dedupe.values().next().value!);
      pi.sendMessage({ customType: "subagent_supervisor_request", content: data.content, display: true, details: { id: data.requestId, reason: data.reason, expectsReply: data.expectsReply, runId: data.executorRunId, agent: data.agent, childIndex: data.childIndex } }, { triggerTurn: true });
      return;
    }
    if (!push || (push.type !== "execution.started" && push.type !== "execution.completed")) return;
    const data = push.data;
    const key = `${push.type}\u0000${data?.dispatchId}\u0000${data?.runId}\u0000${data?.state}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    if (dedupe.size > lifecycleDedupeLimit) dedupe.delete(dedupe.values().next().value!);
    pi.events.emit(push.type === "execution.started" ? "subagent:async-started" : "subagent:async-complete", data);
    pi.sendMessage({ customType: "pi-root-subagent-lifecycle-v1", content: "A lifecycle update arrived. Call plan_status.", details: { dispatchId: data.dispatchId, runId: data.runId, state: data.state } }, { triggerTurn: true, deliverAs: "followUp" });
  };
  const startLifecycleSubscription = () => {
    if (subscription) return Promise.resolve();
    if (subscribing) return subscribing;
    subscribing = rpc.subscribe(onPush).then((handle: any) => {
      subscription = handle;
      handle.closed?.catch(() => undefined);
      if (disposed) handle.dispose();
    }).finally(() => { subscribing = undefined; });
    return subscribing;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    subscription?.dispose();
    typed.dispose();
  };
  return Object.freeze({ rpc, ...typed, dispose, startLifecycleSubscription, supervisorTool });
}
