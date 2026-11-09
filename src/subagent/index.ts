import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagents from "pi-subagents";
import { registerAgent } from "pi-subagents/agents";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
const AGENT_NAME = "minimal-generic";
const MAX_TASK_BYTES = 32 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_SKILLS = 32;
const MAX_SKILL_NAME_BYTES = 256;
const RPC_TIMEOUT_MS = 60_000;

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

function skillListInput(input: unknown): string[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("skills 参数必须是字符串数组");
  const value = (input as Record<string, unknown>).skills;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SKILLS) throw new Error("skills 参数必须是最多 32 项的字符串数组");
  const skills = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`skills[${index}] 必须是非空字符串`);
    const skill = entry.trim();
    if (Buffer.byteLength(skill, "utf8") > MAX_SKILL_NAME_BYTES) throw new Error(`skills[${index}] 参数过长`);
    return skill;
  });
  if (new Set(skills).size !== skills.length) throw new Error("skills 参数不能包含重复名称");
  return skills;
}

function rpcTool(pi: ExtensionAPI, name: string, method: string, description: string, parameters: Record<string, unknown>, buildParams: (input: unknown, ctx: RpcToolBuildContext) => Record<string, unknown>, prompt?: { snippet?: string; guidelines?: string[] }) {
  return {
    name,
    label: name,
    description,
    ...(prompt?.snippet !== undefined ? { promptSnippet: prompt.snippet } : {}),
    ...(prompt?.guidelines !== undefined ? { promptGuidelines: prompt.guidelines } : {}),
    parameters,
    exposure: "model-only" as const,
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
  // Upstream owns its lifecycle and RPC bridge; this integration exposes only our tool.
  const upstream = Object.create(pi) as ExtensionAPI;
  // 仅放行父侧 supervisor 回复工具：child 的 contact_supervisor 由 child runtime 钩子注入，
  // 不受 agent tools 白名单限制；child 发出 need_decision/interview_request 后会阻塞等待
  // 父会话通过 subagent_supervisor({ action: "reply" }) 回应（steer 不能替代 reply）。
  // 上游其余工具（subagent、subagents_enable、bg_wait、contact_supervisor 等）仍全部屏蔽，
  // 保持本集成的最小工具面。
  upstream.registerTool = (definition) => {
    if (definition?.name === "subagent_supervisor") pi.registerTool(definition);
  };
  upstream.registerCommand = () => {};
  upstream.registerShortcut = () => {};
  registerSubagents(upstream);

  registerAgent({
    pi: upstream,
    name: AGENT_NAME,
    definition: {
      description: "Read-only generic subagent",
      systemPrompt: "Execute the assigned task using the available read-only tools. Return the result directly.",
      systemPromptMode: "append",
      model: "inherit",
      tools: ["read", "grep", "find", "ls"],
      inheritProjectContext: false,
      inheritGlobalContext: false,
      inheritSkills: false,
      extensions: [],
      allowNestedSubagents: false,
    },
  });

  pi.registerTool(rpcTool(
    pi,
    "subagent_spawn",
    "spawn",
    "异步派发一个只读子代理执行独立任务。child 为 fresh context 的只读代理（仅 read/grep/find/ls），不继承项目上下文与任何 skill，继承当前模型。立即返回 runId，不阻塞等待结果；run 结束后会自动唤醒本会话送达结果，不要轮询 status 等待。task 必须自包含：child 看不到本会话历史与项目规范。skills 可选，用于显式注入 child 需要的 skill。后续用返回的 runId 调 status/steer/stop 管理。",
    toolParameters(["task"], {
      task: { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES, description: "委派给子代理的完整任务描述，需自包含（child 无本会话上下文）" },
      skills: { type: "array", maxItems: MAX_SKILLS, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: MAX_SKILL_NAME_BYTES }, description: "可选：显式注入 child 的 skill 名称列表，默认不继承任何 skill" },
    }),
    (input, ctx) => ({
      agent: AGENT_NAME,
      task: stringInput(input, "task", MAX_TASK_BYTES),
      cwd: ctx.cwd,
      context: "fresh",
      async: true,
      mission: false,
      ...(ctx.modelRef ? { model: ctx.modelRef } : {}),
      ...(() => {
        const skills = skillListInput(input);
        return skills === undefined ? {} : { skill: skills };
      })(),
    }),
    {
      snippet: "异步派发只读子代理执行独立任务；返回 runId，结果完成时自动唤醒本会话",
      guidelines: [
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
