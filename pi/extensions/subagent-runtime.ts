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

function notificationColor(text: string): "error" | "warning" | "success" {
  if (text.split("\n").some((line) => line.startsWith("✗"))) return "error";
  if (text.split("\n").some((line) => line.startsWith("Ⅱ"))) return "warning";
  return "success";
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
    async prepareCodingSpawn(ir: { agent: string; execution: { cwd?: string } }) {
      if (ir.agent !== "executor") return;
      await materializeChildRuntimeEntry({
        cwd: ir.execution.cwd!,
        fileName: "root-session-owner-entry.mjs",
        targetUrl: new URL("../child-extensions/root-session-owner.ts", import.meta.url),
      });
    },
    retainOnBeforeDisposeFailure: true,
  });
  // Upstream registers the same custom type during bootstrap; the project renderer must win last-write ownership.
  pi.registerMessageRenderer("subagent-notify", (message, { outputPad }, theme) => {
    const text = formatCompactSubagentNotification(message);
    return new Text(theme.fg(notificationColor(text), text), outputPad, 0);
  });
}
