import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import * as facade from "../packages/pi-subagents-enhanced/src/compat/pi-subagents-0.71.ts";
import { assertBrowserTranscriptCompatibility, loadPublicPiModule } from "../scripts/probes/pi-subagents-compat.ts";

const theme = {
  fg(_color, text) { return text; },
  bold(text) { return text; },
};

 test("0.71 facade exposes the public integration surface and no never facades", () => {
  for (const name of ["upstreamSubagentRuntime", "resolveCurrentSessionId", "registerAgentViaEvents", "readFleetTranscript", "renderFleetTranscript"]) {
    assert.equal(typeof facade[name], "function", `${name} must be exported`);
  }
  for (const name of ["loadConfig", "registerSubagentNotify", "currentCompletionOwnerId", "getArtifactsDir", "discoverAgents"]) {
    assert.equal(facade[name], undefined, `${name} must remain an unresolved security gap`);
  }
  // 用户决策：删除增强层 completion notifier 包装，完成投递+ack 完全依赖上游 0.71 原生 notify
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
  await assertBrowserTranscriptCompatibility({
    packageRoot: join(process.cwd(), "packages/pi-subagents-enhanced"),
    jiti: { import: async (specifier) => import(specifier) },
  });
});

test("public Pi module loader rejects an empty module root", async () => {
  await assert.rejects(loadPublicPiModule({ resolveGlobalNodeModules: async () => "   " }), /non-empty npm global module root/);
});
