#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const modeUrl = /^http:\/\/(?:127\.0\.0\.1|localhost):15722\/opencode\/(mode-[A-Za-z0-9_-]+)\/v1\/?$/;
const configPath = process.env.OPENCODE_CONFIG || resolve(process.env.HOME || "~", ".config/opencode/opencode.json");
const requestedMode = process.argv[2];

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(): never {
  process.stderr.write("Error: Token Switch credential is unavailable\n");
  process.exit(1);
}

if (typeof requestedMode !== "string" || !/^mode-[A-Za-z0-9_-]+$/.test(requestedMode) || process.argv.length !== 3) fail();

let config: unknown;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  fail();
}
if (!isRecord(config) || !isRecord(config.provider)) fail();

const matches = Object.values(config.provider).filter(provider => {
  if (!isRecord(provider) || provider.npm !== "@ai-sdk/openai-compatible" || !isRecord(provider.options)) return false;
  return typeof provider.options.baseURL === "string" && modeUrl.exec(provider.options.baseURL)?.[1] === requestedMode;
});
if (matches.length !== 1 || !isRecord(matches[0].options) || typeof matches[0].options.apiKey !== "string" || !matches[0].options.apiKey.trim()) fail();
process.stdout.write(`${matches[0].options.apiKey}\n`);
