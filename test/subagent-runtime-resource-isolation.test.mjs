import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repo = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, repo), "utf8");
}

test("uses the enhanced local package as the only subagent package source", async () => {
  const settings = JSON.parse(await text("pi/settings.json"));
  const subagentEntries = settings.packages.filter((candidate) => {
    const source = typeof candidate === "string" ? candidate : candidate?.source;
    return source === "../packages/pi-subagents-enhanced" || /^npm:pi-subagents(?:@|$)/.test(source ?? "");
  });

  assert.deepEqual(subagentEntries, [{ source: "../packages/pi-subagents-enhanced" }]);
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
  if (settings.subagents?.disableBuiltins === true) return;
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

test("keeps subagent dependencies owned by the enhanced package setup", async () => {
  const runtimePackage = JSON.parse(await text("pi/npm/package.json"));
  const init = await text("init-pi.sh");

  assert.equal(runtimePackage.dependencies["pi-subagents"], undefined);
  assert.equal(runtimePackage.dependencies.typebox, undefined);
  assert.equal(runtimePackage.dependencies["@juicesharp/rpiv-todo"], undefined);
  assert.doesNotMatch(init, /PI_SUBAGENTS_VERSION|pi_binary" install "npm:pi-subagents/);
  assert.match(init, /npm --prefix "\$SCRIPT_DIR" run setup:subagents-enhanced/);
});

test("loads upstream only through the enhanced package and removes duplicate auto-discovered entries", async () => {
  const entry = await text("packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");

  assert.match(entry, /\.\.\/src\/compat\/pi-subagents-0\.62\.ts/);
  assert.match(entry, /installHeadlessTypedSubagentRuntime/);
  assert.doesNotMatch(entry, /registerTool\s*\(/);
  for (const legacy of [
    "pi/extensions/subagent-runtime.ts",
    "pi/extensions/custom-footer.ts",
    "pi/extensions/lib/pi-subagents-browser-adapter.ts",
    "pi/extensions/lib/subagent-native-conversation.ts",
    "pi/extensions/lib/subagent-session-browser.ts",
    "pi/extensions/lib/subagent-session-viewport.ts",
  ]) await assert.rejects(() => text(legacy), { code: "ENOENT" }, legacy);
});

test("production runtime lifecycle identity and retry cleanup contract", async () => {
  const entry = await text("packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");

  assert.match(entry, /const lifecycleSessionId = resolveCurrentSessionId\(ctx\.sessionManager\);/);
  assert.match(entry, /new RootBrokerServer\(\{ rootSessionId, lifecycleSessionId, upstream, events: pi\.events \}\)/);
  assert.match(entry, /closeAndUnbindRootBroker\(pi, broker\)/);
  assert.doesNotMatch(entry, /closeRootSession\(\);\s*\}\s*finally\s*\{\s*unbindRootBroker/);
});

test("production dispatch modules are independent from Plan Runner and native tool definitions", async () => {
  const sources = await Promise.all([
    "packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts",
    "packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts",
    "packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts",
    "packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts",
    "packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts",
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
  const { TYPED_SUBAGENT_DESCRIPTION } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts");

  assert.match(TYPED_SUBAGENT_DESCRIPTION, /dispatch-ir\.v1/);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /For executor, provide/);
  assert.doesNotMatch(TYPED_SUBAGENT_DESCRIPTION, /spark/);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /completion notifications are delivered automatically/i);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /do not use sleep, status polling, or supervisor pending/i);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /if none remains, end the turn/i);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /use status only for explicit user requests, intervention, or diagnostics/i);
  assert.doesNotMatch(TYPED_SUBAGENT_DESCRIPTION, /CHAIN|PARALLEL|proactive skill|Fable|watchdog|schedule/i);
});
