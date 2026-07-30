import { join } from "node:path";
import * as publicPiModule from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

export const REQUIRED_METHODS = ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"];
export const SUPPORTED_PI_VERSIONS = ["0.82.0", "0.82.1", "0.83.0"];

export async function assertBrowserTranscriptCompatibility({
  packageRoot,
  piModule = publicPiModule,
  jiti,
} = {}) {
  if (!packageRoot || !jiti) throw new Error("pi-subagents browser compatibility requires packageRoot and jiti");
  for (const capability of [
    "AssistantMessageComponent",
    "BashExecutionComponent",
    "BranchSummaryMessageComponent",
    "CompactionSummaryMessageComponent",
    "CustomMessageComponent",
    "parseSkillBlock",
    "SessionManager",
    "sessionEntryToContextMessages",
    "SkillInvocationMessageComponent",
    "ToolExecutionComponent",
    "UserMessageComponent",
  ]) {
    if (typeof piModule[capability] !== "function") throw new Error(`pi-subagents browser compatibility missing ${capability}`);
  }
  const transcriptModule = await jiti.import(join(packageRoot, "src/tui/fleet-transcript.ts"));
  const artifactsModule = await jiti.import(join(packageRoot, "src/shared/artifacts.ts"));
  for (const [module, name] of [
    [transcriptModule, "readFleetTranscript"],
    [transcriptModule, "renderFleetTranscript"],
    [artifactsModule, "getArtifactsDir"],
  ]) {
    if (typeof module[name] !== "function") throw new Error(`pi-subagents browser compatibility missing ${name}`);
  }
}

export function buildTopLevelRuntimeEnv(env = process.env) {
  for (const marker of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_FANOUT_CHILD"]) {
    if (env[marker]) throw new Error(`top-level runtime cannot start with ${marker}`);
  }
  const topLevel = { ...env };
  delete topLevel.PI_SUBAGENT_PARENT_SESSION;
  return topLevel;
}

export function createSubagentsRpcClient(events, { randomUUID = () => crypto.randomUUID(), timeoutMs = 5000 } = {}) {
  return {
    call(method, params = {}) {
      const requestId = randomUUID();
      const replyChannel = `subagents:rpc:v1:reply:${requestId}`;

      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe();
          callback(value);
        };
        const unsubscribe = events.on(replyChannel, (reply) => {
          if (reply.version !== 1) {
            settle(reject, new Error(`unexpected subagents RPC reply version: ${reply.version}`));
          } else if (reply.requestId !== requestId) {
            settle(reject, new Error(`unexpected subagents RPC reply request id: ${reply.requestId}`));
          } else if (reply.success) {
            settle(resolve, reply.data);
          } else {
            settle(reject, new Error(reply.error?.message ?? "subagents RPC failed"));
          }
        });
        const timeout = setTimeout(
          () => settle(reject, new Error(`subagents RPC ${method} timed out`)),
          timeoutMs,
        );

        events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
      });
    },
  };
}

export function evaluatePlanHarnessCompatibility(report) {
  const failures = [];

  if (!SUPPORTED_PI_VERSIONS.includes(report.piVersion)) failures.push(`unsupported Pi version: ${report.piVersion}`);
  if (report.version !== "0.37.2") failures.push(`unexpected pi-subagents version: ${report.version}`);
  if (report.typeboxVersion !== "1.1.38") failures.push(`unexpected typebox version: ${report.typeboxVersion}`);
  if (report.typeboxCompileResolvable !== true) failures.push("typebox/compile is not resolvable from pi-subagents");
  if (report.rpcVersion !== 1) failures.push(`unexpected RPC version: ${report.rpcVersion}`);
  for (const method of REQUIRED_METHODS) {
    if (!report.methods?.includes(method)) failures.push(`missing RPC method: ${method}`);
  }
  for (const event of ["subagent:async-started", "subagent:async-complete", "subagent:process-terminal"]) {
    if (!report.events?.includes(event)) failures.push(`missing lifecycle event: ${event}`);
  }
  for (const [field, message] of [
    ["rootBrokerReady", "Root subagent broker is not ready"],
    ["childAdapterRegistered", "project child adapter is not registered"],
    ["noFanoutExtension", "fanout-child extension is active"],
    ["exactCwd", "Executor did not use the authorized cwd"],
    ["worktreeDisabled", "pi-subagents created an unauthorized worktree"],
    ["waitWakesOnCompletion", "wait did not wake on completion"],
    ["rpcStatusFindsActiveRun", "RPC status did not find the active Executor"],
    ["statusArtifactObservesSupervisorBlock", "Status artifact did not observe the Supervisor block"],
    ["supervisorRoundTrip", "Supervisor request/reply failed"],
    ["executorFanoutBlocked", "Executor can dispatch nested subagents"],
  ]) {
    if (report[field] !== true) failures.push(message);
  }
  if (report.flatRuntimeDepth !== 1) failures.push(`unexpected flat runtime depth: ${report.flatRuntimeDepth}`);
  if (report.nestedEventFiles !== 0) failures.push(`unexpected nested event files: ${report.nestedEventFiles}`);

  return { ok: failures.length === 0, failures };
}
