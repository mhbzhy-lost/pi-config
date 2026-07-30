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
import { createSupervisorRequestMailbox, installHeadlessTypedSubagentRuntime } from "../../scripts/lib/subagent-dispatch/extension.ts";
import { createRenewableTypedSubagentRpcClient, createTypedSubagentRpcClient } from "../../scripts/lib/subagent-dispatch/rpc-client.ts";
import { resolveRootSessionId } from "../../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { requireRootBroker, startAndBindRootBroker, unbindRootBroker } from "../../scripts/lib/subagent-dispatch/root-broker-registry.ts";
import { RootBrokerServer } from "../../scripts/lib/subagent-dispatch/root-broker-server.ts";

export function createRootBrokerUpstream({ rpc, executeSupervisor }: { rpc: any; executeSupervisor: (...args: any[]) => any }) {
  return Object.freeze({
    ping: (...args: any[]) => rpc.ping(...args),
    spawn: (...args: any[]) => rpc.spawn(...args),
    status: (...args: any[]) => rpc.status(...args),
    resume: (...args: any[]) => rpc.resume(...args),
    steer: (...args: any[]) => rpc.steer(...args),
    interrupt: (...args: any[]) => rpc.interrupt(...args),
    stop: (...args: any[]) => rpc.stop(...args),
    dispose: (...args: any[]) => rpc.dispose(...args),
    executeSupervisor: (...args: any[]) => executeSupervisor(...args),
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
  let previousBrokerMarker: string | undefined;
  const rpc = createRenewableTypedSubagentRpcClient(() => createTypedSubagentRpcClient(pi.events));
  const mailbox = createSupervisorRequestMailbox((message, context) => (
    requireRootBroker(pi).routeSupervisorRequest(message, context)
  ));
  let runtime: any;
  runtime = installHeadlessTypedSubagentRuntime(pi, {
    bootstrap: upstreamSubagentRuntime,
    completionNotifierFactory(api: ExtensionAPI, state: { currentSessionId: string | null }) {
      return registerSubagentNotify(api, state, { batchConfig: completionBatch });
    },
    resolveSessionId: resolveCurrentSessionId,
    async beforeRuntimeDispose() {
      mailbox.deactivate();
      if (!brokerStarted) return;
      const broker = requireRootBroker(pi);
      await broker.closeRootSession();
      unbindRootBroker(pi, broker);
      if (previousBrokerMarker === undefined) delete process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
      else process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = previousBrokerMarker;
      previousBrokerMarker = undefined;
      brokerStarted = false;
    },
    renderSubagentResult,
    rpc,
    retainOnBeforeDisposeFailure: true,
    onSupervisorRequest: mailbox.handle,
  });
  pi.on("session_start", async (_event, ctx) => {
    rpc.renew();
    if (brokerStarted) throw new Error("Root subagent broker is already started");
    const rootSessionId = resolveRootSessionId(ctx.sessionManager);
    const upstream = createRootBrokerUpstream({
      rpc,
      executeSupervisor: (params: any, context: any) => runtime.executeSupervisor(params, context),
    });
    const broker = new RootBrokerServer({ rootSessionId, upstream, events: pi.events });
    previousBrokerMarker = process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
    try {
      await startAndBindRootBroker(pi, broker);
      process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = "1";
      brokerStarted = true;
      await mailbox.activate();
    } catch (error) {
      mailbox.deactivate();
      if (brokerStarted) {
        await broker.closeRootSession();
        unbindRootBroker(pi, broker);
        brokerStarted = false;
      }
      if (previousBrokerMarker === undefined) delete process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
      else process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = previousBrokerMarker;
      previousBrokerMarker = undefined;
      throw error;
    }
  });
  // Upstream registers the same custom type during bootstrap; the project renderer must win last-write ownership.
  pi.registerMessageRenderer("subagent-notify", (message, { outputPad }, theme) => {
    const text = formatCompactSubagentNotification(message);
    return new Text(theme.fg(notificationColor(text), text), outputPad, 0);
  });
}
