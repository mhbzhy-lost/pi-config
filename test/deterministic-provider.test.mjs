import assert from "node:assert/strict";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

import {
  decideDeterministicTurn,
  deterministicExecutorAcceptanceReport,
  deterministicExecutorCommand,
} from "./fixtures/deterministic-provider-state.mjs";

const { jiti } = await loadPiTestRuntime(import.meta.url);

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const toolResult = (toolName, text = "ok", details = {}) => ({ role: "toolResult", toolName, content: [{ type: "text", text }], details, isError: false });
const decide = (messages, toolNames) => decideDeterministicTurn({ messages, toolNames });

async function provider() {
  let registered;
  const fixture = await jiti.import("./fixtures/deterministic-provider.mjs");
  fixture.default({ registerProvider(_name, value) { registered = value; } });
  return registered;
}

async function done(messages, tools, definition) {
  definition ??= await provider();
  const model = { ...definition.models[0], api: definition.api, provider: "fake" };
  let completed;
  for await (const event of definition.streamSimple(model, { messages, tools: tools.map((name) => ({ name })) })) {
    if (event.type === "done") completed = event;
  }
  assert.ok(completed);
  return completed;
}

test("deterministic executor maps only declared fixture paths", () => {
  assert.match(deterministicExecutorCommand("Allowed paths: README.md"), /README\.md/);
  assert.match(deterministicExecutorCommand("Allowed paths: worker.txt"), /worker\.txt/);
  assert.equal(deterministicExecutorCommand("Allowed paths: arbitrary.txt"), undefined);
});

test("deterministic executor emits an exact acceptance report", () => {
  const prompt = "Allowed paths: worker.txt";
  const command = deterministicExecutorCommand(prompt);
  const source = deterministicExecutorAcceptanceReport(prompt, command);
  const report = JSON.parse(source.match(/```acceptance-report\n([\s\S]+)\n```/)[1]);
  assert.deepEqual(report.changedFiles, ["worker.txt"]);
  assert.deepEqual(report.commandsRun, [{ command, result: "passed", summary: "completed" }]);
  assert.equal(deterministicExecutorAcceptanceReport(prompt, "other"), undefined);
});

test("compatibility child completes or requests one supervisor decision", () => {
  assert.deepEqual(decide([user("PI_SUBAGENTS_COMPAT_CHILD_COMPLETE")], ["read"]), { text: "COMPAT_OK tools=read" });
  assert.deepEqual(decide([user("PI_SUBAGENTS_COMPAT_CHILD_ATTENTION")], ["contact_supervisor", "read"]), {
    tool: { name: "contact_supervisor", arguments: { reason: "need_decision", message: "Approve compatibility probe" } },
  });
  assert.deepEqual(decide([
    user("PI_SUBAGENTS_COMPAT_CHILD_ATTENTION"),
    toolResult("contact_supervisor", "APPROVED"),
  ], ["contact_supervisor", "read"]), { text: "COMPAT_OK tools=contact_supervisor,read" });
});

test("compatibility completion parent spawns, waits, then stops", () => {
  const prompt = user("PI_SUBAGENTS_COMPAT_PARENT_COMPLETE");
  assert.deepEqual(decide([prompt], ["compat_spawn", "bg_wait"]), { tool: { name: "compat_spawn", arguments: { mode: "complete" } } });
  assert.deepEqual(decide([prompt, toolResult("compat_spawn")], ["compat_spawn", "bg_wait"]), { tool: { name: "bg_wait", arguments: { all: true, timeoutMs: 30000 } } });
  assert.deepEqual(decide([prompt, toolResult("compat_spawn"), toolResult("bg_wait")], ["compat_spawn", "bg_wait"]), { text: "COMPAT_PARENT_DONE" });
});

test("compatibility attention parent follows status and exact pending request", () => {
  const prompt = user("PI_SUBAGENTS_COMPAT_PARENT_ATTENTION");
  const tools = ["compat_spawn", "compat_status", "compat_inspect_nested_events", "compat_pause", "subagent_supervisor", "bg_wait"];
  const started = [prompt, toolResult("compat_spawn")];
  assert.deepEqual(decide(started, tools), { tool: { name: "compat_status", arguments: {} } });
  const observed = [...started, toolResult("compat_status")];
  assert.deepEqual(decide(observed, tools), { tool: { name: "compat_inspect_nested_events", arguments: {} } });
  const inspected = [...observed, toolResult("compat_inspect_nested_events")];
  assert.deepEqual(decide(inspected, tools), { tool: { name: "compat_pause", arguments: {} } });
  const polling = [...inspected, toolResult("compat_pause"), toolResult("subagent_supervisor", "none", { pending: [] })];
  assert.deepEqual(decide(polling, tools), { tool: { name: "compat_pause", arguments: {} } });
  const pending = [...polling, toolResult("subagent_supervisor", "pending", { pending: [{ id: "request-1" }] })];
  assert.deepEqual(decide(pending, tools), { tool: { name: "subagent_supervisor", arguments: { action: "reply", replyTo: "request-1", message: "APPROVED" } } });
});

test("provider streams generic compatibility tool calls", async () => {
  const completed = await done([user("PI_SUBAGENTS_COMPAT_PARENT_COMPLETE")], ["compat_spawn", "bg_wait"]);
  assert.equal(completed.message.stopReason, "toolUse");
  assert.deepEqual(completed.message.content[0].name, "compat_spawn");
  assert.deepEqual(completed.message.content[0].arguments, { mode: "complete" });
});

test("provider runs a declared deterministic executor command once", async () => {
  const definition = await provider();
  const first = await done([user("Allowed paths: README.md")], ["bash"], definition);
  assert.equal(first.message.content[0].name, "bash");
  const second = await done([
    user("Allowed paths: README.md"),
    toolResult("bash", "done", { exitCode: 0 }),
  ], ["bash"], definition);
  assert.equal(second.message.stopReason, "stop");
  assert.match(second.message.content[0].text, /acceptance-report/);
});
