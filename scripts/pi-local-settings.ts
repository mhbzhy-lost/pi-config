#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const LOCAL_FIELDS = new Set(["enabledModels", "defaultProvider", "defaultModel", "defaultThinkingLevel", "theme", "packages"]);

type LocalSettings = {
  enabledModels?: unknown;
  defaultProvider?: unknown;
  defaultModel?: unknown;
  defaultThinkingLevel?: unknown;
  theme?: unknown;
  packages?: unknown;
};

function fail(message: string): never {
  throw new Error(`pi/settings.local.json ${message}`);
}

function stringField(settings: LocalSettings, field: keyof LocalSettings): string | undefined {
  const value = settings[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) fail(`${field} 必须是非空单行字符串`);
  return value;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export async function localSettingsArgs(settings: LocalSettings, cliArgs: readonly string[], settingsPath = "pi/settings.local.json"): Promise<string[]> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) fail("必须是 JSON 对象");
  for (const key of Object.keys(settings)) if (!LOCAL_FIELDS.has(key)) fail(`包含不支持的字段 ${key}`);

  const enabledModels = settings.enabledModels;
  if (enabledModels !== undefined && (!Array.isArray(enabledModels) || enabledModels.length === 0 || enabledModels.some((value) => typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)))) {
    fail("enabledModels 必须是非空字符串数组");
  }
  const provider = stringField(settings, "defaultProvider");
  const model = stringField(settings, "defaultModel");
  const thinking = stringField(settings, "defaultThinkingLevel");
  const theme = stringField(settings, "theme");
  const packages = settings.packages;
  if (packages !== undefined && (!Array.isArray(packages) || packages.some((value) => typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)))) fail("packages 必须是字符串数组");
  if (thinking && !THINKING_LEVELS.has(thinking)) fail(`defaultThinkingLevel 无效：${thinking}`);
  if (provider && !model) fail("设置 defaultProvider 时必须同时设置 defaultModel");

  const result: string[] = [];
  for (const packagePath of (packages as string[] | undefined) ?? []) {
    const absolutePath = resolve(dirname(settingsPath), packagePath);
    try { await access(absolutePath); } catch { continue; }
    result.push("--extension", absolutePath);
  }
  if (enabledModels !== undefined && !hasFlag(cliArgs, "--models")) result.push("--models", (enabledModels as string[]).join(","));
  if (provider && model && !hasFlag(cliArgs, "--provider") && !hasFlag(cliArgs, "--model")) result.push("--provider", provider, "--model", model);
  else if (model && !hasFlag(cliArgs, "--model")) result.push("--model", model);
  if (thinking && !hasFlag(cliArgs, "--thinking")) result.push("--thinking", thinking);
  if (theme && !hasFlag(cliArgs, "--use-theme")) result.push("--use-theme", theme);
  return result;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const [settingsPath, ...cliArgs] = process.argv.slice(2);
  if (!settingsPath) fail("缺少文件路径");
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as LocalSettings;
    process.stdout.write(`${(await localSettingsArgs(settings, cliArgs, settingsPath)).join("\n")}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") process.exit(0);
    throw error;
  }
}
