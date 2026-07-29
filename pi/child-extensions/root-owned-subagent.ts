import { createTypedSubagentExtension } from "../../scripts/lib/subagent-dispatch/extension.ts";
import { createRootBrokerClient } from "../../scripts/lib/subagent-dispatch/root-broker-client.ts";
import { createSupervisorTool } from "../../scripts/lib/subagent-dispatch/supervisor-adapter.ts";

export function installRootOwnedSubagent(pi: any, { rootSessionId = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID, callerRunId = process.env.PI_SUBAGENT_RUN_ID, createClient = createRootBrokerClient } = {}) {
  if (!rootSessionId || !callerRunId) throw new Error("Root-owned subagent requires PI_SUBAGENT_RUN_ID and PI_SUBAGENT_ORCHESTRATOR_SESSION_ID");
  const rpc = createClient({ rootSessionId, callerRunId });
  const typed = createTypedSubagentExtension(pi, { rpc });
  const supervisorTool = createSupervisorTool({
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (params.action === "pending") return rpc.supervisorPending();
      if (params.action === "status") return rpc.supervisorPending();
      if (params.action === "reply") return rpc.supervisorReply(params);
      throw new Error("Unsupported supervisor action");
    },
  }, { name: "plan_executor_supervisor", label: "Plan Executor Supervisor" });
  pi.registerTool(supervisorTool);
  return Object.freeze({ rpc, ...typed, supervisorTool });
}
