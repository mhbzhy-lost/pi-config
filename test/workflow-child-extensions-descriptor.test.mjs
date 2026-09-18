import assert from "node:assert/strict";
import test from "node:test";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

const { createJiti } = await import(piHostJitiUrl);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
const { patchWorkflowChildExtensionsSource, WORKFLOW_CHILD_EXTENSIONS_PATCH_VERSION } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts");

// v1 已应用（marker 存在）但 recovery descriptor 仍读 recoveryAgentConfig：
// resumed child 丢失 workflow 注入的 managed integration child 扩展。
const v1PatchedExecution = [
  "\tconst toolPlan = resolvePiLaunchToolPlan({",
  "\t\ttools: agentConfig.tools,",
  "\t});",
  "\t// pi-config patch: workflow-child-extensions.v1",
  "\tconst workflowSubagentOnlyExtensions = params.subagentOnlyExtensions;",
  "\tconst effectiveSubagentOnlyExtensions = [...new Set([",
  "\t\t...(agentConfig.subagentOnlyExtensions ?? []),",
  "\t\t...(workflowSubagentOnlyExtensions ?? []),",
  "\t])];",
  "\tconst recoveryDescriptor: SteeringRecoveryDescriptor = {",
  "\t\tversion: 1,",
  "\t\t...(recoveryAgentConfig.subagentOnlyExtensions ? { subagentOnlyExtensions: [...recoveryAgentConfig.subagentOnlyExtensions] } : {}),",
  "\t};",
].join("\n");

test("v2 patch 使 recovery descriptor 捕获 effective workflow child extensions", () => {
  const source = patchWorkflowChildExtensionsSource(v1PatchedExecution, "execution-fixture.ts");
  assert.match(source, /workflow-child-extensions\.v2/);
  assert.doesNotMatch(source, /recoveryAgentConfig\.subagentOnlyExtensions \? \{ subagentOnlyExtensions: \[\.\.\.recoveryAgentConfig\.subagentOnlyExtensions\] \} : \{\}/);
  assert.match(source, /effectiveSubagentOnlyExtensions\?\.length \? \{ subagentOnlyExtensions: \[\.\.\.new Set\(\[\.\.\.\(recoveryAgentConfig\.subagentOnlyExtensions \?\? \[\]\), \.\.\.\(effectiveSubagentOnlyExtensions \?\? \[\]\)\]\)\] \} : \{\}/);
  assert.equal(source.match(/workflow-child-extensions\.v2/g)?.length, 1, "v2 marker 只出现一次");
});

test("v2 patch 幂等：已含 v2 marker 的 source 不再改写", () => {
  const once = patchWorkflowChildExtensionsSource(v1PatchedExecution, "execution-fixture.ts");
  const twice = patchWorkflowChildExtensionsSource(once, "execution-fixture.ts");
  assert.equal(twice, once);
});

test("v2 patch 拒绝缺失锚点的 source（防静默失配）", () => {
  assert.throws(() => patchWorkflowChildExtensionsSource("const x = 1;\n", "broken-fixture.ts"), /expected one patch anchor/);
});

test("patch 版本号推进到 v2", () => {
  assert.equal(WORKFLOW_CHILD_EXTENSIONS_PATCH_VERSION, "workflow-child-extensions.v2");
});
