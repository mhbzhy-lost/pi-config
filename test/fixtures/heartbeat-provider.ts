import { appendFileSync, existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type JsonObject, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRootBrokerClient } from "../../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts";
import { captureProcessBirthIdentity } from "../../packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts";

export const PARENT_MARKER = "HEARTBEAT_FIXTURE_PARENT";
export const CHILD_MARKER = "HEARTBEAT_FIXTURE_CHILD";
export const CLEANUP_MARKER = "HEARTBEAT_FIXTURE_CLEANUP";

export function heartbeatContract(cwd: string) {
  return {
    title: "隔离 managed coding heartbeat 观察",
    agent: "executor",
    task: `${CHILD_MARKER}：只在本地异步 barrier 等待。禁止修改 probe.txt 或任何仓库文件，禁止网络、shell 和新增后代；释放后只报告 changedFiles=[]。`,
    writePaths: ["probe.txt"],
    acceptance: { criteria: ["不修改任何仓库文件，changedFiles=[]；仅等待 fixture 的本地异步 barrier。"] },
    cwd,
    worktree: true,
    model: "heartbeat-fixture/local",
  };
}

function text(message: any): string {
  return typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}

function childReport() {
  return `本地 barrier 已释放，未修改文件。\n\n\`\`\`acceptance-report\n${JSON.stringify({
    criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "fixture provider 没有文件修改或 shell 分支。" }],
    changedFiles: [], testsAddedOrUpdated: [], commandsRun: [], validationOutput: ["本地异步 barrier 已释放"], residualRisks: [], noStagedFiles: true,
    diffSummary: "未修改仓库文件。",
  })}\n\`\`\``;
}

export default function heartbeatProvider(pi: ExtensionAPI) {
  const root = process.env.PI_HEARTBEAT_FIXTURE_ROOT;
  if (!root) throw new Error("缺少隔离 fixture 根");
  const child = process.env.PI_SUBAGENT_CHILD === "1";
  const log = (kind: string, value: Record<string, unknown> = {}) => appendFileSync(
    join(root, child ? `child-${process.pid}.jsonl` : "provider-observations.jsonl"),
    `${JSON.stringify({ kind, observedAt: Date.now(), pid: process.pid, ppid: process.ppid, ...value })}\n`, { mode: 0o600 },
  );
  let client: ReturnType<typeof createRootBrokerClient> | undefined;
  let observation: Promise<void> | undefined;
  const disposers: Array<() => void> = [];
  if (child) {
    // 旁路订阅同一合法 principal 的公开 lease push，不包装/替换 production watchdog。
    disposers.push(pi.events.on("pi-config:root-owner-ready", () => {
      observation = (async () => {
        const runId = process.env.PI_SUBAGENT_RUN_ID;
        const rootSessionId = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
        if (!runId || !rootSessionId) throw new Error("合法 root-owner-ready 缺少身份");
        client = createRootBrokerClient({ rootSessionId, callerRunId: runId, requiredCapability: "root.subscribe" });
        const owner = await client.readOwnerReceipt(runId) as any;
        const birth = await captureProcessBirthIdentity(process.pid);
        if (owner.processBirth !== birth) throw new Error("公开 owner receipt 与实际 runner birth 不符");
        log("owner", { runId, rootSessionId, ownerGeneration: owner.ownerGeneration, processBirth: birth, cwd: process.cwd() });
        const subscription = await client.subscribe(push => {
          if (push.type === "lease.updated") log("lease", { rootSessionId: push.rootSessionId, callerRunId: push.callerRunId, data: push.data });
        });
        subscription.closed.catch(() => { log("observer-eof"); });
        log("subscription-ready", { runId, rootSessionId });
      })();
      observation.catch(error => log("observation-error", { error: String(error) }));
    }));
    disposers.push(pi.events.on("subagent:acknowledge-extension", (event: any) => {
      if (event.id === "root-session-owner") log("acknowledged", { extensionId: event.id, runId: process.env.PI_SUBAGENT_RUN_ID });
    }));
    pi.on("session_start", () => { log("child-session-started", { cwd: process.cwd() }); });
    pi.on("session_shutdown", () => { client?.dispose(); for (const dispose of disposers) dispose(); });
  }
  let ordinal = 0;
  let cleanupWorkspace: string | undefined;
  pi.registerProvider("heartbeat-fixture", {
    api: "heartbeat-fixture", apiKey: "fixture-only-unused", baseUrl: "http://127.0.0.1:9",
    models: [{ id: "local", name: "本地 heartbeat fixture", input: ["text"], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
      void (async () => {
        try {
          // 全部请求都在内存生成；无 HTTP、真实 provider、shell 或凭据读取。
          await options?.onPayload?.({ fixture: "heartbeat-local" }, model);
          await options?.onProviderStreamEvent?.({ fixture: "heartbeat-local" }, model);
          stream.push({ type: "start", partial: message });
          let tool: { name: string; arguments: JsonObject } | undefined;
          let output: string;
          const messages = context.messages;
          const lastUser = [...messages].reverse().find(entry => entry.role === "user");
          const userText = text(lastUser);
          const results = messages.filter(entry => entry.role === "toolResult");
          if (child) {
            if (!userText.includes(CHILD_MARKER)) throw new Error("child 收到非 fixture 合同");
            if (!observation) throw new Error("模型启动前未观察到实际 root-owner-ready");
            await observation;
            const cwd = process.cwd();
            const within = relative(root, cwd);
            if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("child cwd 不在 fixture managed workspace 内");
            log("barrier-entered", { runId: process.env.PI_SUBAGENT_RUN_ID, cwd });
            while (!existsSync(join(root, "release-barrier"))) {
              if (options?.signal?.aborted) throw new Error("fixture barrier aborted");
              await delay(100, undefined, { signal: options?.signal });
            }
            output = childReport();
          } else if (userText.includes(CLEANUP_MARKER)) {
            // prepare-only 仅通过公开 workspace 工具处置；拒绝 raw git worktree/rm。
            const last = results.at(-1) as any;
            const dispatched = results.find(entry => entry.toolName === "subagent" && (entry as any).details?.workspace_id) as any;
            cleanupWorkspace ??= dispatched?.details?.workspace_id;
            if (!cleanupWorkspace) throw new Error("normal dispose 缺 workspace handle");
            const lastDetails = last?.details;
            if (last?.toolName === "subagent_worktree" && last?.isError) throw new Error("public workspace dispose 失败");
            if (last?.toolName !== "subagent_worktree") tool = { name: "subagent_worktree", arguments: { action: "status", workspace_id: cleanupWorkspace } };
            else if (lastDetails?.workspace_state === "released") output = "HEARTBEAT_FIXTURE_DISPOSED";
            else if (lastDetails?.allowed_dispositions?.includes("discard") && lastDetails?.action_token) tool = { name: "subagent_worktree", arguments: { action: "dispose", disposition: "discard", workspace_id: cleanupWorkspace, action_token: lastDetails.action_token } };
            else throw new Error("public workspace 未允许 discard；保留现场等待精确处置");
          } else if (results.some(entry => entry.toolName === "subagent")) {
            if (results.some(entry => entry.toolName === "subagent" && entry.isError)) throw new Error("typed dispatch 失败");
            output = "HEARTBEAT_FIXTURE_DISPATCHED";
          } else {
            if (!userText.includes(PARENT_MARKER)) throw new Error("parent 收到非 fixture prompt");
            if (!getCurrentTools(messages).some(entry => entry.name === "subagent")) throw new Error("缺 typed subagent tool");
            tool = { name: "subagent", arguments: heartbeatContract(process.cwd()) };
          }
          if (options?.signal?.aborted) throw new Error("fixture aborted");
          if (tool) {
            const call: ToolCall = { type: "toolCall", id: `heartbeat-${++ordinal}`, name: tool.name, arguments: tool.arguments };
            message.content = [call];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
            message.stopReason = "toolUse";
            stream.push({ type: "done", reason: "toolUse", message });
          } else {
            message.content = [{ type: "text", text: output! }];
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: output!, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: output!, partial: message });
            message.stopReason = "stop";
            stream.push({ type: "done", reason: "stop", message });
          }
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } finally { stream.end(); }
      })();
      return stream;
    },
  });
}
