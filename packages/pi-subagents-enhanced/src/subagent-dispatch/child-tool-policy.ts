import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";

type ChildToolCeiling = Readonly<{ allowedTools: readonly string[]; allowedAgents?: readonly string[] }>;
const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/u;
const AGENT_NAME = /^[A-Za-z0-9_.:-]+$/u;

function list(value: unknown, pattern: RegExp, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || !pattern.test(item.trim()))) throw new Error(`childToolCeiling.${name} must be an array of valid names`);
  return [...new Set(value.map((item) => item.trim()))].sort();
}

export function loadChildToolCeilingConfig(agentDir: string): ChildToolCeiling | undefined {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(agentDir, "extensions", "subagent", "config.json"), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw new Error(`Cannot load childToolCeiling config: ${error instanceof Error ? error.message : String(error)}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("subagent config must be an object");
  const value = (raw as { childToolCeiling?: unknown }).childToolCeiling;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("childToolCeiling must be an object");
  if (Object.keys(value).some((key) => key !== "allowedTools" && key !== "allowedAgents")) throw new Error("childToolCeiling contains an unknown field");
  if (!Object.hasOwn(value, "allowedTools")) throw new Error("childToolCeiling.allowedTools is required");
  const fields = value as Record<string, unknown>;
  return Object.freeze({ allowedTools: list(fields.allowedTools, TOOL_NAME, "allowedTools"), ...(fields.allowedAgents === undefined ? {} : { allowedAgents: list(fields.allowedAgents, AGENT_NAME, "allowedAgents") }) });
}

export function registerConfiguredChildToolCeiling(input: { agentDir: string; sessionId: string; register?: typeof registerSubagentCapabilityCeiling }) {
  const config = loadChildToolCeilingConfig(input.agentDir);
  if (config === undefined) return undefined;
  if (typeof input.sessionId !== "string" || !input.sessionId.trim()) throw new Error("childToolCeiling requires a session id");
  return (input.register ?? registerSubagentCapabilityCeiling)({ sessionId: input.sessionId, source: "typed-subagent-runtime", ceiling: config });
}
