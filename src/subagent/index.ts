import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagents from "pi-subagents";
import { createSubagentRenderer } from "./renderer.ts";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
const AGENT_NAME = "executor";
const MAX_TITLE_BYTES = 240;
const MAX_TASK_BYTES = 32 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024;
const RPC_TIMEOUT_MS = 60_000;
const AGENT_CATALOG_ALLOWLIST = new Set([AGENT_NAME]);
const AGENT_CATALOG_ROOT = join(import.meta.dirname, "..", "..", "pi", "agents");

type RpcReply = {
  version: number;
  requestId: string;
  success: boolean;
  data?: { text?: string; details?: unknown };
  error?: { code?: string; message?: string };
};

type RpcToolContext = {
  cwd: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
};

type RpcToolBuildContext = RpcToolContext & { modelRef?: string };

type AdvertisedAgent = {
  name: string;
  description: string;
  tools?: string[];
};

function frontmatter(content: string): Map<string, string> {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return new Map();
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return new Map();
  const fields = new Map<string, string>();
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]?.trim();
    if (value !== undefined) fields.set(match[1]!, value.replace(/^(['"])(.*)\1$/, "$2"));
  }
  return fields;
}

async function loadAdvertisedAgents(): Promise<readonly AdvertisedAgent[]> {
  let names: string[];
  try {
    names = await readdir(AGENT_CATALOG_ROOT);
  } catch {
    return [];
  }
  const agents: AdvertisedAgent[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const path = join(AGENT_CATALOG_ROOT, name);
    let fields: Map<string, string>;
    try { fields = frontmatter(await readFile(path, "utf8")); } catch { continue; }
    const agentName = fields.get("name");
    const description = fields.get("description");
    if (fields.get("advertise") !== "true" || !agentName || !description || !AGENT_CATALOG_ALLOWLIST.has(agentName)) continue;
    const tools = fields.get("tools")?.split(",").map((tool) => tool.trim()).filter(Boolean);
    agents.push({ name: agentName, description, ...(tools?.length ? { tools } : {}) });
  }
  return agents.sort((left, right) => left.name.localeCompare(right.name));
}

function formatAdvertisedAgents(agents: readonly AdvertisedAgent[]): string | undefined {
  if (agents.length === 0) return undefined;
  const lines = ["可用子代理（仅限本仓 RPC facade 暴露的 agent）："];
  for (const agent of agents) {
    lines.push(`- ${agent.name}：${agent.description}`);
    lines.push(`  调用：subagent_spawn({ title, task })`);
    if (agent.tools?.length) lines.push(`  工具：${agent.tools.join(", ")}`);
  }
  return lines.join("\n");
}

function callRpc(pi: ExtensionAPI, method: string, params: Record<string, unknown>): Promise<RpcReply> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const unsubscribe = pi.events.on(`${RPC_REPLY}${requestId}`, (value) => {
      const reply = value as RpcReply;
      if (reply?.version !== 1 || reply.requestId !== requestId || typeof reply.success !== "boolean") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(reply);
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`subagent RPC ${method} timed out (requestId=${requestId})`));
    }, RPC_TIMEOUT_MS);
    try {
      pi.events.emit(RPC_REQUEST, {
        version: 1,
        requestId,
        method,
        params,
      });
    } catch (error) {
      clearTimeout(timer);
      unsubscribe();
      reject(error);
    }
  });
}

function stringInput(input: unknown, key: string, maxBytes: number): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${key} 参数必须是字符串`);
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} 参数必须是非空字符串`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${key} 参数过长`);
  return value;
}

function toolParameters(required: string[], properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required, properties };
}

function rpcTool(pi: ExtensionAPI, name: string, method: string, description: string, parameters: Record<string, unknown>, buildParams: (input: unknown, ctx: RpcToolBuildContext) => Record<string, unknown>, prompt?: { snippet?: string; guidelines?: string[] }) {
  return {
    name,
    label: name,
    description,
    ...(prompt?.snippet !== undefined ? { promptSnippet: prompt.snippet } : {}),
    ...(prompt?.guidelines !== undefined ? { promptGuidelines: prompt.guidelines } : {}),
    parameters,
    exposure: "deferred" as const,
    defaultActive: false,
    async execute(_toolCallId: string, input: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: RpcToolContext) {
      const modelRef = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}${ctx.thinkingLevel ? `:${ctx.thinkingLevel}` : ""}`
        : undefined;
      const reply = await callRpc(pi, method, buildParams(input, { ...ctx, ...(modelRef ? { modelRef } : {}) }));
      if (!reply.success) throw new Error(`${reply.error?.code ?? "SUBAGENT_RPC_ERROR"}: ${reply.error?.message ?? `${method} failed`}`);
      return {
        content: [{ type: "text" as const, text: reply.data?.text ?? "" }],
        details: reply.data?.details ?? {},
      };
    },
  };
}

export function createMinimalSubagentExtension(pi: ExtensionAPI): void {
  pi.registerToolRenderer(createSubagentRenderer());
  // Upstream owns its lifecycle and RPC bridge; this integration exposes only our tool.
  const upstream = Object.create(pi) as ExtensionAPI;
  // 仅放行父侧 supervisor 回复工具：child 的 contact_supervisor 由 child runtime 钩子注入，
  // 不受 agent tools 白名单限制；child 发出 need_decision/interview_request 后会阻塞等待
  // 父会话通过 subagent_supervisor({ action: "reply" }) 回应（steer 不能替代 reply）。
  // 上游其余工具（subagent、subagents_enable、bg_wait、contact_supervisor 等）仍全部屏蔽，
  // 保持本集成的最小工具面。
  upstream.registerTool = (definition) => {
    if (definition?.name === "subagent_supervisor") pi.registerTool({ ...definition, exposure: "deferred", defaultActive: false });
  };
  upstream.registerCommand = () => {};
  upstream.registerShortcut = () => {};
  registerSubagents(upstream);

  pi.on("before_agent_start", async (event) => {
    const catalog = formatAdvertisedAgents(await loadAdvertisedAgents());
    if (catalog) event.systemPromptOptions.sections.advertised_subagents = catalog;
    else delete event.systemPromptOptions.sections.advertised_subagents;
  });

  pi.registerTool(rpcTool(
    pi,
    "subagent_spawn",
    "spawn",
    "异步派发一个 fresh context 的编码执行代理完成独立任务。用 title 概括任务目标，便于在面板中区分多个 executor。child 不继承本会话历史或项目上下文，可使用 read/write/edit/bash/grep/find/ls；只修改任务合同允许的范围。立即返回 runId，不阻塞等待结果；run 结束后会自动唤醒本会话送达结果，不要轮询 status 等待。task 必须自包含：child 看不到本会话历史与项目规范。后续用返回的 runId 调 status/steer/stop 管理。",
    toolParameters(["task"], {
      title: { type: "string", minLength: 1, maxLength: 80, description: "用于面板显示的简短任务标题，概括具体目标，不要重复 executor 或角色说明" },
      task: { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES, description: "委派给子代理的完整任务描述，需自包含（child 无本会话上下文）" },
    }),
    (input, ctx) => {
      if (input && typeof input === "object" && "title" in input) stringInput(input, "title", MAX_TITLE_BYTES);
      // title 保留在父会话的原始工具参数中供 TUI 读取，不改写任务或上游执行回执。
      return {
        agent: AGENT_NAME,
        task: stringInput(input, "task", MAX_TASK_BYTES),
        cwd: ctx.cwd,
        context: "fresh",
        async: true,
        mission: false,
        ...(ctx.modelRef ? { model: ctx.modelRef } : {}),
      };
    },
    {
      snippet: "异步派发编码执行代理完成独立任务；返回 runId，结果完成时自动唤醒本会话",
      guidelines: [
        "为 subagent_spawn 提供简短明确的 title，说明任务目标，便于区分多个 executor。",
        "subagent_spawn 派发的 run 结束后会自动唤醒本会话；不要循环调用 subagent_status 轮询等待结果。",
        "subagent_spawn 的 task 必须自包含：child 是 fresh context，看不到本会话历史与项目规范。",
      ],
    },
  ));
  pi.registerTool(rpcTool(
    pi,
    "subagent_status",
    "status",
    "查询一个已派发 run 的当前状态与输出。传入 spawn 返回的 runId。",
    toolParameters(["runId"], { runId: { type: "string", minLength: 1, maxLength: 256, description: "目标 run 的 id（spawn 返回）" } }),
    (input) => ({ runId: stringInput(input, "runId", 256) }),
    { snippet: "查询已派发 run 的状态与输出" },
  ));
  pi.registerTool(rpcTool(
    pi,
    "subagent_steer",
    "steer",
    "向一个仍在运行的 run 主动补充指示或纠偏，message 会在 child 当前步骤后并入其上下文。仅用于主动引导；child 通过 contact_supervisor 提问时必须用 subagent_supervisor 的 reply 回应，steer 不能替代 reply。",
    toolParameters(["runId", "message"], {
      runId: { type: "string", minLength: 1, maxLength: 256, description: "目标 run 的 id（spawn 返回）" },
      message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_BYTES, description: "补充给运行中 child 的指示或纠偏信息" },
    }),
    (input) => ({
      runId: stringInput(input, "runId", 256),
      message: stringInput(input, "message", MAX_MESSAGE_BYTES),
    }),
    {
      snippet: "向运行中的 run 主动补充指示或纠偏",
      guidelines: [
        "child 通过 contact_supervisor 提问时用 subagent_supervisor 的 reply 回应；subagent_steer 仅用于主动引导，不能替代 reply。",
      ],
    },
  ));
  pi.registerTool(rpcTool(
    pi,
    "subagent_stop",
    "stop",
    "请求终止一个 pending/running 的 run。回执仅代表受理（state=stopping），终止以后续 status 观测为准。",
    toolParameters(["runId"], { runId: { type: "string", minLength: 1, maxLength: 256, description: "目标 run 的 id（spawn 返回）" } }),
    (input) => ({ runId: stringInput(input, "runId", 256) }),
    { snippet: "请求终止 pending/running 的 run" },
  ));
  pi.registerTool(rpcTool(
    pi,
    "subagent_resume",
    "resume",
    "以一条新消息续跑一个已结束（complete/failed/stopped）的 run；续跑资格由上游校验，不满足会拒绝并说明原因。",
    toolParameters(["runId", "message"], {
      runId: { type: "string", minLength: 1, maxLength: 256, description: "目标 run 的 id（spawn 返回）" },
      message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_BYTES, description: "续跑时追加给 child 的新消息" },
    }),
    (input) => ({
      runId: stringInput(input, "runId", 256),
      message: stringInput(input, "message", MAX_MESSAGE_BYTES),
    }),
    { snippet: "以新消息续跑已结束的 run" },
  ));
}

export default createMinimalSubagentExtension;
