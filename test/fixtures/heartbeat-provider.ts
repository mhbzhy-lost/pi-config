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

// 公开 workspace 工具白名单：清理回合只允许经这四个工具处置，不碰 raw ledger/git。
const CLEANUP_WORKSPACE_TOOLS = Object.freeze([
  "managed_workspace_list", "managed_workspace_status", "managed_workspace_dispose", "managed_workspace_release",
]);
// 处置分支的公开状态集合：状态机词表固定，不自造别名。
const CLEANUP_RELEASE_STATES = Object.freeze(["preserved", "cleanup-debt"]);
// 在途中间态：属于合法处理中，只能在既有预算内有限次观察，既不当终态也不当失败。
const CLEANUP_IN_FLIGHT_STATES = Object.freeze(["reserved", "allocating", "disposing"]);
// 有限观察窗口：每次间隔 500ms、最多 20 次公开观察（最坏 ~10s），落在 harness 既有 30s cleanup
// 总预算内；不新增 timeout、不做常驻循环。
const CLEANUP_OBSERVATION_LIMIT = 20;
const CLEANUP_OBSERVATION_INTERVAL_MS = 500;

// 从一次公开 workspace 回执中取出本条 workspace 的精确状态与可处置字段。
// 只接受真实 public 返回形状：list → details.workspaces[]，status/dispose/release → 扁平 details；
// 形状不符即抛错（fail closed），不兼容多个猜测形状。
function cleanupObservation(entry: any, workspaceId: string): { state: string; allowed: string[]; token?: string } {
  const details = entry?.details;
  if (entry?.toolName === "managed_workspace_list") {
    if (!Array.isArray(details?.workspaces)) throw new Error("managed_workspace_list 回执缺少 workspaces 投影；保留现场");
    const workspace = details.workspaces.find((item: any) => item?.workspace_id === workspaceId);
    // list 是名册语义，不投影 allowed_dispositions/action_token，这里只取 state。
    if (!workspace) throw new Error("public list 未包含精确 workspace；保留现场");
    if (typeof workspace.workspace_state !== "string" || workspace.workspace_state.length === 0) throw new Error("public list 投影缺少 workspace_state；保留现场");
    return { state: workspace.workspace_state, allowed: [] };
  }
  if (details?.workspace_id !== workspaceId || typeof details?.workspace_state !== "string" || details.workspace_state.length === 0) {
    throw new Error(`${String(entry?.toolName)} 回执缺少精确 workspace 投影；保留现场`);
  }
  const allowed = details.allowed_dispositions;
  if (allowed !== undefined && (!Array.isArray(allowed) || allowed.some((item: any) => typeof item !== "string"))) {
    throw new Error(`${entry.toolName} 的 allowed_dispositions 形状不符；保留现场`);
  }
  const token = typeof details.action_token === "string" && details.action_token.length > 0 ? details.action_token : undefined;
  return { state: details.workspace_state, allowed: allowed ?? [], ...(token ? { token } : {}) };
}

export function heartbeatContract(cwd: string) {
  return {
    title: "隔离 managed coding heartbeat 观察",
    agent: "executor",
    task: `${CHILD_MARKER}：只在本地异步 barrier 等待。禁止修改 probe.txt 或任何仓库文件，禁止网络、shell 和新增后代；释放后用 read 读取 probe.txt 并如实报告 changedFiles=[] 与命令证据。`,
    writePaths: ["probe.txt"],
    acceptance: { criteria: ["不修改任何仓库文件，changedFiles=[]；等待本地 barrier 后通过 read 读取 probe.txt，记录实际结果。"] },
    cwd,
    worktree: true,
    model: "heartbeat-fixture/local",
  };
}

function text(message: any): string {
  return typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}

function childReport(command: string) {
  return `本地 barrier 已释放，未修改文件。\n\n\`\`\`acceptance-report\n${JSON.stringify({
    criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "fixture provider 没有文件修改或 shell 分支。" }],
    changedFiles: [], testsAddedOrUpdated: [], commandsRun: [{ command, result: "passed", summary: "实际 read 工具成功读取 probe.txt" }], validationOutput: ["本地异步 barrier 已释放；read 工具成功"], residualRisks: [], noStagedFiles: true,
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
            const validation = results.findLast(entry => entry.toolName === "read");
            if (!validation) tool = { name: "read", arguments: { path: join(cwd, "probe.txt") } };
            else {
              if (validation.isError) throw new Error("正常 child 的 read 验证失败，不能报告命令通过");
              output = childReport(`read ${join(cwd, "probe.txt")}`);
            }
          } else if (userText.includes(CLEANUP_MARKER)) {
            // prepare-only 仅通过公开 workspace 工具处置；拒绝 raw git worktree/rm、拒绝读 ledger。
            // 动作由当前公开状态决定：released 不动、preserved/cleanup-debt 走独立 release、
            // 只有 active 且 status 实时允许 discard 时才带一次性 token 调 dispose。
            const dispatched = results.find(entry => entry.toolName === "subagent_start" && (entry as any).details?.workspace_id) as any;
            cleanupWorkspace ??= dispatched?.details?.workspace_id;
            if (!cleanupWorkspace) throw new Error("normal dispose 缺 workspace handle");
            const observations = results.filter(entry => CLEANUP_WORKSPACE_TOOLS.includes(entry.toolName as string)) as any[];
            const lastObservation = observations.at(-1);
            // 除状态机自身的 MANAGED_WORKSPACE_STATE（观察与查询之间状态已变化）外，任何错误——
            // 越 owner、身份无效、缺终局证明、token 失效——都立即保留现场，不重试、不降级。
            const failureCode = lastObservation?.isError ? lastObservation?.details?.code : undefined;
            if (failureCode && failureCode !== "MANAGED_WORKSPACE_STATE") throw new Error(`public workspace 处置失败(${failureCode})；保留现场等待精确处置`);
            let retryObservation = false;
            if (lastObservation && !failureCode) {
              const observation = cleanupObservation(lastObservation, cleanupWorkspace);
              if (observation.state === "released") {
                // released 是终态，公开语义下无需任何处置动作，不得再发 release/dispose。
                output = "HEARTBEAT_FIXTURE_DISPOSED";
              } else if (CLEANUP_RELEASE_STATES.includes(observation.state)) {
                // preserved / cleanup-debt 是各自独立可执行的公开分支，不从 dispose 串联而来。
                tool = { name: "managed_workspace_release", arguments: { workspace_id: cleanupWorkspace } };
              } else if (observation.state === "active") {
                const fromStatus = lastObservation.toolName === "managed_workspace_status";
                // allowed_dispositions 对 active 恒含 release，不能单独用来决定动作；
                // 必须 active + 含 discard + 本次签发的一次性 action_token 三者同时成立。
                if (fromStatus && observation.allowed.includes("discard") && observation.token) {
                  tool = { name: "managed_workspace_dispose", arguments: { disposition: "discard", workspace_id: cleanupWorkspace, action_token: observation.token } };
                } else if (fromStatus) retryObservation = true; // 终局证明尚未落盘：只做有限次公开观察
                else tool = { name: "managed_workspace_status", arguments: { workspace_id: cleanupWorkspace } };
              } else if (CLEANUP_IN_FLIGHT_STATES.includes(observation.state)) {
                retryObservation = true; // 合法在途，有限次观察，不当作终态也不当作已释放
              } else {
                throw new Error(`public workspace 状态未知(${observation.state})；保留现场等待精确处置`);
              }
            } else if (failureCode === "MANAGED_WORKSPACE_STATE") {
              // 状态在观察与查询之间变化：按最新公开状态重新观察，不读 raw ledger。
              retryObservation = true;
            } else {
              // 首个清理回合：先用公开 list 定位本条 workspace 的当前状态。
              tool = { name: "managed_workspace_list", arguments: {} };
            }
            if (retryObservation) {
              if (observations.length >= CLEANUP_OBSERVATION_LIMIT) throw new Error("public workspace 处置观察预算耗尽；保留现场等待精确处置");
              await delay(CLEANUP_OBSERVATION_INTERVAL_MS, undefined, { signal: options?.signal });
              tool = { name: "managed_workspace_list", arguments: {} };
            }
          } else if (results.some(entry => entry.toolName === "subagent_start")) {
            if (results.some(entry => entry.toolName === "subagent_start" && entry.isError)) throw new Error("typed dispatch 失败");
            output = "HEARTBEAT_FIXTURE_DISPATCHED";
          } else {
            if (!userText.includes(PARENT_MARKER)) throw new Error("parent 收到非 fixture prompt");
            if (!getCurrentTools(messages).some(entry => entry.name === "subagent_start")) throw new Error("缺 typed subagent tool");
            tool = { name: "subagent_start", arguments: heartbeatContract(process.cwd()) };
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
