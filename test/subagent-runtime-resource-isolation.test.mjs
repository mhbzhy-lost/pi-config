import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repo = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, repo), "utf8");
}

test("keeps pi-subagents Pi-managed while disabling every upstream package resource", async () => {
  const settings = JSON.parse(await text("pi/settings.json"));
  const entry = settings.packages.find((candidate) => {
    const source = typeof candidate === "string" ? candidate : candidate?.source;
    return /^npm:pi-subagents(?:@|$)/.test(source ?? "");
  });

  assert.deepEqual(entry, {
    source: "npm:pi-subagents@0.45.2",
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
});

test("disables every task scheduler package resource", async () => {
  const settings = JSON.parse(await text("pi/settings.json"));
  const entry = settings.packages.find((candidate) => candidate?.source === "npm:@amaster.ai/pi-task-scheduler@0.1.9");

  assert.deepEqual(entry, {
    source: "npm:@amaster.ai/pi-task-scheduler@0.1.9",
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
});

test("keeps delegate as the only enabled pi-subagents builtin agent", async () => {
  const settings = JSON.parse(await text("pi/settings.json"));
  const overrides = settings.subagents?.agentOverrides ?? {};
  const disabledBuiltins = [
    "advisor",
    "context-builder",
    "oracle",
    "planner",
    "researcher",
    "reviewer",
    "scout",
    "worker",
  ];

  for (const name of disabledBuiltins) {
    assert.deepEqual(overrides[name], { disabled: true }, name);
  }
  assert.equal(overrides.delegate, undefined);
});

test("does not configure the Todo package", async () => {
  const settings = JSON.parse(await text("pi/settings.json"));
  const hasTodoPackage = settings.packages.some((candidate) => {
    const source = typeof candidate === "string" ? candidate : candidate?.source;
    return /^npm:@juicesharp\/rpiv-todo(?:@|$)/.test(source ?? "");
  });

  assert.equal(hasTodoPackage, false);
});

test("retains exact subagent dependency ownership in Pi package management", async () => {
  const runtimePackage = JSON.parse(await text("pi/npm/package.json"));
  const init = await text("init-pi.sh");

  assert.equal(runtimePackage.dependencies["pi-subagents"], "0.45.2");
  assert.equal(runtimePackage.dependencies["@juicesharp/rpiv-todo"], undefined);
  assert.match(init, /PI_CODING_AGENT_DIR="\$SCRIPT_DIR\/pi" "\$pi_binary" install "npm:pi-subagents@\$PI_SUBAGENTS_VERSION"/);
  assert.doesNotMatch(init, /npm install[^\n]*pi-subagents/);
});

test("loads upstream only behind the project-owned headless runtime entry", async () => {
  const entry = await text("pi/extensions/subagent-runtime.ts");

  assert.match(entry, /\.\.\/npm\/node_modules\/pi-subagents\/index\.ts/);
  assert.match(entry, /installHeadlessTypedSubagentRuntime/);
  assert.doesNotMatch(entry, /registerTool\s*\(/);
});

test("production runtime lifecycle identity and retry cleanup contract", async () => {
  const entry = await text("pi/extensions/subagent-runtime.ts");

  assert.match(entry, /const lifecycleSessionId = resolveCurrentSessionId\(ctx\.sessionManager\);/);
  assert.match(entry, /new RootBrokerServer\(\{ rootSessionId, lifecycleSessionId, upstream, events: pi\.events \}\)/);
  assert.match(entry, /closeAndUnbindRootBroker\(pi, broker\)/);
  assert.doesNotMatch(entry, /closeRootSession\(\);\s*\}\s*finally\s*\{\s*unbindRootBroker/);
});

test("production dispatch modules are independent from Plan Runner and native tool definitions", async () => {
  const sources = await Promise.all([
    "scripts/lib/subagent-dispatch/ir.ts",
    "scripts/lib/subagent-dispatch/prompt.ts",
    "scripts/lib/subagent-dispatch/rpc-client.ts",
    "scripts/lib/subagent-dispatch/runtime-membrane.ts",
    "scripts/lib/subagent-dispatch/extension.ts",
  ].map(text));
  const joined = sources.join("\n");

  for (const forbidden of [
    "scripts/lib/plan",
    "plan-runner",
    "pi-plan-capsule",
    "createPiSubagentsExecutionBackend",
    "compilePlanToIR",
    "tool_call",
    ".definition.execute",
  ]) {
    assert.doesNotMatch(joined, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), forbidden);
  }
});

test("the model-facing description contains the project dispatch and push-notification contract", async () => {
  const { TYPED_SUBAGENT_DESCRIPTION } = await import("../scripts/lib/subagent-dispatch/extension.ts");

  assert.match(TYPED_SUBAGENT_DESCRIPTION, /dispatch-ir\.v1/);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /For executor, provide/);
  assert.doesNotMatch(TYPED_SUBAGENT_DESCRIPTION, /spark/);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /completion notifications are delivered automatically/i);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /do not use sleep, status polling, or supervisor pending/i);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /if none remains, end the turn/i);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /use status only for explicit user requests, intervention, or diagnostics/i);
  assert.doesNotMatch(TYPED_SUBAGENT_DESCRIPTION, /CHAIN|PARALLEL|proactive skill|Fable|watchdog|schedule/i);
});
