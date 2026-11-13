import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { guidance } from "./docs.ts";

const runFile = promisify(execFile);
const runtimePath = fileURLToPath(new URL("./runtime/resign_ios_ipa.py", import.meta.url));
const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("inventory"),
    Type.Literal("resign"),
    Type.Literal("install"),
    Type.Literal("prepare-profile"),
  ], { description: "只读清单、重签、安装已验证产物或准备描述文件修复工程" }),
  ipa: Type.Optional(Type.String({ description: "输入 IPA 路径，仅 resign 使用" })),
  personalMinimal: Type.Optional(Type.Boolean({ description: "已获得授权采用最小个人开发签名方案；resign 必须显式为 true" })),
  stripExtensions: Type.Optional(Type.Boolean({ description: "已获得授权移除不兼容的标准嵌入扩展" })),
  profile: Type.Optional(Type.String({ description: "已有 mobileprovision 路径" })),
  bundleId: Type.Optional(Type.String({ description: "显式目标 Bundle ID" })),
  team: Type.Optional(Type.String({ description: "显式 Team ID" })),
  identity: Type.Optional(Type.String({ description: "已有钥匙串和 profile 中的证书 SHA1" })),
  device: Type.Optional(Type.String({ description: "唯一 CoreDevice ID、UDID 或设备名" })),
  output: Type.Optional(Type.String({ description: "新 IPA 输出路径；不能覆盖已有文件或输入文件" })),
  workRoot: Type.Optional(Type.String({ description: "证据和工作目录的父目录" })),
  result: Type.Optional(Type.String({ description: "此前验证成功的 result.json 路径，仅 install 使用" })),
  install: Type.Optional(Type.Boolean({ description: "重签成功后安装到指定设备" })),
  replace: Type.Optional(Type.Boolean({ description: "已明确授权覆盖同标识的现有设备 App" })),
  inspectOnly: Type.Optional(Type.Boolean({ description: "只检查输入包和签名材料，不修改或安装" })),
}, { additionalProperties: false });

type Input = {
  action: "inventory" | "resign" | "install" | "prepare-profile";
  ipa?: string; personalMinimal?: boolean; stripExtensions?: boolean; profile?: string;
  bundleId?: string; team?: string; identity?: string; device?: string; output?: string;
  workRoot?: string; result?: string; install?: boolean; replace?: boolean; inspectOnly?: boolean;
};

function required(input: Input, key: keyof Input): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${String(key)} 参数必须是非空路径或标识`);
  return value;
}

function append(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) args.push(flag, value);
}

function buildArgs(input: Input): string[] {
  const args = [runtimePath, input.action];
  if (input.action === "inventory") {
    append(args, "--device", input.device);
    append(args, "--work-root", input.workRoot);
  } else if (input.action === "resign") {
    append(args, "--ipa", required(input, "ipa"));
    if (input.personalMinimal !== true) throw new Error("resign 必须显式确认 personalMinimal=true");
    args.push("--personal-minimal");
    if (input.stripExtensions === true) args.push("--strip-extensions");
    append(args, "--profile", input.profile);
    append(args, "--bundle-id", input.bundleId);
    append(args, "--team", input.team);
    append(args, "--identity", input.identity);
    append(args, "--device", input.device);
    append(args, "--output", input.output);
    append(args, "--work-root", input.workRoot);
    if (input.install === true) args.push("--install");
    if (input.replace === true) args.push("--replace");
    if (input.inspectOnly === true) args.push("--inspect-only");
  } else if (input.action === "install") {
    append(args, "--result", required(input, "result"));
    append(args, "--device", required(input, "device"));
    if (input.replace === true) args.push("--replace");
  } else {
    append(args, "--profile", required(input, "profile"));
    append(args, "--device", required(input, "device"));
    append(args, "--work-root", input.workRoot);
  }
  return args;
}

export const resignIpaTool = defineTool({
  name: "resign_ios_ipa",
  label: "resign_ios_ipa",
  description: `使用本机已有 Apple Development 身份安全重签 IPA、验证签名、准备 profile 修复工程，或安装此前已验证的产物。所有副作用必须由 action 和显式参数选择；不导出私钥、不登录账号、不自动注册设备、不自动删除 App。\n\n以下是完整操作说明：\n\n${guidance}`,
  promptSnippet: "按需加载 iOS IPA 重签与安装工具",
  promptGuidelines: [
    "先确认用户对个人签名、裁剪扩展、安装、覆盖和删除等具体副作用的授权；没有授权时只做 inventory 或 inspectOnly。",
    "不猜测证书、profile、设备或 Bundle ID；候选不唯一时停止并要求显式参数。",
    "安装成功、应用启动和业务正常是不同结果；只报告工具实际验证到的阶段。",
  ],
  parameters,
  exposure: "deferred",
  defaultActive: false,
  async execute(_toolCallId, input) {
    const args = buildArgs(input as Input);
    try {
      const result = await runFile(process.env.PI_PYTHON ?? "python3", args, { timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 });
      const text = result.stdout.trim();
      return { content: [{ type: "text", text }], details: { action: input.action, exitCode: 0 } };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
      const text = typeof failure.stdout === "string" && failure.stdout.trim()
        ? failure.stdout.trim()
        : JSON.stringify({ status: "blocked", reason: "resign_ios_ipa execution failed", exitCode: failure.code ?? null });
      return { content: [{ type: "text", text }], details: { action: input.action, exitCode: failure.code ?? null }, isError: true };
    }
  },
});
