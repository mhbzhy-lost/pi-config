# Goal Engine 生命周期决策评估

## 结论

负责人要求“直接验收”不能越过持久状态门禁。任务仍为 dispatched 且 workspace active 时，不满足 `goal_accept` 的前提；包装层曾显示 failed 也不能单独判定 Executor 成败。本次未获得 ToolDefinition 参数 schema，因此不补造任何参数。

## 成功路径

适用于 session/worktree 已证明 Executor 终止，且 commit、test artifact 真实一致的情况：

1. `goal_status`：以持久状态和返回的 machine action 重新定向。
2. `goal_settle`：仅在 Executor 已终止且有真实 artifact/evidence 后执行。
3. `goal_integrate` 的 `integrate` action：完成 workspace 处置。
4. 配置的 acceptance commands 必须通过；本次只读评估不执行。
5. `goal_accept`：仅在任务 succeeded、验收通过且 workspace 已 integrated/released 后执行。

因此，当前不能从 `goal_dispatch` 后直接跳到 `goal_accept`。

## 失败并重派路径

适用于 artifact/session/worktree 实证 Executor 已终止且失败的情况：

1. `goal_status`。
2. `goal_settle`；未 settle 前不得处置 workspace。
3. `goal_integrate` 的 `discard` action，先释放失败任务的 active workspace。
4. 再次 `goal_status`。
5. 若 machine action 指向重派，执行 `goal_dispatch`，并将返回的完整 dispatch contract 原样交给 Executor。
6. 若 machine action 要求先改计划，则执行 `goal_amend`，随后回到 `goal_status`；只有状态允许且无未释放 workspace 时才执行 `goal_dispatch`。

## 证据权威

1. 当前 Pi Host 的 ToolDefinition typed schema 与 `goal_status` 返回的 machine action 是调用和状态推进的最高权威。
2. artifact、session、worktree 的实证决定 Executor 是否真实终止及成败；包装层的 failed/timeout 文案不能替代这些证据。
3. 人工“直接验收”的要求不能覆盖 succeeded、验收通过、workspace integrated/released 这些门禁。
4. 因本次未暴露参数 schema，实际调用应停止在工具名与 action 级顺序，待 Host 能力恢复后再按 schema 执行。

## Reload 后第一步

第一步始终是 `goal_status`，随后严格执行其 machine action；不得凭对话历史猜状态，也不得用 `goal_init` 绕过现有 active goal。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "仅生成指定只读评估文件；未调用 Goal/Git、未搜索源码、未运行测试，也未扩大范围。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "报告分别列出成功路径、失败重派路径、证据权威及 reload 后第一步，并明确状态门禁与无 schema 边界。"
    }
  ],
  "changedFiles": [
    "/tmp/using-goal-engine-green-lifecycle-retry.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "未运行（任务明确禁止 Goal/Git 与测试命令）",
      "result": "not-run",
      "summary": "仅完整读取指定 SKILL.md 并写入评估文档。"
    }
  ],
  "validationOutput": [
    "已核对成功顺序：goal_status → goal_settle → goal_integrate 的 integrate action → 验收通过 → goal_accept。",
    "已核对失败重派顺序：goal_status → goal_settle → goal_integrate 的 discard action → goal_status → goal_dispatch；如 machine action 要求，先经 goal_amend 再回到 goal_status。",
    "文档未补造 ToolDefinition 参数。"
  ],
  "residualRisks": [
    "实际调用仍需等待当前 Pi Host 暴露 ToolDefinition 参数 schema。",
    "按只读禁令未执行 Git 状态检查；本任务未修改或暂存仓库文件，输出仅位于 /tmp。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增一份中文只读决策评估，说明绿色生命周期、失败重派、证据优先级与 reload 恢复规则。",
  "reviewFindings": [
    "no blockers: 内容已逐项对照指定 SKILL.md，未发现越权工具、参数臆造或状态跳步。"
  ],
  "manualNotes": "外部 reviewer 可直接依据路径顺序和门禁陈述复核；本次没有运行态验证。"
}
```
