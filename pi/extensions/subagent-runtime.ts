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
import { createTypedSubagentRpcClient } from "../../scripts/lib/subagent-dispatch/rpc-client.ts";
import { requireRootBroker, startAndBindRootBroker, unbindRootBroker } from "../../scripts/lib/subagent-dispatch/root-broker-registry.ts";
import { RootBrokerServer } from "../../scripts/lib/subagent-dispatch/root-broker-server.ts";

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
  let previousBrokerMarker: string | undefined;
  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap: upstreamSubagentRuntime,
    completionNotifierFactory(api: ExtensionAPI, state: { currentSessionId: string | null }) {
      return registerSubagentNotify(api, state, { batchConfig: completionBatch });
    },
    resolveSessionId: resolveCurrentSessionId,
    async beforeRuntimeDispose() {
      if (!brokerStarted) return;
      const broker = requireRootBroker(pi);
      try {
        await broker.closeRootSession();
      } finally {
        unbindRootBroker(pi, broker);
        if (previousBrokerMarker === undefined) delete process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
        else process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = previousBrokerMarker;
        previousBrokerMarker = undefined;
        brokerStarted = false;
      }
    },
    renderSubagentResult,
  });
  pi.on("session_start", async (_event, ctx) => {
    if (brokerStarted) throw new Error("Root subagent broker is already started");
    const rootSessionId = resolveCurrentSessionId(ctx.sessionManager);
    const broker = new RootBrokerServer({ rootSessionId, upstream: createTypedSubagentRpcClient(pi.events), events: pi.events });
    previousBrokerMarker = process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
    await startAndBindRootBroker(pi, broker);
    process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = "1";
    brokerStarted = true;
  });
  // Upstream registers the same custom type during bootstrap; the project renderer must win last-write ownership.
  pi.registerMessageRenderer("subagent-notify", (message, { outputPad }, theme) => {
    const text = formatCompactSubagentNotification(message);
    return new Text(theme.fg(notificationColor(text), text), outputPad, 0);
  });
}
