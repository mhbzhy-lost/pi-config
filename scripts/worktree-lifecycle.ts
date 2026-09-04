#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { applyManagedWorkspaceCleanup, inventoryManagedWorkspaces, planManagedWorkspaceCleanup } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
const DEFAULT_STATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../var/workspaces");
const SCHEMAS = {
  audit: { flags: new Set(["json"]), values: new Set() },
  reconcile: { flags: new Set(["json", "apply", "authorization-stdin"]), values: new Set() },
};
function usage(message) { const error = new Error(message); error.code = "WORKTREE_LIFECYCLE_CLI_USAGE"; throw error; }
function parseCommand(argv) {
  const first = argv[0]; const command = !first || first.startsWith("-") ? "audit" : first; const schema = SCHEMAS[command];
  if (!schema) usage(`Unknown command: ${command}`);
  const tokens = command === "audit" && first?.startsWith("-") ? argv : argv.slice(1); const values = Object.create(null); const flags = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]; if (!token.startsWith("--")) usage(`Unexpected value: ${token}`);
    if (token.includes("=")) usage(`Option values must use a separate argument: ${token}`);
    const name = token.slice(2); if (!schema.flags.has(name) && !schema.values.has(name)) usage(`Unknown or irrelevant option: ${token}`);
    if (flags.has(name)) usage(`Duplicate ${token}`); flags.add(name);
    if (schema.values.has(name)) { const value = tokens[++index]; if (value === undefined || value === "" || value.startsWith("--")) usage(`Missing --${name}`); values[name] = value; }
  }
  for (const name of schema.values) if (values[name] === undefined) usage(`Missing --${name}`);
  if (command === "reconcile" && flags.has("apply") && !flags.has("authorization-stdin")) usage("--apply requires --authorization-stdin");
  if (command === "reconcile" && flags.has("authorization-stdin") && !flags.has("apply")) usage("--authorization-stdin requires --apply");
  return { command, json: flags.has("json"), apply: flags.has("apply"), values };
}
async function readStdin() { return await new Promise((resolveInput, reject) => { let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => resolveInput(input.trim())); process.stdin.on("error", reject); }); }
async function readApplyPayload() { const source = await readStdin(); let value; try { value = JSON.parse(source); } catch { usage("authorization stdin must be valid JSON"); } if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "plan") || !Object.hasOwn(value, "authorizations")) usage("authorization stdin must contain exactly plan and authorizations"); return value; }
function escapeSingleLine(value) { return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => { const escapes = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" }; return escapes[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`; }); }
function withoutOwnerToken(value) {
  if (Array.isArray(value)) return value.map(withoutOwnerToken);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "ownerToken").map(([key, child]) => [key, withoutOwnerToken(child)]));
}
function print(value, json) {
  const safeValue = withoutOwnerToken(value);
  if (json) return console.log(JSON.stringify(safeValue));
  if (safeValue?.schemaVersion === "managed-workspace-inventory.v1") {
    for (const entry of safeValue.workspaces) console.log(`${entry.receipt.state}\t${escapeSingleLine(entry.receipt.path)}\t${entry.identity === false ? "identity-mismatch" : entry.issues.join(",") || "none"}`);
    for (const entry of safeValue.orphanRegistrations) console.log(`orphan-registration\t${escapeSingleLine(entry.path)}\tnone`);
    for (const entry of safeValue.legacy) console.log(`${entry.status}\t${escapeSingleLine(entry.path)}\tnone`);
    return;
  }
  if (safeValue?.schemaVersion === "managed-workspace-cleanup-plan.v1") {
    for (const action of safeValue.actions) console.log(`${action.action}\t${action.workspaceId}\t${action.leaseId}`);
    return;
  }
  const items = Array.isArray(safeValue) ? safeValue : safeValue?.items;
  if (items) { for (const fact of items) console.log(`${fact?.state ?? "unknown"}\t${escapeSingleLine(fact?.path ?? fact?.registration?.path)}\t${fact?.automaticAction ?? "none"}`); return; }
  console.log(`${safeValue?.state ?? "unknown"}\t${safeValue?.workspaceId ?? safeValue?.id ?? ""}\t${escapeSingleLine(safeValue?.path)}`);
}
const parsed = (() => { try { return parseCommand(process.argv.slice(2)); } catch (error) { console.error(`${error.code || "WORKTREE_LIFECYCLE_ERROR"}: ${error.message}`); process.exitCode = error.code === "WORKTREE_LIFECYCLE_CLI_USAGE" ? 2 : 1; return null; } })();
if (parsed) {
  try {
    const { command, json, apply } = parsed; const originRoot = process.cwd(); const stateRoot = process.env.PI_CODING_WORKSPACE_DIR ?? DEFAULT_STATE_ROOT;
    if (command === "audit") print(inventoryManagedWorkspaces({ stateRoot, originRoot }), json);
    else if (command === "reconcile") { if (!apply) print(planManagedWorkspaceCleanup({ stateRoot, originRoot }), json); else { const { plan, authorizations } = await readApplyPayload(); print(applyManagedWorkspaceCleanup({ stateRoot, plan, authorizations }), json); } }
    else usage(`Unknown command: ${command}`);
  } catch (error) { console.error(`${error.code || "WORKTREE_LIFECYCLE_ERROR"}: ${error.message}`); process.exitCode = 1; }
}
