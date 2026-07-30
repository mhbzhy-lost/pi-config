import assert from "node:assert/strict";
import { join } from "node:path";
import { access, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import * as compat from "../scripts/probes/pi-subagents-compat.mjs";

const { createSubagentsRpcClient, REQUIRED_METHODS, SUPPORTED_PI_VERSIONS } = compat;
const repoRoot = process.cwd();
const compatibleReport = {
  piVersion: "0.83.0",
  version: "0.37.2",
  typeboxVersion: "1.1.38",
  typeboxCompileResolvable: true,
  rpcVersion: 1,
  methods: ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"],
  events: ["subagent:async-started", "subagent:async-complete", "subagent:process-terminal"],
  rootBrokerReady: true,
  flatRuntimeDepth: 1,
  childAdapterRegistered: true,
  noFanoutExtension: true,
  exactCwd: true,
  worktreeDisabled: true,
  waitWakesOnCompletion: true,
  rpcStatusFindsActiveRun: true,
  statusArtifactObservesSupervisorBlock: true,
  supervisorRoundTrip: true,
  executorFanoutBlocked: true,
  nestedEventFiles: 0,
};

function evaluate(report) {
  assert.equal(typeof compat.evaluatePlanHarnessCompatibility, "function");
  return compat.evaluatePlanHarnessCompatibility(report);
}

test("exports the stable RPC v1 method and supported Pi contracts", () => {
  assert.deepEqual(REQUIRED_METHODS, ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"]);
  assert.deepEqual(SUPPORTED_PI_VERSIONS, ["0.82.0", "0.82.1", "0.83.0"]);
});

test("pinned process-terminal event is declared and emitted by async execution", async () => {
  const packageRoot = join(repoRoot, "pi/npm/node_modules/pi-subagents");
  const [types, execution] = await Promise.all([
    readFile(join(packageRoot, "src/shared/types.ts"), "utf8"),
    readFile(join(packageRoot, "src/runs/background/async-execution.ts"), "utf8"),
  ]);
  assert.match(types, /export const SUBAGENT_PROCESS_TERMINAL_EVENT = "subagent:process-terminal";/);
  assert.match(execution, /ctx\.pi\.events\.emit\(SUBAGENT_PROCESS_TERMINAL_EVENT, proof\)/);
});

test("installed launch arguments keep project child agents outside fanout hierarchy", async () => {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const piArgs = await jiti.import(join(repoRoot, "pi/npm/node_modules/pi-subagents/src/runs/shared/pi-args.ts"));
  const agents = Object.fromEntries(await Promise.all(["plan-runner", "executor", "plan-reviewer", "spark"].map(async (name) => {
    const source = await readFile(join(repoRoot, "pi/agents", `${name}.md`), "utf8");
    const fields = Object.fromEntries(source.match(/^---\n([\s\S]*?)\n---/)[1].split("\n").map((line) => line.split(/:\s*/, 2)));
    return [name, fields];
  })));
  for (const fields of Object.values(agents)) {
    const plan = piArgs.resolvePiLaunchToolPlan({ tools: fields.tools?.split(/,\s*/), subagentOnlyExtensions: fields.subagentOnlyExtensions ? [fields.subagentOnlyExtensions] : [], cwd: repoRoot });
    assert.equal(plan.fanoutAuthorized, false);
    assert.ok(!plan.declaredBuiltinTools.includes("subagent"));
    assert.ok(!plan.extensionArgs.some((entry) => entry.includes("fanout-child")));
  }
  await access(join(repoRoot, agents.executor.subagentOnlyExtensions));
  const built = piArgs.buildPiArgs({ baseArgs: [], task: "probe", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, tools: agents.executor.tools.split(/,\s*/), subagentOnlyExtensions: [agents.executor.subagentOnlyExtensions], cwd: repoRoot });
  try {
    assert.equal(built.env.PI_SUBAGENT_FANOUT_CHILD, "0");
    assert.equal(built.env.PI_SUBAGENT_PARENT_DEPTH || undefined, undefined);
    assert.equal(built.env.PI_SUBAGENT_PARENT_RUN_ID || undefined, undefined);
    assert.equal(built.env.PI_SUBAGENT_PARENT_PATH || undefined, undefined);
    assert.ok(built.args.includes(agents.executor.subagentOnlyExtensions));
    assert.ok(built.args.includes("--no-context-files"));
  } finally { await rm(built.tempDir, { recursive: true, force: true }); }
});

test("requires upstream fleet transcript, artifact-root, and every public Pi native conversation capability", async () => {
  assert.equal(typeof compat.assertBrowserTranscriptCompatibility, "function");
  const imported = [];
  const capabilities = [
    "SessionManager", "sessionEntryToContextMessages", "AssistantMessageComponent", "BashExecutionComponent",
    "BranchSummaryMessageComponent", "CompactionSummaryMessageComponent", "CustomMessageComponent", "parseSkillBlock",
    "SkillInvocationMessageComponent", "ToolExecutionComponent", "UserMessageComponent",
  ];
  const piModule = Object.fromEntries(capabilities.map((capability) => [capability, () => {}]));
  await compat.assertBrowserTranscriptCompatibility({
    packageRoot: "/tmp/pi-subagents",
    piModule,
    jiti: { import: async (path) => {
      imported.push(path);
      return path.endsWith("fleet-transcript.ts")
        ? { readFleetTranscript() {}, renderFleetTranscript() {} }
        : { getArtifactsDir() {} };
    } },
  });
  assert.deepEqual(imported, [
    join("/tmp/pi-subagents", "src/tui/fleet-transcript.ts"),
    join("/tmp/pi-subagents", "src/shared/artifacts.ts"),
  ]);

  for (const capability of capabilities) {
    const incomplete = { ...piModule };
    delete incomplete[capability];
    await assert.rejects(
      compat.assertBrowserTranscriptCompatibility({
        packageRoot: "/tmp/pi-subagents", piModule: incomplete,
        jiti: { import: async () => ({ readFleetTranscript() {}, renderFleetTranscript() {}, getArtifactsDir() {} }) },
      }),
      new RegExp(capability),
    );
  }
});

test("checks browser transcript compatibility against the installed pi-subagents package", async () => {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  await compat.assertBrowserTranscriptCompatibility({
    packageRoot: join(process.cwd(), "pi/npm/node_modules/pi-subagents"),
    jiti,
  });
});

test("binds the installed supervisor runtime behind project-owned tools", async () => {
  const markers = ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_FANOUT_CHILD", "PI_SUBAGENT_PARENT_SESSION", "PI_ROOT_SUBAGENT_BROKER_ENABLED"];
  const previousMarkers = new Map(markers.map((name) => [name, process.env[name]]));
  for (const name of markers) delete process.env[name];
  const runtimeMarkers = new Map(markers.map((name) => [name, process.env[name]]));

  let result;
  try {
    const agentDir = join(repoRoot, "pi");
    const loader = new DefaultResourceLoader({ cwd: repoRoot, agentDir });
    await loader.reload();
    result = await createAgentSession({
      cwd: repoRoot,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(repoRoot),
    });
    const errors = [];

    await result.session.bindExtensions({
      mode: "rpc",
      shutdownHandler() {},
      onError(error) { errors.push(error); },
    });
    assert.equal(process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED, "1");
    const toolNames = result.session.getAllTools()
      .map((tool) => tool.name)
      .filter((name) => name.includes("subagent") || name === "intercom");
    const subagent = result.session.getToolDefinition("subagent");
    const notifyRenderer = result.session.resourceLoader.getExtensions().extensions
      .map((extension) => extension.messageRenderers.get("subagent-notify"))
      .find((renderer) => typeof renderer === "function");
    const supervisor = result.session.getToolDefinition("subagent_supervisor");
    const signal = new AbortController().signal;
    const status = await supervisor.execute("compat-status", { action: "status" }, signal, undefined, undefined);
    const pending = await supervisor.execute("compat-pending", { action: "pending" }, signal, undefined, undefined);
    const theme = { fg: (_color, text) => text, bold: (text) => text };
    const notifyMessage = {
      customType: "subagent-notify",
      content: "Background task completed: **delegate** [Renderer smoke]\n\nfull output\n\nSession file: /tmp/session.jsonl",
      display: true,
      details: { titles: ["Renderer smoke"] },
    };
    const notifyBefore = structuredClone(notifyMessage);
    const notifyLines = notifyRenderer(notifyMessage, { expanded: true, outputPad: 0 }, theme)
      .render(120)
      .map((line) => line.trimEnd());
    const statusResult = {
      content: [{ type: "text", text: "Run: run-1\nState: running\nDir: /tmp/run-1\nLog: /tmp/log" }],
      details: { mode: "single", results: [], runId: "run-1", asyncDir: "/tmp/run-1" },
    };
    const statusBefore = structuredClone(statusResult);
    const statusLines = subagent.renderResult(
      statusResult,
      { expanded: true },
      theme,
      { args: { action: "status", id: "run-1" } },
    ).render(120).map((line) => line.trimEnd());

    assert.deepEqual(errors, []);
    assert.deepEqual(toolNames, ["subagent", "subagent_supervisor"]);
    assert.equal(typeof subagent.renderResult, "function");
    assert.equal(typeof notifyRenderer, "function");
    assert.deepEqual(notifyLines, ["✓ Renderer smoke · completed"]);
    assert.deepEqual(statusLines, ["Status: running"]);
    assert.deepEqual(notifyMessage, notifyBefore);
    assert.deepEqual(statusResult, statusBefore);
    assert.doesNotMatch(supervisor.description, /pi-subagents|upstream/i);
    assert.equal(status.details.active, true);
    assert.equal(status.details.pending, 0);
    assert.deepEqual(pending.details.pending, []);
  } finally {
    try {
      if (result) {
        try {
          await result.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
          assert.equal(process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED, runtimeMarkers.get("PI_ROOT_SUBAGENT_BROKER_ENABLED"));
        } finally {
          result.session.dispose();
        }
      }
    } finally {
      for (const [name, value] of previousMarkers) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
});

test("accepts the flat runtime compatibility report", () => {
  assert.deepEqual(evaluate(compatibleReport), { ok: true, failures: [] });
});

test("rejects runtime versions outside the explicit support set", () => {
  for (const version of ["0.82.0", "0.82.1", "0.83.0"]) {
    assert.deepEqual(evaluate({ ...compatibleReport, piVersion: version }), { ok: true, failures: [] });
  }
  assert.deepEqual(evaluate({ ...compatibleReport, piVersion: "0.83.1" }).failures, ["unsupported Pi version: 0.83.1"]);
  assert.deepEqual(evaluate({ ...compatibleReport, version: "0.35.1" }).failures, ["unexpected pi-subagents version: 0.35.1"]);
  assert.deepEqual(evaluate({ ...compatibleReport, typeboxVersion: "1.1.24" }).failures, ["unexpected typebox version: 1.1.24"]);
});

test("requires TypeBox compiler resolution from pi-subagents", () => {
  assert.deepEqual(evaluate({ ...compatibleReport, typeboxCompileResolvable: false }).failures, [
    "typebox/compile is not resolvable from pi-subagents",
  ]);
});

test("requires RPC v1 methods and existing lifecycle events", () => {
  assert.deepEqual(evaluate({ ...compatibleReport, rpcVersion: 2 }).failures, ["unexpected RPC version: 2"]);
  assert.deepEqual(evaluate({ ...compatibleReport, methods: compatibleReport.methods.filter((method) => method !== "resume") }).failures, [
    "missing RPC method: resume",
  ]);
  assert.deepEqual(evaluate({ ...compatibleReport, events: compatibleReport.events.filter((event) => event !== "subagent:async-started") }).failures, [
    "missing lifecycle event: subagent:async-started",
  ]);
  assert.deepEqual(evaluate({ ...compatibleReport, events: compatibleReport.events.filter((event) => event !== "subagent:async-complete") }).failures, [
    "missing lifecycle event: subagent:async-complete",
  ]);
});

test("requires the process-terminal lifecycle event", () => {
  assert.deepEqual(evaluate({
    ...compatibleReport,
    events: compatibleReport.events.filter((event) => event !== "subagent:process-terminal"),
  }).failures, ["missing lifecycle event: subagent:process-terminal"]);
});

for (const [field, value, message] of [
  ["rootBrokerReady", false, "Root subagent broker is not ready"],
  ["flatRuntimeDepth", 2, "unexpected flat runtime depth: 2"],
  ["childAdapterRegistered", false, "project child adapter is not registered"],
  ["noFanoutExtension", false, "fanout-child extension is active"],
]) {
  test(`requires flat runtime boundary: ${field}`, () => {
    assert.deepEqual(evaluate({ ...compatibleReport, [field]: value }).failures, [message]);
  });
}

test("requires Executor/runtime boundaries", () => {
  const requirements = [
    ["exactCwd", "Executor did not use the authorized cwd"],
    ["worktreeDisabled", "pi-subagents created an unauthorized worktree"],
    ["waitWakesOnCompletion", "wait did not wake on completion"],
    ["rpcStatusFindsActiveRun", "RPC status did not find the active Executor"],
    ["statusArtifactObservesSupervisorBlock", "Status artifact did not observe the Supervisor block"],
    ["supervisorRoundTrip", "Supervisor request/reply failed"],
    ["executorFanoutBlocked", "Executor can dispatch nested subagents"],
  ];

  for (const [field, message] of requirements) {
    assert.deepEqual(evaluate({ ...compatibleReport, [field]: false }).failures, [message], field);
  }
});

test("rejects nested event files on the executor path", () => {
  assert.deepEqual(evaluate({ ...compatibleReport, nestedEventFiles: 1 }).failures, ["unexpected nested event files: 1"]);
});

test("retires standalone compatibility environment API", () => {
  const retiredExport = ["build", "Standalone", "RuntimeEnv"].join("");
  assert.equal(compat[retiredExport], undefined);
  assert.equal(typeof compat.buildTopLevelRuntimeEnv, "function");
});

test("builds a top-level runtime environment without inherited child markers", () => {
  assert.equal(typeof compat.buildTopLevelRuntimeEnv, "function");
  assert.deepEqual(compat.buildTopLevelRuntimeEnv({
    PATH: "/test/bin",
    PI_SUBAGENT_PARENT_SESSION: "parent-session",
  }), { PATH: "/test/bin" });
  assert.throws(() => compat.buildTopLevelRuntimeEnv({ PI_SUBAGENT_CHILD: "1" }), /PI_SUBAGENT_CHILD/);
  assert.throws(() => compat.buildTopLevelRuntimeEnv({ PI_SUBAGENT_FANOUT_CHILD: "1" }), /PI_SUBAGENT_FANOUT_CHILD/);
});

test("flat runtime compat probe source retires standalone boundaries", async () => {
  const source = await readFile(join(repoRoot, "scripts/probes/pi-subagents-compat.mjs"), "utf8");
  for (const removedName of [
    ["build", "Standalone", "RuntimeEnv"],
    ["standalone", "Root", "Service"],
    ["standalone", "No", "Child", "Env"],
    ["standalone", "Session", "Rebased"],
  ].map((parts) => parts.join(""))) {
    assert.doesNotMatch(source, new RegExp(`\\b${removedName}\\b`));
  }
  assert.match(source, /\bbuildTopLevelRuntimeEnv\b/);
  for (const flatField of [
    "rootBrokerReady",
    "flatRuntimeDepth",
    "childAdapterRegistered",
    "noFanoutExtension",
  ]) {
    assert.match(source, new RegExp(`\\b${flatField}\\b`));
  }
});

test("builds the exact top-level runtime dependency install command", async () => {
  let setup = {};
  try {
    setup = await import("../scripts/setup-plan-runtime-deps.mjs");
  } catch {}
  assert.equal(typeof setup.buildPlanRuntimeInstallCommand, "function");
  assert.deepEqual(setup.buildPlanRuntimeInstallCommand("/tmp/pi/npm"), {
    command: "npm",
    args: [
      "install", "--prefix", "/tmp/pi/npm", "--save-exact",
      "pi-subagents@0.37.2", "@juicesharp/rpiv-todo@2.2.0", "typebox@1.1.38",
    ],
  });
});

test("installs the exact runtime dependencies through the injected process runner", async () => {
  const setup = await import("../scripts/setup-plan-runtime-deps.mjs");
  assert.equal(typeof setup.installPlanRuntimeDependencies, "function");
  const calls = [];
  const result = await setup.installPlanRuntimeDependencies({
    piNpmDir: "/tmp/pi/npm",
    env: { PATH: "/test/bin" },
    run: async (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [[
    "npm",
    ["install", "--prefix", "/tmp/pi/npm", "--save-exact", "pi-subagents@0.37.2", "@juicesharp/rpiv-todo@2.2.0", "typebox@1.1.38"],
    { env: { PATH: "/test/bin" } },
  ]]);
  assert.deepEqual(result, { piNpmDir: "/tmp/pi/npm" });
});

function createEvents() {
  const listeners = new Map();
  const emitted = [];

  return {
    emitted,
    on(channel, listener) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(listener);
    },
    emit(channel, value) {
      emitted.push({ channel, value });
      for (const listener of listeners.get(channel) ?? []) listener(value);
    },
    listenerCount(channel) {
      return listeners.get(channel)?.size ?? 0;
    },
  };
}

test("subagents RPC subscribes before emitting and resolves a successful reply", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-1" });
  const replyChannel = "subagents:rpc:v1:reply:request-1";

  const request = client.call("ping");

  assert.equal(events.listenerCount(replyChannel), 1);
  assert.deepEqual(events.emitted, [{
    channel: "subagents:rpc:v1:request",
    value: { version: 1, requestId: "request-1", method: "ping", params: {} },
  }]);
  events.emit(replyChannel, {
    version: 1,
    requestId: "request-1",
    success: true,
    data: { version: 1, methods: ["ping"], capabilities: {} },
  });

  assert.deepEqual(await request, { version: 1, methods: ["ping"], capabilities: {} });
  assert.equal(events.listenerCount(replyChannel), 0);
});

test("subagents RPC default UUID generator keeps the Crypto receiver", async () => {
  const events = createEvents();
  const emit = events.emit.bind(events);
  events.emit = (channel, value) => {
    emit(channel, value);
    if (channel !== "subagents:rpc:v1:request") return;
    emit(`subagents:rpc:v1:reply:${value.requestId}`, {
      version: 1,
      requestId: value.requestId,
      success: true,
      data: { version: 1 },
    });
  };

  const result = await createSubagentsRpcClient(events).call("ping");

  assert.deepEqual(result, { version: 1 });
  assert.match(events.emitted[0].value.requestId, /^[0-9a-f-]{36}$/);
});

test("subagents RPC rejects an error reply and unsubscribes", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-2" });
  const replyChannel = "subagents:rpc:v1:reply:request-2";
  const request = client.call("ping");

  events.emit(replyChannel, {
    version: 1,
    requestId: "request-2",
    success: false,
    error: { code: "unavailable", message: "unavailable" },
  });

  await assert.rejects(request, /unavailable/);
  assert.equal(events.listenerCount(replyChannel), 0);
});

test("subagents RPC rejects replies with a mismatched version or request id", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-4" });
  const replyChannel = "subagents:rpc:v1:reply:request-4";
  const request = client.call("ping");

  events.emit(replyChannel, { version: 2, requestId: "request-4", success: true, data: {} });

  await assert.rejects(request, /version/);
  assert.equal(events.listenerCount(replyChannel), 0);
});

test("subagents RPC times out and unsubscribes", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-3", timeoutMs: 1 });
  const replyChannel = "subagents:rpc:v1:reply:request-3";

  await assert.rejects(client.call("ping"), /timed out/);
  assert.equal(events.listenerCount(replyChannel), 0);
});
