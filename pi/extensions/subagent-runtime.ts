import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import upstreamSubagentRuntime from "../npm/node_modules/pi-subagents/index.ts";
import { loadConfig } from "../npm/node_modules/pi-subagents/src/extension/config.ts";
import registerSubagentNotify from "../npm/node_modules/pi-subagents/src/runs/background/notify.ts";
import { resolveCurrentSessionId } from "../npm/node_modules/pi-subagents/src/shared/session-identity.ts";
import {
  formatCompactSubagentNotification,
  formatCompactSubagentToolResult,
} from "../../scripts/lib/subagent-dispatch/compact-rendering.ts";
import { installHeadlessTypedSubagentRuntime } from "../../scripts/lib/subagent-dispatch/extension.ts";
import { createRenewableTypedSubagentRpcClient, createTypedSubagentRpcClient } from "../../scripts/lib/subagent-dispatch/rpc-client.ts";
import { resolveRootSessionId } from "../../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { closeAndUnbindRootBroker, startAndBindRootBroker } from "../../scripts/lib/subagent-dispatch/root-broker-registry.ts";
import { RootBrokerServer } from "../../scripts/lib/subagent-dispatch/root-broker-server.ts";
import { materializeChildRuntimeEntry } from "../../scripts/lib/subagent-dispatch/child-runtime-entry.ts";

export function createRootBrokerUpstream({ rpc }: { rpc: any }) {
  return Object.freeze({
    ping: (...args: any[]) => rpc.ping(...args),
    stop: (...args: any[]) => rpc.stop(...args),
    dispose: (...args: any[]) => rpc.dispose(...args),
  });
}

function notificationColor(text: string): "error" | "warning" | "success" | "dim" {
  if (text.split("\n").some((line) => line.startsWith("✗"))) return "error";
  if (text.split("\n").some((line) => /^(?:\?|!|Ⅱ|■)/.test(line))) return "warning";
  if (text.split("\n").some((line) => line.startsWith("◇"))) return "dim";
  return "success";
}

function evidenceCriterionIds(criteria: unknown): string[] {
  if (!Array.isArray(criteria) || !criteria.length) throw new Error("executor acceptance criteria are unavailable");
  const ids = criteria.map((criterion) => {
    if (typeof criterion !== "string" || !criterion.trim()) throw new Error("executor acceptance criterion is invalid");
    if (!criterion.trimStart().startsWith("{")) return criterion;
    let planned: unknown;
    try { planned = JSON.parse(criterion); } catch { throw new Error("executor planned acceptance criterion is malformed"); }
    if (!planned || typeof planned !== "object" || Array.isArray(planned) || Object.keys(planned).length !== 3
      || !Object.hasOwn(planned, "id") || !Object.hasOwn(planned, "statement") || !Object.hasOwn(planned, "evidenceKinds")
      || typeof (planned as { id?: unknown }).id !== "string" || !(planned as { id: string }).id.trim()) throw new Error("executor planned acceptance criterion is invalid");
    return (planned as { id: string }).id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("executor acceptance criteria contain duplicate IDs");
  return ids;
}

export default function subagentRuntime(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1") return;
  const completionBatch = loadConfig().completionBatch;
  const renderSubagentResult = (result: any, _options: any, theme: any, context: any) => {
    const text = formatCompactSubagentToolResult(result, context?.args ?? {});
    return new Text(theme.fg(result?.isError ? "error" : "dim", text), 0, 0);
  };
  let brokerStarted = false;
  let brokerReady = false;
  let previousBrokerMarker: string | undefined;
  const rpc = createRenewableTypedSubagentRpcClient(() => createTypedSubagentRpcClient(pi.events));
  let broker: RootBrokerServer | undefined;
  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap: upstreamSubagentRuntime,
    completionNotifierFactory(api: ExtensionAPI, state: { currentSessionId: string | null }) {
      return registerSubagentNotify(api, state, { batchConfig: completionBatch });
    },
    resolveSessionId: resolveCurrentSessionId,
    async beforeUpstreamSessionStart(_event, ctx) {
      if (brokerReady) return;
      if (brokerStarted) throw new Error("Root subagent broker startup is incomplete");
      rpc.renew();
      const rootSessionId = resolveRootSessionId(ctx.sessionManager);
      const lifecycleSessionId = resolveCurrentSessionId(ctx.sessionManager);
      const upstream = createRootBrokerUpstream({ rpc });
      const startingBroker = new RootBrokerServer({ rootSessionId, lifecycleSessionId, upstream, events: pi.events });
      previousBrokerMarker = process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
      try {
        await startAndBindRootBroker(pi, startingBroker);
        broker = startingBroker;
        process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = "1";
        brokerStarted = true;
        brokerReady = true;
      } catch (error) {
        if (brokerStarted) {
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
      if (!brokerStarted || !broker) return;
      await closeAndUnbindRootBroker(pi, broker);
      if (previousBrokerMarker === undefined) delete process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
      else process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = previousBrokerMarker;
      previousBrokerMarker = undefined;
      broker = undefined;
      brokerStarted = false;
      brokerReady = false;
    },
    renderSubagentResult,
    rpc,
    resolveRootSessionId: (sessionManager: any) => resolveRootSessionId(sessionManager),
    registerFacadeRun: (run: any) => {
      if (!brokerReady || !broker) {
        const error = new Error("FACADE_PROOF_UNAVAILABLE");
        error.code = "FACADE_PROOF_UNAVAILABLE";
        throw error;
      }
      broker.registerFacadeRun(run);
    },
    inspectFacadeTerminalProof: (runId: string) => {
      if (!brokerReady || !broker) return { state: "unknown" };
      try { return broker.inspectFacadeTerminalProof(runId) ?? { state: "unknown" }; } catch { return { state: "unknown" }; }
    },
    async prepareCodingSpawn(ir: { agent: string; execution: { cwd?: string }; acceptance: { criteria: string[] } }, ticket: any) {
      if (ir.agent !== "executor") return;
      const criteria = ticket ? evidenceCriterionIds(ir.acceptance.criteria) : undefined;
      await materializeChildRuntimeEntry({
        cwd: ir.execution.cwd!,
        fileName: "root-session-owner-entry.mjs",
        targetUrl: new URL("../child-extensions/root-session-owner.ts", import.meta.url),
      });
      if (!ticket) return;
      const identity = { goalId: ticket.goalId, taskId: ticket.taskId, attempt: ticket.attempt, runId: process.env.PI_SUBAGENT_RUN_ID ?? "", contractHash: ticket.contractHash, head: ticket.headAtDispatch };
      const target = new URL("../child-extensions/acceptance-evidence.ts", import.meta.url);
      target.searchParams.set("identity", JSON.stringify(identity));
      target.searchParams.set("criteria", JSON.stringify(criteria));
      await materializeChildRuntimeEntry({ cwd: ir.execution.cwd!, fileName: "acceptance-evidence-entry.mjs", targetUrl: target });
    },
    retainOnBeforeDisposeFailure: true,
  });
  // Upstream registers the same custom type during bootstrap; the project renderer must win last-write ownership.
  pi.registerMessageRenderer("subagent-notify", (message, { outputPad }, theme) => {
    const text = formatCompactSubagentNotification(message);
    return new Text(theme.fg(notificationColor(text), text), outputPad, 0);
  });
}
