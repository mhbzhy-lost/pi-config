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

function rpcTool(pi: ExtensionAPI, name: string, method: string, parameters: Record<string, unknown>, buildParams: (input: unknown, ctx: RpcToolBuildContext) => Record<string, unknown>) {
  return {
    name,
    label: name,
    description: `透传到 pi-subagents RPC ${method}。`,
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
  upstream.registerTool = () => {};
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
    toolParameters(["task"], {
      task: { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES },
      skills: { type: "array", maxItems: MAX_SKILLS, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: MAX_SKILL_NAME_BYTES } },
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
  ));
  pi.registerTool(rpcTool(
    pi,
    "subagent_status",
    "status",
    toolParameters(["runId"], { runId: { type: "string", minLength: 1, maxLength: 256 } }),
    (input) => ({ runId: stringInput(input, "runId", 256) }),
  ));
  pi.registerTool(rpcTool(
    pi,
    "subagent_steer",
    "steer",
    toolParameters(["runId", "message"], {
      runId: { type: "string", minLength: 1, maxLength: 256 },
      message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_BYTES },
    }),
    (input) => ({
      runId: stringInput(input, "runId", 256),
      message: stringInput(input, "message", MAX_MESSAGE_BYTES),
    }),
  ));
  pi.registerTool(rpcTool(
    pi,
    "subagent_stop",
    "stop",
    toolParameters(["runId"], { runId: { type: "string", minLength: 1, maxLength: 256 } }),
    (input) => ({ runId: stringInput(input, "runId", 256) }),
  ));
  pi.registerTool(rpcTool(
    pi,
    "subagent_resume",
    "resume",
    toolParameters(["runId", "message"], {
      runId: { type: "string", minLength: 1, maxLength: 256 },
      message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_BYTES },
    }),
    (input) => ({
      runId: stringInput(input, "runId", 256),
      message: stringInput(input, "message", MAX_MESSAGE_BYTES),
    }),
  ));
}

export default createMinimalSubagentExtension;
