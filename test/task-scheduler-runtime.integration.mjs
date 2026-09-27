import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { registerTaskSchedulerAdapter } from "../src/task-scheduler/adapter.ts";
import taskSchedulerExtension from "../pi/extensions/task-scheduler.ts";

function fakePi() {
  const tools = new Map(), handlers = new Map(), commands = [], sent = [];
  return { tools, handlers, commands, sent,
    registerTool: (definition) => tools.set(definition.name, definition), registerCommand: (name) => commands.push(name),
    on: (name, handler) => handlers.set(name, handler), sendUserMessage: (...args) => sent.push(args) };
}

test("extension consumes an injected P4-shaped public outcome and leaves its default path unchanged", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scheduler-recovery-")));
  const repo = join(root, "repo"); await mkdir(repo);
  const pi = fakePi();
  const consumed = [];
  taskSchedulerExtension(pi, {
    recoverySource: async () => ({ kind: "blocked-unknown", runId: "orphan-1", provenance: "owner unproven" }),
    onRecoveryOutcome: (result) => consumed.push(result),
  });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(consumed, [{ outcome: { kind: "blocked-unknown", runId: "orphan-1", provenance: "owner unproven" }, duplicate: false }]);
  assert.deepEqual(pi.commands, [], "consuming recovery must not register a scheduler restart command");

  const defaultPi = fakePi();
  taskSchedulerExtension(defaultPi);
  await Promise.resolve();
  assert.deepEqual(defaultPi.commands, [], "without a source, the extension retains its existing default registration path");
});

test("exact upstream default extension is registered through the restricted Pi membrane", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scheduler-membrane-")));
  const repo = join(root, "repo"), state = join(root, "state"); await mkdir(repo); await mkdir(state);
  const oldState = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = state;
  try {
    const pi = fakePi(); registerTaskSchedulerAdapter(pi);
    const sessionId = randomUUID();
    const ctx = { cwd: repo, hasUI: true, sessionManager: { getSessionId: () => sessionId }, ui: { setStatus() {}, confirm: async () => true } };
    await pi.handlers.get("session_start")({}, ctx);
    try {
      assert.deepEqual([...pi.tools.keys()].sort(), ["scheduler_create", "scheduler_delete", "scheduler_get", "scheduler_list"]);
      assert.deepEqual(pi.commands, [], "the upstream /cron registration is intercepted");
      const invoke = (tool, params) => pi.tools.get(tool).execute("id", params, new AbortController().signal, () => {}, ctx);
      const created = await invoke("scheduler_create", { type: "interval", schedule: "1h", prompt: "safe", enabled: false });
      const createdText = created.content.map((item) => item.text).join("").replace(/^\[scheduled-task upstream\][^\n]*\n/, "");
      assert.doesNotMatch(createdText, /^Failed/, createdText);
      const taskId = JSON.parse(createdText).id;
      const deleted = await invoke("scheduler_delete", { taskId });
      assert.match(deleted.content.map((item) => item.text).join(""), /Deleted task/);
      const result = await invoke("scheduler_list", {});
      assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
      const dataRoot = join(state, "pi-task-scheduler");
      const hashes = await readdir(dataRoot);
      assert.equal(hashes.length, 1, "the runtime creates exactly one repository hash directory");
      assert.match(hashes[0], /^[a-f0-9]{64}$/);
      assert.equal((await stat(join(dataRoot, hashes[0]))).mode & 0o777, 0o700);
      assert.deepEqual(await readdir(repo), [], "session state is never written into ctx.cwd");
    } finally { await pi.handlers.get("session_shutdown")({}, ctx); }
  } finally { oldState === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = oldState; }
});
