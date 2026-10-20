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

test("agent profiles keep runtime configuration in frontmatter and cannot grant new permissions", async () => {
  const reviewer = await readFile(new URL("../pi/agents/reviewer.md", import.meta.url), "utf8");
  const executor = await readFile(new URL("../pi/agents/executor.md", import.meta.url), "utf8");
  const delegate = await readFile(new URL("../pi/agents/delegate.md", import.meta.url), "utf8");
  const reviewerBody = reviewer.split("---\n").at(-1);
  const executorBody = executor.split("---\n").at(-1);
  const delegateBody = delegate.split("---\n").at(-1);

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
  assertModelChain(delegate, "delegate", "high");
  const subagentConfig = JSON.parse(await readFile(new URL("../pi/extensions/subagent/config.json", import.meta.url), "utf8"));
  // 用户裁决（2026-10-19）：移除 provider 硬编码黑名单。该 key 既不被上游消费，也不被本仓 runtime 读取，
  // 保留会造成“仍有黑名单”的误导；模型可用性权威是 registry/profile 候选链与 runtime 校验。
  assert.equal(Object.hasOwn(subagentConfig, "providerBlacklist"), false, "config.json 不得保留已废弃的 providerBlacklist");
  // systemPromptMode: append 是用户明确授权的 M07 决策：Pi 原生 preamble/tools/rules 保留，
  // 角色正文作为 addendum 追加；配置事实必须留在 frontmatter，正文不承担配置职责。
  // 工具面即权限面：逐字固定三份 profile 的 tools，角色正文或后续改动不得扩大；
  // 委派与受管 workspace 处置工具属于父会话，child profile 一律不持有。
  for (const [text, label] of [[reviewer, "reviewer"], [executor, "executor"], [delegate, "delegate"]]) {
    assert.match(text, /^systemPromptMode: append$/m, `${label} 必须显式声明 systemPromptMode: append`);
    assert.doesNotMatch(text, /^inheritGlobal:/m, `${label} 不得设置 inheritGlobal`);
    assert.doesNotMatch(text, /^tools:.*(?:subagent|worktree)/m, `${label} tools 不得包含委派或 workspace 处置工具`);
    // contact_supervisor 由上游 child runtime 按 supervisor channel metadata 注册，属不可 gate 的 INTERNAL_TOOL；
    // profile 不声明它是正确做法，不得以断言把它钉回白名单。
    assert.doesNotMatch(text, /^tools:.*contact_supervisor/m, `${label} 不得在 profile tools 声明 contact_supervisor`);
  }
  assert.match(executor, /^tools: read,write,edit,bash,grep,find,ls,apply_patch$/m, "executor tools 面必须保持只含实现/验证工具");
  assert.match(delegate, /^tools: read,write,edit,bash,grep,find,ls,apply_patch$/m, "delegate tools 面必须保持只含实现/验证工具");
  assert.match(reviewer, /^tools: read,grep,find,ls,bash$/m, "reviewer 保持只读工具面，不得获得写权限");
  // reviewer 的只读属性必须对派发方可见：description 是 roster/派发决策入口，必须明写无写入能力。
  assert.match(reviewer, /^description: .*只读.*$/m, "reviewer description 必须强调只读属性");
  assert.match(reviewer, /^description: .*(?:无写入|不得用于落盘).*$/m, "reviewer description 必须说明不能承接落盘任务");
  // 角色职责保留在正文（不再把正文出现“runtime”等字样本身当违规，配置事实改为验证
  // frontmatter）：审阅只读职责与发现格式、执行验证职责、委派边界与共享规范引用。
  assert.match(reviewerBody, /计划执行前.*(?:审阅|审查)/);
  assert.match(reviewerBody, /计划执行完成后.*核对/);
  assert.match(reviewerBody, /偏差/);
  assert.match(reviewerBody, /改进建议/);
  assert.match(reviewerBody, /只读/);
  assert.match(reviewerBody, /严重性.*路径.*证据.*影响.*建议/);
  assert.doesNotMatch(executor, /^temperature:/m);
  // TDD 默认禁令已全局下放到共享规范（AGENTS_SHARED），三个 profile 的 frontmatter 与正文都
  // 不得携带 TDD 流程，也不得以测试断言恢复 TDD 要求；职责边界（不新增委派）必须保留。
  for (const [body, label] of [[reviewerBody, "reviewer"], [executorBody, "executor"], [delegateBody, "delegate"]]) {
    assert.doesNotMatch(body, /TDD/i, `${label} 正文不得携带 TDD 流程`);
    assert.match(body, /AGENTS_SHARED/, `${label} 正文必须引用共享规范而不复制其安全清单`);
    assert.match(body, /(?:不新增委派|不得委派)/, `${label} 必须保留不新增委派边界`);
  }
});
