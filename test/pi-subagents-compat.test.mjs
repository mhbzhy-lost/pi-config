import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import * as facade from "../packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts";
import { assertBrowserTranscriptCompatibility, evaluatePlanHarnessCompatibility, loadPublicPiModule } from "../scripts/probes/pi-subagents-compat.ts";
import { resolvePiCodingAgentRoot } from "./helpers/pi-runtime.mjs";

const theme = {
  fg(_color, text) { return text; },
  bold(text) { return text; },
};

 test("0.75 facade exposes the public integration surface and no never facades", () => {
  for (const name of ["upstreamSubagentRuntime", "resolveCurrentSessionId", "registerAgentViaEvents", "readFleetTranscript", "renderFleetTranscript"]) {
    assert.equal(typeof facade[name], "function", `${name} must be exported`);
  }
  for (const name of ["loadConfig", "registerSubagentNotify", "currentCompletionOwnerId", "getArtifactsDir", "discoverAgents"]) {
    assert.equal(facade[name], undefined, `${name} must remain an unresolved security gap`);
  }
  // 用户决策：删除增强层 completion notifier 包装，完成投递+ack 完全依赖上游 0.75 原生 notify
  //（node_modules/pi-subagents/src/runs/background/notify.js sendCompletion 发送 subagent-notify）。
  for (const name of ["createCompletionNotifier", "subscribeAsyncComplete"]) {
    assert.equal(facade[name], undefined, `${name} wrapper is removed; upstream native notify owns completion delivery`);
  }
});

test("session identity projection consumes Host session manager fields", () => {
  assert.deepEqual(facade.readSessionIdentity({
    getSessionId: () => "session-1",
    getSessionFile: () => "/tmp/session.jsonl",
    getCwd: () => "/tmp/project",
  }), { sessionId: "session-1", sessionFile: "/tmp/session.jsonl", cwd: "/tmp/project" });
  assert.equal(facade.resolveCurrentSessionId({ getSessionId: () => "session-1" }), "session-1");
  assert.throws(() => facade.resolveCurrentSessionId({ getSessionId: () => undefined }), /identity is unavailable/);
});

test("profile frontmatter projects declared config and preserves full frontmatter metadata", () => {
  const profile = facade.parseFrontmatter(`---\nname: fixture\ndescription: Fixture profile\nmodels:\n  - provider/first\n  - provider/second\nlabelList:\n  - must-not-be-a-model\ntools:\n  - read\n  - write, bash\nthinking: false\n---\nPrompt body`);
  assert.deepEqual(profile, {
    name: "fixture",
    description: "Fixture profile",
    systemPrompt: "Prompt body",
    models: ["provider/first", "provider/second"],
    tools: ["read", "write", "bash"],
    thinking: false,
    metadata: {
      name: "fixture",
      description: "Fixture profile",
      models: ["provider/first", "provider/second"],
      labelList: ["must-not-be-a-model"],
      tools: ["read", "write, bash"],
      thinking: false,
    },
  });
});

test("profile frontmatter accepts inline YAML arrays without mixing unrelated lists", () => {
  const profile = facade.parseFrontmatter(`---\nname: fixture\ndescription: Fixture profile\nmodels: [provider/first, provider/second]\ntools: [read, write]\nother:\n  - not-a-tool\n---\nPrompt body`);
  assert.deepEqual(profile.models, ["provider/first", "provider/second"]);
  assert.deepEqual(profile.tools, ["read", "write"]);
});

for (const format of ["LF", "CRLF", "BOM+CRLF"]) {
 test(`F1 admission 正确投影 ${format} 的合法 YAML、quoted scalar 与独立列表`, async () => {
  const root = await mkdtemp(join(tmpdir(), "f1-profile-admission-"));
  const agentDir = join(root, "agents");
  try {
    await mkdir(agentDir, { recursive: true });
    const profile = `---
name: "reviewer"
description: "Reviewer's profile"
models:
- "pool/astra" # 首位候选
- 'direct/sol'
model: "pool/astra"
other:
  - must-not-be-a-model
tools:
  - read
  - write, bash
thinking: false
---
Temporary system prompt
`;
    for (const name of ["delegate", "executor", "reviewer"]) {
      const source = profile.replace('name: "reviewer"', `name: "${name}"`);
      await writeFile(join(agentDir, `${name}.md`), (format.startsWith("BOM") ? "\ufeff" : "") + (format.includes("CRLF") ? source.replaceAll("\n", "\r\n") : source));
    }
    const admission = facade.registerBuiltinAgentsViaEvents({ pi: { events: {} }, agentDir: root });
    try {
      const result = admission.discoverAgents("/tmp/ignored", "both");
      assert.deepEqual(result.agents.map((agent) => agent.name), ["delegate", "executor", "reviewer"]);
      assert.deepEqual(result.agents[2], {
        name: "reviewer",
        description: "Reviewer's profile",
        systemPrompt: "Temporary system prompt",
        models: ["pool/astra", "direct/sol"],
        model: "pool/astra",
        thinking: false,
        tools: ["read", "write", "bash"],
        metadata: {
          name: "reviewer",
          description: "Reviewer's profile",
          models: ["pool/astra", "direct/sol"],
          model: "pool/astra",
          other: ["must-not-be-a-model"],
          tools: ["read", "write, bash"],
          thinking: false,
        },
      });
    } finally { admission.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
 });
}

for (const [label, declaration] of [
  ["models-empty", "models: []"],
  ["models-null", "models:"],
  ["models-scalar", "models: pool/astra"],
  ["models-map", "models: { first: pool/astra }"],
  ["models-item", "models:\n  - pool/astra\n  - 42"],
  ["models-empty-item", 'models: [pool/astra, ""]'],
  ["models-blank-item", 'models: ["   "]'],
  ["model-number", "model: 42"],
  ["model-array", "model: [pool/astra]"],
  ["model-null", "model: null"],
  ["model-empty", 'model: ""'],
  ["model-blank", 'model: "   "'],
  ["tools-number", "tools: 42"],
  ["tools-map", "tools:\n  read: true"],
  ["tools-null", "tools: null"],
  ["tools-item", "tools: [read, false]"],
]) {
  test(`F1 admission 拒绝非法声明 ${label}，不丢弃声明降级 default`, async () => {
    const root = await mkdtemp(join(tmpdir(), `f1-invalid-${label}-`));
    try {
      await mkdir(join(root, "agents"));
      for (const name of ["delegate", "executor", "reviewer"]) {
        await writeFile(join(root, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Fixture\n${name === "reviewer" ? declaration : ""}\n---\nPrompt`);
      }
      assert.throws(() => facade.registerBuiltinAgentsViaEvents({ pi: { events: {} }, agentDir: root }), /Invalid agent profile/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("admission is exactly the repository profiles and rejects every other source", () => {
  const emitted = [];
  const events = {
    emit(name, payload) { emitted.push({ name, payload }); },
    on() { throw new Error("runtime registration observation is forbidden"); },
  };
  const admission = facade.registerBuiltinAgentsViaEvents({ pi: { events }, agentDir: join(process.cwd(), "pi") });
  const discovered = admission.discoverAgents(join(tmpdir(), "project-without-repository-agents"), "both");
  assert.deepEqual(discovered.agents.map((agent) => agent.name), ["delegate", "executor", "reviewer"]);
  assert.equal(discovered.admission, "repository-configured");
  assert.equal(emitted.length, 0, "repository profiles are configured, not runtime-registered");
  for (const requestedName of ["probe-worker", "project-worker", "runtime-worker"]) {
    assert.throws(
      () => admission.discoverAgents("/repo", "both", undefined, requestedName),
      (error) => error?.code === "AGENT_ADMISSION_UNAVAILABLE" && error.message === "AGENT_ADMISSION_UNAVAILABLE",
    );
  }
  admission.dispose();
});

test("agent registration is wired through the public registerAgentViaEvents API", () => {
  const emitted = [];
  const events = { emit(name, payload) {
    emitted.push({ name, payload });
    payload.result = { ok: true, registration: { dispose() {} } };
  } };
  const registration = facade.registerAgentViaEvents({
    pi: { events },
    name: "fixture",
    definition: { description: "fixture", systemPrompt: "fixture" },
  });
  assert.equal(typeof registration.dispose, "function");
  assert.equal(emitted[0].name, "pi-subagents:runtime-agent-register:v1");
  assert.equal(emitted[0].payload.version, 1);
});

test("fleet transcript facade parses and renders a trusted transcript fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "t5-transcript-"));
  const file = join(root, "session.jsonl");
  try {
    await writeFile(file, [
      JSON.stringify({ role: "user", content: "Inspect the fixture" }),
      JSON.stringify({ role: "assistant", content: "Fixture inspected" }),
      JSON.stringify({ role: "tool", name: "read", output: "ok", status: "complete" }),
    ].join("\n"));
    const transcript = facade.readFleetTranscript(file, { trustedRoots: [root] });
    assert.equal(transcript.warning, undefined);
    assert.deepEqual(transcript.events.map((event) => event.kind), ["user", "assistant", "tool"]);
    const lines = facade.renderFleetTranscript(transcript, 120, theme, {});
    assert.ok(lines.some((line) => line.includes("Fixture inspected")));
    assert.ok(lines.some((line) => line.includes("read")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("facade import is loadable through the enhanced package compatibility probe", async () => {
  // root 必须经 helper 解析：缺省本仓物理 SDK，显式 env 仍可 pin；
  // 不得直接读 unchecked env（缺失时 join(undefined) 崩溃且可能飘到过期全局安装）。
  await assertBrowserTranscriptCompatibility({
    packageRoot: join(process.cwd(), "packages/pi-subagents-enhanced"),
    piModule: await loadPublicPiModule({ globalNodeModules: join(resolvePiCodingAgentRoot(), "..", "..") }),
    jiti: { import: async (specifier) => import(specifier) },
  });
});

test("public Pi module loader rejects an empty module root", async () => {
  await assert.rejects(loadPublicPiModule({ resolveGlobalNodeModules: async () => "   " }), /non-empty npm global module root/);
});

test("compat probe plan harness version gate pins Pi 1.0.4 precisely", () => {
  // 纯合成报告：除 piVersion 外全部满足探针其余契约，隔离出版本门禁单一变量。
  const compliant = {
    piVersion: "1.0.4",
    version: "0.75.0",
    typeboxVersion: "1.1.38",
    typeboxCompileResolvable: true,
    rpcVersion: 1,
    methods: ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"],
    events: ["subagent:async-started", "subagent:async-complete", "subagent:process-terminal"],
    rootBrokerReady: true,
    childAdapterRegistered: true,
    noFanoutExtension: true,
    exactCwd: true,
    worktreeDisabled: true,
    waitWakesOnCompletion: true,
    rpcStatusFindsActiveRun: true,
    statusArtifactObservesSupervisorBlock: true,
    supervisorRoundTrip: true,
    executorFanoutBlocked: true,
    flatRuntimeDepth: 1,
    nestedEventFiles: 0,
  };
  const accepted = evaluatePlanHarnessCompatibility(compliant);
  assert.deepEqual(accepted, { ok: true, failures: [] });
  const stale = evaluatePlanHarnessCompatibility({ ...compliant, piVersion: "1.0.2" });
  assert.equal(stale.ok, false);
  assert.ok(stale.failures.includes("unsupported Pi version: 1.0.2"), stale.failures.join(", "));
  const future = evaluatePlanHarnessCompatibility({ ...compliant, piVersion: "1.0.5" });
  assert.equal(future.ok, false);
  assert.ok(future.failures.includes("unsupported Pi version: 1.0.5"), future.failures.join(", "));
});
