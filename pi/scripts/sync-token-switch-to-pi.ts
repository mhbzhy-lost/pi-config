#!/usr/bin/env node
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const modeUrl = /^http:\/\/(?:127\.0\.0\.1|localhost):15722\/opencode\/(mode-[A-Za-z0-9_-]+)\/v1\/?$/;
const configPath = process.env.OPENCODE_CONFIG || resolve(process.env.HOME || "~", ".config/opencode/opencode.json");
const modelsPath = process.env.PI_MODELS_CONFIG || resolve(import.meta.dirname, "../models.json");
const settingsPath = process.env.PI_SETTINGS_CONFIG || resolve(import.meta.dirname, "../settings.json");
const helperCommandPrefix = "!node \"$PI_CODING_AGENT_DIR/scripts/token-switch-api-key.ts\" ";
const formerHelperCommandPrefix = "!node \"$PI_CODING_AGENT_DIR/pi/scripts/token-switch-api-key.ts\" ";
const tokenSwitchUserAgent = "opencode/1.18.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function readJson(path: string, label: string): { value: JsonRecord; text: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    fail(`cannot read valid ${label}`);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) fail(`${label} must contain a JSON object`);
    return { value, text };
  } catch {
    fail(`cannot read valid ${label}`);
  }
}

function readableModelId(name: string): string {
  const id = name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!id) fail("Token Switch model name cannot produce a readable id");
  return id;
}

function shortModeSuffix(mode: string): string {
  return mode.replace(/^mode-/, "").slice(0, 8);
}

function modelFromConfig(value: unknown): JsonRecord {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name) fail("Token Switch model structure is invalid");
  const limit = value.limit;
  const modalities = value.modalities;
  if (!isRecord(limit) || !Number.isFinite(limit.context) || !Number.isFinite(limit.output) || !isRecord(modalities) || !Array.isArray(modalities.input) || !modalities.input.every(item => item === "text" || item === "image")) {
    fail("Token Switch model structure is invalid");
  }
  return {
    name: value.name,
    contextWindow: limit.context,
    maxTokens: limit.output,
    reasoning: value.reasoning === true,
    input: modalities.input
  };
}

function isManagedProvider(value: unknown): boolean {
  return isRecord(value)
    && value.api === "openai-completions"
    && typeof value.baseUrl === "string"
    && modeUrl.test(value.baseUrl)
    && typeof value.apiKey === "string"
    && (value.apiKey.startsWith(helperCommandPrefix) || value.apiKey.startsWith(formerHelperCommandPrefix));
}

function isManagedModelReference(value: string): boolean {
  return value.startsWith("tokenhub/") || value.startsWith("token-switch-mode-") || value.startsWith("token-switcher/") || /^token-switcher-\d+\//.test(value);
}

function temporaryPath(path: string): string {
  return resolve(dirname(path), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 临时文件不存在时无需处理。
  }
}

const opencode = readJson(configPath, "OpenCode configuration").value;
const providerEntries = isRecord(opencode.provider) ? Object.entries(opencode.provider) : fail("OpenCode provider structure is invalid");
const generated = new Map<string, JsonRecord>();
const generatedModels: Array<{ mode: string; model: JsonRecord }> = [];
const generatedModes = new Set<string>();

for (const [, provider] of providerEntries) {
  if (!isRecord(provider) || provider.npm !== "@ai-sdk/openai-compatible") continue;
  if (!isRecord(provider.options) || typeof provider.options.baseURL !== "string") continue;
  const matched = modeUrl.exec(provider.options.baseURL);
  if (!matched) continue;
  const [mode] = matched.slice(1);
  if (typeof provider.options.apiKey !== "string" || !provider.options.apiKey.trim()) fail("Token Switch mode is missing apiKey");
  if (!isRecord(provider.models)) fail("Token Switch provider structure is invalid");
  const providerId = generated.size === 0 ? "token-switcher" : `token-switcher-${generated.size}`;
  if (generatedModes.has(mode)) fail("duplicate Token Switch mode");
  const models = Object.entries(provider.models).map(([, model]) => modelFromConfig(model));
  if (models.length === 0) fail("Token Switch provider has no models");
  for (const model of models) generatedModels.push({ mode, model });
  generatedModes.add(mode);
  generated.set(providerId, {
    baseUrl: provider.options.baseURL,
    api: "openai-completions",
    apiKey: `${helperCommandPrefix}${mode}`,
    authHeader: true,
    headers: { "User-Agent": tokenSwitchUserAgent },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
    models
  });
}

if (generated.size === 0) fail("no Token Switch modes found");
if (resolve(modelsPath) === resolve(settingsPath)) fail("Pi models and settings configurations must differ");

const idCounts = new Map<string, number>();
for (const { model } of generatedModels) {
  const id = readableModelId(model.name as string);
  idCounts.set(id, (idCounts.get(id) || 0) + 1);
}
const assignedIds = new Set<string>();
for (const { mode, model } of generatedModels) {
  const id = readableModelId(model.name as string);
  let assignedId = id;
  let index = 2;
  if ((idCounts.get(id) || 0) > 1) {
    const suffix = shortModeSuffix(mode);
    assignedId = `${id}-${suffix}`;
  }
  while (assignedIds.has(assignedId)) assignedId = `${id}-${shortModeSuffix(mode)}-${index++}`;
  assignedIds.add(assignedId);
  model.id = assignedId;
  model.samplingParams = { model: mode };
}

const modelsSource = readJson(modelsPath, "Pi models configuration");
if (!isRecord(modelsSource.value.providers)) fail("Pi provider structure is invalid");
const providers: JsonRecord = { ...modelsSource.value.providers };
for (const [id, provider] of generated) {
  if (id in providers && !isManagedProvider(providers[id])) fail("Token Switch provider id conflicts with an existing provider");
  providers[id] = provider;
}
delete providers.tokenhub;
for (const [id, provider] of Object.entries(providers)) {
  if (!generated.has(id) && isManagedProvider(provider)) delete providers[id];
}

const settingsSource = readJson(settingsPath, "Pi settings configuration");
const existingEnabledModels = settingsSource.value.enabledModels;
if (existingEnabledModels !== undefined && (!Array.isArray(existingEnabledModels) || !existingEnabledModels.every(value => typeof value === "string"))) {
  fail("Pi settings enabledModels must be an array of strings");
}
const currentEnabledModels = [...generated.entries()].flatMap(([providerId, provider]) =>
  (provider.models as JsonRecord[]).map(model => `${providerId}/${model.id}`)
);
const enabledModels = (existingEnabledModels || []).filter(value => !isManagedModelReference(value as string));
enabledModels.push(...currentEnabledModels);

const modelsOutput = JSON.stringify({ ...modelsSource.value, providers }, null, 2) + "\n";
const settingsOutput = JSON.stringify({ ...settingsSource.value, enabledModels }, null, 2) + "\n";
const modelsTemporaryPath = temporaryPath(modelsPath);
const settingsTemporaryPath = temporaryPath(settingsPath);
let modelsReplaced = false;

try {
  writeFileSync(modelsTemporaryPath, modelsOutput, { encoding: "utf8", mode: 0o600 });
  writeFileSync(settingsTemporaryPath, settingsOutput, { encoding: "utf8", mode: 0o600 });
  renameSync(modelsTemporaryPath, modelsPath);
  modelsReplaced = true;
  renameSync(settingsTemporaryPath, settingsPath);
} catch {
  removeIfPresent(modelsTemporaryPath);
  removeIfPresent(settingsTemporaryPath);
  if (modelsReplaced) {
    const restorePath = temporaryPath(modelsPath);
    try {
      writeFileSync(restorePath, modelsSource.text, { encoding: "utf8", mode: 0o600 });
      renameSync(restorePath, modelsPath);
    } catch {
      removeIfPresent(restorePath);
    }
  }
  fail("cannot atomically update Pi configurations");
}

const summary = [...generated.entries()].map(([providerId, provider]) => ({ providerId, models: (provider.models as JsonRecord[]).map(model => ({ id: model.id, name: model.name })) }));
process.stdout.write(`Synced ${generated.size} Token Switch provider(s): ${JSON.stringify(summary)}\n`);
