import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test.todo("reviewer admission/discovery moves to the public registerAgent API (T7-T9 follow-up)");

test("agent profiles keep runtime configuration in frontmatter and cannot grant new permissions", async () => {
  const reviewer = await readFile(new URL("../pi/agents/reviewer.md", import.meta.url), "utf8");
  const executor = await readFile(new URL("../pi/agents/executor.md", import.meta.url), "utf8");
  const delegate = await readFile(new URL("../pi/agents/delegate.md", import.meta.url), "utf8");

  // 不得把逐字模型 id 钉进本跟踪测试：`pi/models.json` 按根 AGENTS.md 是 per-machine
  // 且已移出版本控制，模型 id 会随本机可用模型变更（已发生过：GLM-5.3-0.6x → GLM-5.3、
  // 摘除 gpt-6-luna），钉死会造成每次调模型都必须同步改测试。
  // 此处只校验**结构不变量**：models 为非空、形如 provider/model、无重复的候选链。
  // thinking 同样按角色/机器调优（当前实况 executor=high、delegate=low、reviewer=xhigh），
  // 不逐字锁定：只校验 frontmatter 恰好声明一个合法级别枚举。
  const assertModelChain = (text, label) => {
    const block = text.match(/^models:\n((?:  - \S+\n)+)/m);
    assert.ok(block, `${label} frontmatter 必须声明 models 候选链`);
    const ids = block[1].split("\n").filter(Boolean).map((line) => line.replace(/^  - /, ""));
    assert.ok(ids.length >= 1, `${label} models 候选链不得为空`);
    for (const id of ids) {
      assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, `${label} 模型 id 必须为 provider/model 形式，实际 ${id}`);
    }
    assert.equal(new Set(ids).size, ids.length, `${label} models 候选链不得含重复项`);
    assert.match(text, /^thinking: (minimal|low|medium|high|xhigh|max)\n/m, `${label} thinking 必须为合法级别枚举`);
  };
  assertModelChain(reviewer, "reviewer");
  assertModelChain(executor, "executor");
  assertModelChain(delegate, "delegate");
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
  assert.match(executor, /^tools: read,write,edit,bash,grep,find,ls$/m, "executor tools 面必须保持只含实现/验证工具");
  assert.match(delegate, /^tools: read,write,edit,bash,grep,find,ls$/m, "delegate tools 面必须保持只含实现/验证工具");
  assert.match(reviewer, /^tools: read,grep,find,ls,bash$/m, "reviewer 保持只读工具面，不得获得写权限");
  // 正文/description 文案是单一事实源（profile 文件本身），不在此逐字锁定；
  // 角色能力边界由上方 tools 面与 frontmatter 结构断言约束。
  assert.doesNotMatch(executor, /^temperature:/m);
});
