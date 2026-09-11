import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";
import { resolveModelSelection } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";

const { jiti } = await loadPiTestRuntime(import.meta.url);
const { discoverAgents } = await jiti.import("../packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts");

test("reviewer discovery selects the requested model and thinking without privileged authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-profile-"));
  try {
    await mkdir(join(root, ".pi", "agents"), { recursive: true });
    await copyFile(new URL("../pi/agents/reviewer.md", import.meta.url), join(root, ".pi", "agents", "reviewer.md"));
    const reviewer = discoverAgents(root, "project").agents.find((agent) => agent.name === "reviewer");
    assert.ok(reviewer);
    assert.equal(reviewer.thinking, "xhigh");
    const selection = resolveModelSelection({ agentName: reviewer.name, agentModels: reviewer.models, requestedModel: "gpt-6-astra", availableModels: [{ provider: "openai-codex", id: "gpt-6-astra" }, { provider: "other", id: "gpt-6-astra" }] });
    assert.equal(selection.model, "openai-codex/gpt-6-astra");
    assert.equal(selection.source, "agent-candidates");
    assert.throws(() => resolveModelSelection({ agentName: reviewer.name, agentModels: reviewer.models, requestedModel: "gpt-6-astra", availableModels: [{ provider: "other", id: "gpt-6-astra" }] }), /available/i);
    const authorization = createRunAuthorization({ kind: "generic", binding: { runId: "review", asyncDir: root, sessionId: "root", pid: process.pid, agentProfile: reviewer.name }, goal: null });
    assert.deepEqual(authorization.capabilities, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewer and executor profiles keep configuration out of their operating instructions", async () => {
  const reviewer = await readFile(new URL("../pi/agents/reviewer.md", import.meta.url), "utf8");
  const executor = await readFile(new URL("../pi/agents/executor.md", import.meta.url), "utf8");
  const reviewerBody = reviewer.split("---\n").at(-1);
  const executorBody = executor.split("---\n").at(-1);

  assert.match(reviewer, /^models:\n  - openai-codex\/gpt-6-astra\n  - codex-pool\/gpt-5\.6-sol\nthinking: xhigh/m);
  assert.match(executor, /^models:\n  - codex-pool\/gpt-5\.6-terra\n  - openai-codex\/gpt-5\.6-terra\n  - codex-pool\/gpt-5\.6-luna\n  - openai-codex\/gpt-5\.6-luna\nthinking: medium/m);
  assert.doesNotMatch(executor, /^\s*- deepseek\//m);
  const subagentConfig = JSON.parse(await readFile(new URL("../pi/extensions/subagent/config.json", import.meta.url), "utf8"));
  assert.deepEqual(subagentConfig.providerBlacklist, ["deepseek"]);
  assert.doesNotMatch(reviewerBody, /模型|thinking|Host|runtime|profile|frontmatter|审批机制/i);
  assert.match(reviewerBody, /计划执行前.*(?:审阅|审查)/);
  assert.match(reviewerBody, /计划执行完成后.*核对/);
  assert.match(reviewerBody, /偏差/);
  assert.match(reviewerBody, /改进建议/);
  assert.match(reviewerBody, /只读/);
  assert.doesNotMatch(executor, /^temperature:/m);
  assert.doesNotMatch(executorBody, /dispatch-ir|runtime|Host|profile|capability|frontmatter|model routing/i);
  assert.match(executorBody, /TDD/);
  assert.match(executorBody, /不得委派/);
});
