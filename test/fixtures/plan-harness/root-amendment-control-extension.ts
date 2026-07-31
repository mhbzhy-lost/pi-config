import { requireRootBroker } from "../../../scripts/lib/subagent-dispatch/root-broker-registry.ts";

const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value);
const result = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

export default function rootAmendmentControl(pi: any) {
  pi.registerTool({
    name: "plan_harness_crash_amendment",
    label: "Crash amendment fixture",
    description: "Test-only controlled amendment interruption.",
    parameters: { type: "object", properties: { logicalRunId: { type: "string", minLength: 1 }, executorRunId: { type: "string", minLength: 1 } }, required: ["logicalRunId", "executorRunId"], additionalProperties: false },
    async execute(_id: string, params: { logicalRunId?: unknown; executorRunId?: unknown }) {
      if (!safeId(params?.logicalRunId) || !safeId(params?.executorRunId)) return result({ error: "invalid amendment crash identity" }, true);
      try {
        const broker: any = requireRootBroker(pi);
        const actualRunId = broker.resolveActiveCaller(params.logicalRunId);
        const executor = broker.ownedRuns.get(params.executorRunId);
        const runner = broker.ownedRuns.get(actualRunId);
        if (!executor || !runner || executor.role !== "executor" || runner.role !== "plan-runner"
          || broker.runOwners.get(params.executorRunId) !== params.logicalRunId
          || broker.callers.get(params.logicalRunId)?.ownedRunIds?.has(params.executorRunId) !== true
          || broker.resolveActiveCaller(params.logicalRunId) !== actualRunId) return result({ error: "amendment crash ownership changed" }, true);
        await broker.drainRun(executor);
        const executorProof = broker.terminalProofs.get(params.executorRunId);
        if (!executorProof || broker.resolveActiveCaller(params.logicalRunId) !== actualRunId) return result({ error: "amendment crash active generation changed" }, true);
        await broker.drainRun(runner);
        const runnerProof = broker.terminalProofs.get(actualRunId);
        if (!runnerProof) return result({ error: "amendment crash missing official proof" }, true);
        return result({ logicalRunId: params.logicalRunId, actualRunId, executorRunId: params.executorRunId, executorProof, runnerProof });
      } catch (error) {
        return result({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  });
}
