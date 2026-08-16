import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function host(cwd) { return { registries: runtimeRegistries, captureCurrentWorld() { return { safe: true, repo: { head: git(cwd, "rev-parse", "HEAD") }, resources: [], activeRuns: [], capturedAt: new Date().toISOString() }; } }; }
function pi(cwd, entries = []) { const tools = [], handlers = new Map(), manager = { getSessionId: () => "owner", getSessionFile: () => join(cwd, "session"), getLeafId: () => "leaf", getEntries: () => entries }; return { tools, entries, handlers, sessionManager: manager, registerTool: tool => tools.push(tool), on: (name, handler) => handlers.set(name, handler), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) }; }
async function invoke(api, name, input) { const result = await api.tools.find(tool => tool.name === name).execute("call", input, undefined, undefined, { cwd: api.cwd, sessionManager: api.sessionManager }); return result.details.value; }

test("runtime init is draft-only, records readiness, and retains progress checkpoints", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "r10a1-")); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test"); writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init");
  const api = pi(cwd); api.cwd = cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd) });
  assert.deepEqual(api.tools.map(tool => tool.name).sort(), ["goal_accept", "goal_amend", "goal_dispatch", "goal_finalize", "goal_init", "goal_integrate", "goal_settle", "goal_status"]);
  const initialized = JSON.parse(await invoke(api, "goal_init", runtimeInit())); assert.equal(initialized.runtimeState, "awaiting_user_approval");
  const first = JSON.parse(await invoke(api, "goal_status", {})); assert.deepEqual(first.choices, ["approve", "reject"]); assert.equal(api.entries.filter(entry => entry.customType === "goal-engine-runtime-approval-challenge").length, 1);
  const second = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(second.proposalId, first.proposalId); assert.equal(api.entries.filter(entry => entry.customType === "goal-engine-runtime-approval-challenge").length, 1);
});


test("runtime approval consumes only exact real input and restores challenge identity", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "r10a1-")); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test"); writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init");
  const api = pi(cwd); api.cwd = cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd) }); await invoke(api, "goal_init", runtimeInit());
  const pending = JSON.parse(await invoke(api, "goal_status", {})); api.handlers.get("input")({ source: "interactive", text: "approve", entryId: "entry-1" }, { sessionManager: api.sessionManager });
  const challenge = api.entries.find(entry => entry.customType === "goal-engine-runtime-approval-challenge").data, decision = api.entries.find(entry => entry.customType === "goal-engine-runtime-approval-decision").data; assert.equal(decision.id, challenge.id); assert.ok(decision.receiptId); assert.equal(decision.proposalHash, pending.proposalHash);
  const reloaded = pi(cwd, api.entries); reloaded.cwd = cwd; createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: host(cwd) }); reloaded.handlers.get("session_start")({}, { sessionManager: reloaded.sessionManager });
  const status = JSON.parse(await invoke(reloaded, "goal_status", {})); assert.equal(status.runtimeState, "calibrating"); assert.equal(status.pendingHumanDecision, undefined);
});
