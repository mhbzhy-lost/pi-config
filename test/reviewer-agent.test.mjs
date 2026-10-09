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

  // 不得把逐字模型 id 钉进本跟踪测试：`pi/models.json` 按根 AGENTS.md 是 per-machine
  // 且已移出版本控制，模型 id 会随本机可用模型变更（已发生过：GLM-5.3-0.6x → GLM-5.3、
  // 摘除 gpt-6-luna），钉死会造成每次调模型都必须同步改测试。
  // 此处只校验**结构不变量**：models 为非空、形如 provider/model、无重复的候选链。
  const assertModelChain = (text, label, thinking) => {
    const block = text.match(/^models:\n((?:  - \S+\n)+)/m);
    assert.ok(block, `${label} frontmatter 必须声明 models 候选链`);
    const ids = block[1].split("\n").filter(Boolean).map((line) => line.replace(/^  - /, ""));
    assert.ok(ids.length >= 1, `${label} models 候选链不得为空`);
    for (const id of ids) {
      assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, `${label} 模型 id 必须为 provider/model 形式，实际 ${id}`);
    }
    assert.equal(new Set(ids).size, ids.length, `${label} models 候选链不得含重复项`);
    assert.match(text, new RegExp(`^thinking: ${thinking}$`, "m"), `${label} thinking 级别必须为 ${thinking}`);
  };
  assertModelChain(reviewer, "reviewer", "xhigh");
  assertModelChain(executor, "executor", "medium");
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
  // TDD 默认禁令已全局下放到共享规范（AGENTS_SHARED），executor 正文不得再携带 TDD
  // 指令，也不得以测试断言恢复 TDD 要求；职责边界（不得委派）必须保留。
  assert.doesNotMatch(executorBody, /TDD/i);
  assert.match(executorBody, /不得委派/);
});
