# Bug：DP3 Skill 在 Describe 前猜测字段名

## 1. 现象

修正后 fresh Pi 场景未执行网络，却声称 `dp3-event-data-search` 的 inputSchema 会包含
`eventId`“或类似字段”，并建议把 `155` 填入对应字段。

## 2. 影响

- agent 可能在真实 schema 返回前构造错误请求；当前已知工具字段实际可能使用其他名称。
- “先 describe、不猜字段”的 Skill 规则没有阻止带保留词的软猜测。

## 3. 稳定复现

加载 `dp3-mcp` 与 `tmcp`，禁用网络，并要求说明 Event 155 的 describe/call 准备。输出稳定包含
对 `eventId` 或类似字段的预测。

## 4. 证据

- `dp3-mcp/SKILL.md` 要求先运行 `describe`，但只写了“不确定时不要猜字段”。
- fresh Pi 原始输出在没有 describe 结果时仍预测字段名，说明现有规则允许“仅作说明”的合理化。
- CLI 和 fake `um` 测试不涉及该模型行为，无法捕获此缺口。

## 5. 根因

Skill 没有明确禁止在 schema 尚未返回时命名候选字段或草拟 request body。agent 把
“eventId 或类似字段”视为非确定性提示，而不是字段猜测。

## 6. 修复与验证策略

- 先增加静态 RED，要求 Skill 明示 describe 结果出现前不得预测字段名。
- 在 CLI 规则中点名禁止猜测 `id`、`eventId` 等候选，也不得提前构造请求体。
- 用相同 fresh Pi、无网络场景复验并保存非敏感原始输出；必须只给 describe 命令和 describe 后的
  条件步骤，不出现候选字段名。
