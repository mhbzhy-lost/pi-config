import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getRuntimeStatus, listRuntimeInstances, resolveScope, sendRuntimeCommand, startRuntime, stopRuntime } from "./runtime/lifecycle.ts";
import type { Command, RuntimeOptions } from "./runtime/contracts.ts";
import { guidance } from "./docs.ts";

const commandSchema = Type.Record(Type.String(), Type.Unknown(), { description: "Playwright 安全命令对象，例如 {op:'navigate',url:'https://example.com'}" });
const parameters = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("command"), Type.Literal("status"), Type.Literal("stop"), Type.Literal("instances")], { description: "浏览器生命周期或安全操作" }),
  instance: Type.Optional(Type.String({ description: "实例名；除 instances 外必填，只允许小写字母、数字和连字符" })),
  profile: Type.Optional(Type.String({ description: "可选的安全 profile 名称，仅 start 使用" })),
  headed: Type.Optional(Type.Boolean({ description: "是否显示前台 Chrome；默认 headless，只有用户明确要求时使用" })),
  auth: Type.Optional(Type.Boolean({ description: "是否进入手动认证模式；认证模式限制页面操作" })),
  command: Type.Optional(commandSchema),
}, { additionalProperties: false });

function instanceRequired(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("browser action 需要 instance");
  return value;
}

async function runBrowser(input: { action: string; instance?: string; profile?: string; headed?: boolean; auth?: boolean; command?: Record<string, unknown> }): Promise<unknown> {
  const scope = await resolveScope();
  if (input.action === "instances") return listRuntimeInstances(scope);
  const instance = instanceRequired(input.instance);
  const ref = { scope, instance };
  if (input.action === "start") {
    const idleSeconds = process.env.PI_PLAYWRIGHT_IDLE_TIMEOUT === undefined ? 1800 : Number(process.env.PI_PLAYWRIGHT_IDLE_TIMEOUT);
    const options: RuntimeOptions = { instance, profile: input.profile, headless: input.headed !== true, channel: "chrome", authMode: input.auth === true, startupTimeoutMs: 30_000, idleTimeoutMs: idleSeconds * 1000 };
    return startRuntime(scope, options);
  }
  if (input.action === "status") return getRuntimeStatus(ref);
  if (input.action === "stop") return stopRuntime(ref);
  if (input.action === "command") {
    if (!input.command) throw new Error("browser command action 需要 command");
    return sendRuntimeCommand(ref, input.command as Command);
  }
  throw new Error("未知 browser action");
}

export const browserTool = defineTool({
  name: "browser",
  label: "browser",
  description: `使用本地系统 Chrome 执行受限 Playwright 浏览器操作。支持 start/command/status/stop/instances；默认 headless，禁止任意 evaluate、凭据读取和密码输入。需要先 start，再用 command 执行 navigate、snapshot、click、fill、wait、screenshot、tabs 或 inspect。

以下是该工具的完整使用说明；实际调用请使用本工具的 action/参数：

${guidance}`,
  promptSnippet: "按需加载受限 Playwright 浏览器工具",
  promptGuidelines: [
    "需要浏览器 UI、网页交互或 E2E 操作时使用 browser；先 start 一个自己拥有的 instance。",
    "普通任务保持 headless；只有用户明确要求前台或手动登录时才使用 headed/auth。",
    "browser 只接受安全命令对象，不支持任意 evaluate/run-file，也不输出 cookie、token、密码或授权材料。",
    "等待页面状态使用 command op=wait，不使用同步阻塞或 sleep。",
  ],
  parameters,
  exposure: "deferred",
  defaultActive: false,
  async execute(_toolCallId, input) {
    const result = await runBrowser(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as any,
      details: { provider: "playwright", action: input.action, instance: input.instance },
    };
  },
});
