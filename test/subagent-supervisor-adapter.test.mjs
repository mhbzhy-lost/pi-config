import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessSubagentApi } from "../scripts/lib/subagent-dispatch/runtime-membrane.ts";
import { installHeadlessTypedSubagentRuntime } from "../scripts/lib/subagent-dispatch/extension.ts";

let supervisor = {};
try {
  supervisor = await import("../scripts/lib/subagent-dispatch/supervisor-adapter.ts");
} catch {}

const {
  createSupervisorAdapter,
  createSupervisorTool,
  SUPERVISOR_PARAMETERS,
} = supervisor;

function requireSupervisorApi() {
  assert.equal(typeof createSupervisorAdapter, "function");
  assert.equal(typeof createSupervisorTool, "function");
}

test("the membrane privately binds only the upstream supervisor execution closure", async () => {
  requireSupervisorApi();
  const projectSupervisor = createSupervisorTool(createSupervisorAdapter());
  const otherTool = { name: "read", execute() {} };
  const pi = {
    tools: [projectSupervisor, otherTool],
    getAllTools() { return [...this.tools]; },
    registerTool(tool) { this.tools.push(tool); },
  };
  const adapter = createSupervisorAdapter();
  const api = createHeadlessSubagentApi(pi, { supervisorAdapter: adapter });
  const result = { content: [{ type: "text", text: "active" }] };
  let receiver;
  const upstreamDefinition = {
    name: "subagent_supervisor",
    execute() {
      receiver = this;
      return result;
    },
  };

  assert.deepEqual(api.getAllTools().map((tool) => tool.name), ["read"]);
  api.registerTool({ name: "subagent", execute() {} });
  api.registerTool({ name: "subagent_wait", execute() {} });
  api.registerTool({ name: "intercom", execute() {} });
  api.registerTool(upstreamDefinition);

  assert.deepEqual(pi.tools, [projectSupervisor, otherTool]);
  assert.strictEqual(await adapter.execute("tool-1", { action: "status" }), result);
  assert.strictEqual(receiver, upstreamDefinition);
});

function createPi() {
  const tools = [];
  const handlers = new Map();
  return {
    tools,
    events: { on() { return () => {}; }, emit() {} },
    registerTool(tool) { tools.push(tool); },
    getAllTools() { return [...tools]; },
    on(name, handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    async emitLifecycle(name) {
      for (const handler of handlers.get(name) ?? []) await handler({ type: name }, {});
    },
  };
}

test("headless installation exposes project tools and binds the session supervisor target", async () => {
  requireSupervisorApi();
  const pi = createPi();
  const upstreamResult = { content: [{ type: "text", text: "Native supervisor channel active." }] };
  let upstreamDefinition;
  const rpc = { dispose() {} };

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      api.registerTool({ name: "subagent", execute() {} });
      api.registerTool({ name: "subagent_wait", execute() {} });
      api.registerTool({ name: "intercom", execute() {} });
      api.on("session_start", () => {
        upstreamDefinition = {
          name: "subagent_supervisor",
          execute() { return upstreamResult; },
        };
        api.registerTool(upstreamDefinition);
      });
    },
    rpc,
    cleanupStore: {},
  });

  assert.deepEqual(pi.tools.map((tool) => tool.name), ["subagent", "subagent_supervisor"]);
  assert.notStrictEqual(pi.tools[1], upstreamDefinition);
  await pi.emitLifecycle("session_start");
  assert.notStrictEqual(pi.tools[1], upstreamDefinition);
  assert.strictEqual(await pi.tools[1].execute("tool-1", { action: "status" }), upstreamResult);
});

test("session start fails closed when upstream does not provide a supervisor target", async () => {
  const pi = createPi();

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap() {},
    rpc: { dispose() {} },
    cleanupStore: {},
  });

  await assert.rejects(pi.emitLifecycle("session_start"), /SUPERVISOR_TARGET_UNAVAILABLE/);
});

test("real ExtensionRunner reports and deactivates an unbound supervisor facade", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
  } = await import("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const root = await mkdtemp(join(tmpdir(), "unbound-supervisor-"));
  const errors = [];
  let result;

  try {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      extensionFactories: [
        (pi) => installHeadlessTypedSubagentRuntime(pi, {
          bootstrap() {},
          rpc: { dispose() {} },
          cleanupStore: {},
        }),
      ],
    });
    await loader.reload();
    result = await createAgentSession({
      cwd: root,
      agentDir: root,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
    });
    await result.session.bindExtensions({
      mode: "rpc",
      shutdownHandler() {},
      onError(error) { errors.push(error); },
    });

    assert.ok(
      errors.some((error) => error.error === "SUPERVISOR_TARGET_UNAVAILABLE"),
      JSON.stringify(errors),
    );
    assert.ok(!result.session.getActiveToolNames().includes("subagent_supervisor"));
  } finally {
    if (result) {
      await result.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      result.session.dispose();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("exports a project-owned static supervisor contract", () => {
  requireSupervisorApi();
  const adapter = createSupervisorAdapter();
  const tool = createSupervisorTool(adapter);

  assert.equal(tool.name, "subagent_supervisor");
  assert.strictEqual(tool.parameters, SUPERVISOR_PARAMETERS);
  assert.deepEqual(tool.parameters, {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { enum: ["reply", "pending", "status"] },
      to: { type: "string" },
      message: { type: "string" },
      replyTo: { type: "string" },
    },
  });
  assert.match(tool.description, /reply|pending|status/);
  assert.doesNotMatch(tool.description, /pi-subagents|upstream/i);
});

test("delegates every execution argument and the resolved result unchanged", async () => {
  requireSupervisorApi();
  const adapter = createSupervisorAdapter();
  const params = { action: "reply", replyTo: "request-1", message: "Proceed." };
  const signal = new AbortController().signal;
  const onUpdate = () => {};
  const ctx = { cwd: "/repo" };
  const result = { content: [{ type: "text", text: "replied" }], details: { replyTo: "request-1" } };
  let received;

  adapter.bind((...args) => {
    received = args;
    return result;
  });

  const actual = await createSupervisorTool(adapter).execute("tool-1", params, signal, onUpdate, ctx);

  assert.deepEqual(received, ["tool-1", params, signal, onUpdate, ctx]);
  assert.strictEqual(received[1], params);
  assert.strictEqual(actual, result);
});

test("fails closed before binding, on duplicate binding, and after dispose", async () => {
  requireSupervisorApi();
  const adapter = createSupervisorAdapter();
  const execute = () => ({ content: [] });

  await assert.rejects(adapter.execute("tool-1", { action: "status" }), /SUPERVISOR_TARGET_UNAVAILABLE/);
  adapter.bind(execute);
  assert.throws(() => adapter.bind(execute), /SUPERVISOR_TARGET_ALREADY_BOUND/);
  adapter.dispose();
  await assert.rejects(adapter.execute("tool-1", { action: "status" }), /SUPERVISOR_TARGET_UNAVAILABLE/);
});
