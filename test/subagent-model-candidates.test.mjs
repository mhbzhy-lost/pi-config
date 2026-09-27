import assert from "node:assert/strict";
import test from "node:test";
// jiti is not installed in this workspace; Node >=22.19 native TypeScript loading is used.
const { resolveModelSelection, ModelSelectionError } = await import(
  "../packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts",
);

const available = [
  { provider: "codex-pool", id: "gpt-6-astra" },
  { provider: "codex-pool", id: "gpt-5.6-sol" },
  { provider: "qoder-pool", id: "GLM-5.3-0.6x" },
  { provider: "zai-coding-cn", id: "glm-5.3" },
];
const reviewerModels = ["codex-pool/gpt-6-astra", "openai-codex/gpt-6-astra", "codex-pool/gpt-5.6-sol",
  "qoder-pool/GLM-5.3-0.6x", "zai-coding-cn/glm-5.3"];

function failure(operation, check) {
  assert.throws(operation, (error) => { assert.ok(error instanceof ModelSelectionError); check(error); return true; });
}

test("bare 昵称失败时给出声明候选与唯一建议", () => failure(
  () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: reviewerModels, availableModels: available }),
  (error) => {
    assert.equal(error.code, "MODEL_NOT_AVAILABLE"); assert.equal(error.details.requestedKind, "bare");
    assert.equal(error.details.agent, "reviewer"); assert.equal(error.details.requestedModel, "astra");
    assert.deepEqual([...error.details.declaredCandidates], reviewerModels);
    assert.deepEqual([...error.details.availableCandidates], ["codex-pool/gpt-5.6-sol", "codex-pool/gpt-6-astra", "qoder-pool/GLM-5.3-0.6x", "zai-coding-cn/glm-5.3"]);
    assert.equal(error.details.suggestion, "gpt-6-astra"); assert.match(error.message, /Did you mean "gpt-6-astra"\?/);
    assert.match(error.message, /Available declared IDs:/); assert.match(error.message, /exactly match the full id segment after/);
  },
));

test("blocked provider 不出现在任何候选清单中，且不给不可用建议", () => failure(
  () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: reviewerModels, availableModels: available, blockedProviders: ["codex-pool"] }),
  (error) => { assert.equal([...error.details.declaredCandidates].some((c) => c.startsWith("codex-pool/")), false); assert.equal([...error.details.availableCandidates].some((c) => c.startsWith("codex-pool/")), false); assert.equal("suggestion" in error.details, false); },
));

test("qualified 请求失败时不给模糊建议", () => failure(
  () => resolveModelSelection({ requestedModel: "qoder-pool/gpt-6-astra", agentName: "reviewer", agentModels: reviewerModels, availableModels: available }),
  (error) => { assert.equal(error.details.requestedKind, "qualified"); assert.equal("suggestion" in error.details, false); assert.equal(error.message.includes("Did you mean"), false); assert.match(error.message, /Available models:/); },
));

test("建议不唯一时省略 suggestion", () => failure(
  () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: ["p1/x-astra", "p2/y-astra"], availableModels: [{ provider: "p1", id: "x-astra" }, { provider: "p2", id: "y-astra" }] }),
  (error) => { assert.equal("suggestion" in error.details, false); assert.deepEqual([...error.details.declaredCandidates], ["p1/x-astra", "p2/y-astra"]); },
));

test("后缀边界：只有 '-' 或 '.' 分隔才算命中", () => failure(
  () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: ["p/megastra"], availableModels: [{ provider: "p", id: "megastra" }] }),
  (error) => { assert.equal("suggestion" in error.details, false); },
));

test("成功路径与全局目录警告行为不变", () => {
  const qualified = resolveModelSelection({ requestedModel: "codex-pool/gpt-6-astra", agentName: "reviewer", agentModels: reviewerModels, availableModels: available });
  assert.equal(qualified.model, "codex-pool/gpt-6-astra"); assert.equal(qualified.source, "qualified");
  const bareDeclared = resolveModelSelection({ requestedModel: "glm-5.3", agentName: "reviewer", agentModels: reviewerModels, availableModels: available });
  assert.equal(bareDeclared.model, "zai-coding-cn/glm-5.3"); assert.equal(bareDeclared.source, "agent-candidates");
  const bareGlobal = resolveModelSelection({ requestedModel: "glm-5.3", agentName: "reviewer", availableModels: available });
  assert.equal(bareGlobal.model, "zai-coding-cn/glm-5.3"); assert.equal(bareGlobal.source, "global-catalog"); assert.ok(bareGlobal.warnings?.some((w) => w.code === "MODEL_MATCH_USED_GLOBAL_CATALOG"));
  assert.equal(resolveModelSelection({ agentName: "reviewer", agentModels: reviewerModels, availableModels: available }).source, "default");
});
