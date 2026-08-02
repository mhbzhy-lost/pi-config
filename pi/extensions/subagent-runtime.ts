import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import upstreamSubagentRuntime from "../npm/node_modules/pi-subagents/index.ts";
import { loadConfig } from "../npm/node_modules/pi-subagents/src/extension/config.ts";
import { readAsyncRecoveryDescriptor } from "../npm/node_modules/pi-subagents/src/runs/background/async-resume.ts";
import registerSubagentNotify from "../npm/node_modules/pi-subagents/src/runs/background/notify.ts";
import { writePrivateAtomicJson } from "../npm/node_modules/pi-subagents/src/shared/atomic-json.ts";
import { resolveCurrentSessionId } from "../npm/node_modules/pi-subagents/src/shared/session-identity.ts";
import { ASYNC_DIR } from "../npm/node_modules/pi-subagents/src/shared/types.ts";
import {
  formatCompactSubagentNotification,
  formatCompactSubagentToolResult,
} from "../../scripts/lib/subagent-dispatch/compact-rendering.ts";
import { createSupervisorRequestMailbox, installHeadlessTypedSubagentRuntime } from "../../scripts/lib/subagent-dispatch/extension.ts";
import { createRenewableTypedSubagentRpcClient, createTypedSubagentRpcClient } from "../../scripts/lib/subagent-dispatch/rpc-client.ts";
import { resolveRootSessionId } from "../../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { closeAndUnbindRootBroker, requireRootBroker, startAndBindRootBroker } from "../../scripts/lib/subagent-dispatch/root-broker-registry.ts";
import { RootBrokerServer } from "../../scripts/lib/subagent-dispatch/root-broker-server.ts";
import { materializeChildRuntimeEntry } from "../../scripts/lib/subagent-dispatch/child-runtime-entry.ts";

const MAX_RECOVERY_DESCRIPTOR_BYTES = 1024 * 1024;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

function isSafeRunId(value: unknown): value is string {
  return typeof value === "string" && SAFE_RUN_ID.test(value) && value !== "." && value !== "..";
}

function sameFileIdentity(left: { dev: number; ino: number; size: number; isFile(): boolean }, right: { dev: number; ino: number; size: number; isFile(): boolean }): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

export function createRootBrokerUpstream({ rpc, executeSupervisor, asyncDirRoot = ASYNC_DIR }: { rpc: any; executeSupervisor: (...args: any[]) => any; asyncDirRoot?: string }) {
  async function preparePlanRunnerRecovery(input: unknown): Promise<void> {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(["asyncDir", "role", "runId"])) {
      throw new Error("Invalid Plan Runner recovery metadata");
    }
    const { role, runId, asyncDir } = input as { role?: unknown; runId?: unknown; asyncDir?: unknown };
    if (role !== "plan-runner" || !isSafeRunId(runId) || typeof asyncDir !== "string" || !path.isAbsolute(asyncDir)) {
      throw new Error("Invalid Plan Runner recovery metadata");
    }

    const resolvedRoot = await realpath(asyncDirRoot);
    const rootStats = await lstat(resolvedRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("Async recovery root must be a directory");
    const requestedStats = await lstat(asyncDir);
    if (!requestedStats.isDirectory() || requestedStats.isSymbolicLink()) throw new Error("Async recovery run directory must be a directory");
    const resolvedAsyncDir = await realpath(asyncDir);
    const runStats = await lstat(resolvedAsyncDir);
    if (!runStats.isDirectory() || runStats.isSymbolicLink() || path.dirname(resolvedAsyncDir) !== resolvedRoot || path.basename(resolvedAsyncDir) !== runId) {
      throw new Error("Async recovery run directory is not trusted");
    }

    const descriptorPath = path.join(resolvedAsyncDir, "recovery-descriptor.json");
    const before = await lstat(descriptorPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECOVERY_DESCRIPTOR_BYTES) {
      throw new Error("Async recovery descriptor is not a trusted regular file");
    }
    const descriptor = readAsyncRecoveryDescriptor(resolvedAsyncDir);
    const after = await lstat(descriptorPath);
    if (!sameFileIdentity(before, after)) throw new Error("Async recovery descriptor changed while reading");
    if (!descriptor || descriptor.version !== 1 || descriptor.sourceRunId !== runId || descriptor.agent !== "plan-runner") {
      throw new Error("Async recovery descriptor identity is invalid");
    }
    const recoveryDescriptor = { ...descriptor };
    delete recoveryDescriptor.tools;
    writePrivateAtomicJson(descriptorPath, recoveryDescriptor);
  }

  return Object.freeze({
    ping: (...args: any[]) => rpc.ping(...args),
    spawn: (...args: any[]) => rpc.spawn(...args),
    status: (...args: any[]) => rpc.status(...args),
    resume: (...args: any[]) => rpc.resume(...args),
    steer: (...args: any[]) => rpc.steer(...args),
    interrupt: (...args: any[]) => rpc.interrupt(...args),
    stop: (...args: any[]) => rpc.stop(...args),
    dispose: (...args: any[]) => rpc.dispose(...args),
    preparePlanRunnerRecovery,
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
  let brokerReady = false;
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
    async beforeUpstreamSessionStart(_event, ctx) {
      if (brokerReady) return;
      if (brokerStarted) throw new Error("Root subagent broker startup is incomplete");
      rpc.renew();
      const rootSessionId = resolveRootSessionId(ctx.sessionManager);
      const lifecycleSessionId = resolveCurrentSessionId(ctx.sessionManager);
      const upstream = createRootBrokerUpstream({
        rpc,
        executeSupervisor: (params: any, context: any) => runtime.executeSupervisor(params, context),
      });
      const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId, upstream, events: pi.events, recordRevivalDiagnostic: (customType, data) => pi.appendEntry(customType, data) });
      previousBrokerMarker = process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
      try {
        await startAndBindRootBroker(pi, broker);
        process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = "1";
        brokerStarted = true;
        await mailbox.activate();
        brokerReady = true;
      } catch (error) {
        mailbox.deactivate();
        if (brokerStarted) {
          await closeAndUnbindRootBroker(pi, broker);
          brokerStarted = false;
        }
        if (previousBrokerMarker === undefined) delete process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
        else process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = previousBrokerMarker;
        previousBrokerMarker = undefined;
        throw error;
      }
    },
    async beforeRuntimeDispose() {
      mailbox.deactivate();
      if (!brokerStarted) return;
      const broker = requireRootBroker(pi);
      await closeAndUnbindRootBroker(pi, broker);
      if (previousBrokerMarker === undefined) delete process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED;
      else process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = previousBrokerMarker;
      previousBrokerMarker = undefined;
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
    onSupervisorRequest: mailbox.handle,
  });
  // Upstream registers the same custom type during bootstrap; the project renderer must win last-write ownership.
  pi.registerMessageRenderer("subagent-notify", (message, { outputPad }, theme) => {
    const text = formatCompactSubagentNotification(message);
    return new Text(theme.fg(notificationColor(text), text), outputPad, 0);
  });
}
