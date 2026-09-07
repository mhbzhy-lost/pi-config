import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  currentCompletionOwnerId,
  loadConfig,
  registerSubagentNotify,
  resolveCurrentSessionId,
  upstreamSubagentRuntime,
} from "../src/compat/pi-subagents-0.62.ts";
import {
  formatCompactSubagentNotification,
  formatCompactSubagentSpawnSummary,
  formatCompactSubagentToolResult,
  formatCompactSupervisorRequest,
  formatCompactSupervisorToolResult,
} from "../src/tui/compact-rendering.ts";
import { installHeadlessTypedSubagentRuntime } from "../src/subagent-dispatch/extension.ts";
import { createRenewableTypedSubagentRpcClient, createTypedSubagentRpcClient } from "../src/subagent-dispatch/rpc-client.ts";
import { resolveRootSessionId } from "../src/subagent-dispatch/root-broker-protocol.ts";
import { closeAndUnbindRootBroker, inspectRootBrokerExecutionProof, registerRootBrokerAuthorizedRun, startAndBindRootBroker } from "../src/subagent-dispatch/root-broker-registry.ts";
import { RootBrokerServer } from "../src/subagent-dispatch/root-broker-server.ts";
import { createManagedWorkspaceService } from "../src/workspace/service.ts";
import { bindManagedWorkspaceServiceSession, unbindManagedWorkspaceServiceSession } from "../src/workspace/registry.ts";

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
  if (!run?.runId || snapshot === undefined || snapshot === null || snapshot?.state === "pending") {
    return { state: "pending" };
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || (snapshot.schemaVersion === "root-broker.execution-proof.v2" && snapshot.binding?.runId === run.runId)) {
    if (snapshot?.schemaVersion === "root-broker.execution-proof.v2" && snapshot.binding?.runId === run.runId) {
      if (snapshot.terminal === null) return { state: "pending" };
      if (snapshot.terminal && typeof snapshot.terminal === "object"
          && /^[a-f0-9]{64}$/.test(snapshot.terminal.proofId)
          && typeof snapshot.terminalConflict === "boolean") {
        return { state: "observed", conflict: snapshot.terminalConflict, proofHash: snapshot.terminal.proofId };
      }
    }
    const error = new Error("observed facade terminal proof is invalid") as Error & { code: string };
    error.code = "MANAGED_WORKSPACE_TERMINAL_PROOF_ADAPTER";
    throw error;
  }
  if (snapshot.runId !== run.runId || snapshot.state !== "observed"
      || typeof snapshot.conflict !== "boolean" || !/^[a-f0-9]{64}$/.test(snapshot.proofHash)) {
    const error = new Error("observed facade terminal proof is invalid") as Error & { code: string };
    error.code = "MANAGED_WORKSPACE_TERMINAL_PROOF_ADAPTER";
    throw error;
  }
  return { state: "observed", conflict: snapshot.conflict, proofHash: snapshot.proofHash };
}

function notificationColor(text: string): "error" | "warning" | "success" | "dim" {
  if (text.split("\n").some((line) => line.startsWith("✗"))) return "error";
  if (text.split("\n").some((line) => /^(?:\?|!|Ⅱ|■)/.test(line))) return "warning";
  if (text.split("\n").some((line) => line.startsWith("◇"))) return "dim";
  return "success";
}

const SUBAGENT_SPAWN_SUMMARY_KEY = "subagentSpawnSummary";

export function initializeCompletionNotifierState(state: { currentSessionId: string | null; completionOwnerId?: string }) {
  state.completionOwnerId = currentCompletionOwnerId();
  return state;
}


function spawnStartingSummary(args: any): string | undefined {
  if (!args || typeof args !== "object" || Object.hasOwn(args, "action")) return undefined;
  const agent = typeof args.agent === "string" ? args.agent.trim() : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  return agent && title ? `subagent starting ${agent}: ${title}` : undefined;
}

export function createSubagentToolRenderers() {
  const messageBox = (text: string, background: string, theme: any, splitHeader = false) => {
    const box = new Box(1, 1, (line) => theme.bg(background, line));
    if (splitHeader) {
      const [header, ...body] = text.split("\n");
      box.addChild(new Text(header ?? "", 0, 0));
      box.addChild(new Text(body.join("\n"), 0, 0));
    } else box.addChild(new Text(text, 0, 0));
    return box;
  };
  const renderSubagentCall = (args: any, theme: any, context: any) => {
    const starting = spawnStartingSummary(args);
    if (!starting) return new Text("", 0, 0);
    const summary = context?.state?.[SUBAGENT_SPAWN_SUMMARY_KEY] ?? starting;
    return new Text(typeof summary === "string" ? theme.fg("dim", summary) : "", 0, 0);
  };
  const renderSubagentResult = (result: any, _options: any, theme: any, context: any) => {
    const args = context?.args;
    const summary = args && !Object.hasOwn(args, "action")
      ? formatCompactSubagentSpawnSummary(result)
      : undefined;
    if (summary) {
      if (context?.state) context.state[SUBAGENT_SPAWN_SUMMARY_KEY] = summary;
      return new Text("", 0, 0);
    }
    const text = formatCompactSubagentToolResult(result, args ?? {});
    return new Text(theme.fg(result?.isError ? "error" : "dim", text), 0, 0);
  };
  const renderSupervisorRequest = (message: any, options: any, theme: any) => {
    const text = formatCompactSupervisorRequest(message);
    void options;
    return messageBox(text, "toolPendingBg", theme, true);
  };
  const renderControlNotice = () => new Text("", 0, 0);
  const renderSupervisorCall = (args: any, theme: any) => {
    const action = typeof args?.action === "string" ? args.action.trim() : "";
    return new Text(action === "reply" ? "" : theme.fg("dim", `subagent_supervisor${action ? ` ${action}` : ""}`), 0, 0);
  };
  const renderSupervisorResult = (result: any, _options: any, theme: any, context: any) => {
    const text = formatCompactSupervisorToolResult(result, context?.args ?? {});
    return new Text(theme.fg(result?.isError ? "error" : "dim", text), 0, 0);
  };
  const renderCompletionNotification = (message: any, theme: any) => {
    const text = formatCompactSubagentNotification(message);
    const color = notificationColor(text);
    const background = color === "success" ? "toolSuccessBg" : color === "error" || color === "warning" ? "toolErrorBg" : "toolPendingBg";
    return messageBox(text, background, theme);
  };
  return { renderSubagentCall, renderSubagentResult, renderSupervisorRequest, renderControlNotice, renderSupervisorCall, renderSupervisorResult, renderCompletionNotification };
}

export default function subagentRuntime(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1") return;
  const completionBatch = loadConfig().completionBatch;
  const { renderSubagentCall, renderSubagentResult, renderSupervisorRequest, renderControlNotice, renderSupervisorCall, renderSupervisorResult, renderCompletionNotification } = createSubagentToolRenderers();
  let brokerStarted = false;
  let brokerReady = false;
  let previousBrokerMarker: string | undefined;
  const rpc = createRenewableTypedSubagentRpcClient(() => createTypedSubagentRpcClient(pi.events));
  let broker: RootBrokerServer | undefined;
  let workspaceService: any;
  let workspaceRootSessionId: string | undefined;
  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap: upstreamSubagentRuntime,
    completionNotifierFactory(api: ExtensionAPI, state: { currentSessionId: string | null; completionOwnerId?: string }) {
      initializeCompletionNotifierState(state);
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
        brokerStarted = true;
        workspaceRootSessionId = rootSessionId;
        workspaceService = createManagedWorkspaceService({
          stateRoot: process.env.PI_CODING_WORKSPACE_DIR,
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
        }
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
      if (workspaceService && workspaceRootSessionId) {
        unbindManagedWorkspaceServiceSession(pi, workspaceRootSessionId, workspaceService);
        workspaceService = undefined;
        workspaceRootSessionId = undefined;
      }
      if (!brokerStarted || !broker) return;
      await closeAndUnbindRootBroker(pi, broker);
      if (previousBrokerMarker === undefined) delete process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
      else process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = previousBrokerMarker;
      previousBrokerMarker = undefined;
      broker = undefined;
      brokerStarted = false;
      brokerReady = false;
    },
    renderSubagentCall,
    renderSubagentResult,
    renderSupervisorCall,
    renderSupervisorResult,
    rpc,
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
  // Upstream registers the same custom type during bootstrap; the project renderer must win last-write ownership.
  pi.registerMessageRenderer("subagent-notify", (message, { outputPad }, theme) => {
    void outputPad;
    return renderCompletionNotification(message, theme);
  });
  pi.registerMessageRenderer("subagent_supervisor_request", renderSupervisorRequest);
  pi.registerMessageRenderer("subagent_control_notice", renderControlNotice);
}
