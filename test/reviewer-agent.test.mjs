import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";
import { resolveModelSelection } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";

const { jiti } = await loadPiTestRuntime(import.meta.url);

test.todo("reviewer admission/discovery moves to the public registerAgent API (T7-T9 follow-up)");

test("reviewer and executor profiles keep configuration out of their operating instructions", async () => {
  const reviewer = await readFile(new URL("../pi/agents/reviewer.md", import.meta.url), "utf8");
  const executor = await readFile(new URL("../pi/agents/executor.md", import.meta.url), "utf8");
  const reviewerBody = reviewer.split("---\n").at(-1);
  const executorBody = executor.split("---\n").at(-1);

  assert.match(reviewer, /^models:\n  - codex-pool\/gpt-6-astra\n  - openai-codex\/gpt-6-astra\n  - codex-pool\/gpt-6-sol\n  - qoder-pool\/GLM-5\.3-0\.6x\n  - zai-coding-cn\/glm-5\.3\nthinking: xhigh/m);
  assert.match(executor, /^models:\n  - codex-pool\/gpt-6-luna\n  - openai-codex\/gpt-6-luna\n  - qoder-pool\/GLM-5\.3-Flash-0\.1x\n  - qoder-pool\/Qwen3\.8-Flash-0\.04x\n  - zai-coding-cn\/glm-5\.3-flash\nthinking: medium/m);
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
