# subagent 详情面板丢失“该 child 用什么模型”

## 用户报告

统一后台活动面板重做后，进入某个 subagent 的详情页面看不到该 subagent 使用的模型；重做之前是可见的。

## 现场与首个偏离点

- 旧实现：`packages/pi-subagents-enhanced/extensions/custom-footer.ts` 的 browser 模式。打开 child 视图时 footer 第二行右侧显示选中 child 的模型（`formatChildModel(child.model, child.thinking)`，形如 `(codex-pool) gpt-6.1-sol`），第三行右侧显示 `thinking: <level>`。
- 重做提交：`634deb4 feat(tui): 接入统一后台活动与只读详情`（2026-10-16）。该提交新建 `packages/pi-subagents-enhanced/src/tui/{background-activity,footer-runtime,subagent-activity}.ts` 与根 `src/background-activity/{detail-controller,presenter}.ts`，并从 `custom-footer.ts` 移除 462 行旧实现。
- 首个偏离点：新的详情壳走 `ActivitySource.detail(key, request)` → `renderChildByKey(...)` 渲染正文，**不再进入旧 browser 选择模式**（不调用 `browser.enter()`、不产生 `snapshot.selected`）。因此 `createFooterComponent` 里 `child ? formatChildModel(...) : currentModel?.id` 的 child 分支在详情态永远不成立，footer 继续显示主会话模型；而详情壳自己的 chrome 只渲染 `› <glyph> <label> · <stateLabel>` 与 `行 x-y/z · 跟随/手动 · x 展开`，没有任何模型字段。
- 数据本身没有丢：`BrowserChild.model` / `.thinking` 仍由 `session-browser.ts` 从 run status 的 step/leafStep 投影（`:290-310`）。丢的是**展示通道**，属显示层回归，不是数据链断裂。

分类：**类别 1（预期 production 数据未被正确处理）**——模型事实由合法 status 投影产生，重做后的详情壳没有消费它。

## 修复（显示层，最小改动）

1. `packages/pi-subagents-enhanced/src/tui/background-activity.ts`：`ActivityRow` 增加**可选** `metaLabel?: string`，明确为只读展示投影，不参与身份/去重/排序；`isActivityRow` 同步接受 `undefined | string`。
2. `packages/pi-subagents-enhanced/src/tui/session-browser.ts`：新增导出 `formatChildModelLabel(model, thinking)`，与旧 footer 完全同格式（`(provider) id`，无 provider 时不伪造）。
3. `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`：删除本地重复的 `formatChildModel`，改为消费同一 helper，保证 footer 与详情壳格式一致。
4. `packages/pi-subagents-enhanced/src/tui/subagent-activity.ts`：新增 `subagentActivityMetaLabel(child)`，行投影带 `metaLabel: "模型 (provider) id · thinking: <level>"`；模型与 thinking 都未知时**不设置该字段**，避免在 chrome 里堆 `no-model` 噪声。
5. `src/background-activity/detail-controller.ts`：详情壳身份行在 `stateLabel` 之后、`过期观察` 之前追加 ` · <metaLabel>`；仍按终端列截断，窄宽不越界。

边界遵守：只改 TUI renderer/展示投影，未改写 agent 实际收到的消息、tool result、event payload、session 内容或结构化 details；未新增第二数据源，未读取 session 正文（模型字段沿用既有 status 投影）。

## 验证

- 新增/迁移断言（用户已授权新增用例）：
  - `test/subagent-activity-provider.test.mjs`：行投影在 `model: "codex-pool/gpt-6.1-sol:high"` + `thinking: high` 时得到 `模型 (codex-pool) gpt-6.1-sol · thinking: high`；裸 id 不伪造 provider；模型与 thinking 均未知时行仍只含协议五字段。
  - `test/background-activity-details.test.mjs`：详情壳 chrome 显示 `metaLabel`，切到无 `metaLabel` 的行时不追加空段、不沿用上一行模型，窄宽不越界。
- 实跑：上述两文件 + `background-activity-layout`、`background-activity-registry`、`task-scheduler-activity`、`bash-async-activity`、`custom-footer-layout` → **129/129 exit 0**（`/tmp/rc-detail-model-label.log`）；`custom-footer-input.integration`、`custom-footer-subagents`、`background-activity-runtime.integration` → **62/62 exit 0**（`/tmp/rc-footer-model-label.log`）；root+package typecheck exit 0（`/tmp/rc-typecheck-model-label.log`）。
- scheduler/bash_async 两类行不提供 `metaLabel`，chrome 与既有断言不变（`task-scheduler-activity` 的“行只含协议五字段”断言仍通过）。

## 未验证

真实 TUI 观感（L3）仍属用户后验：本轮只证明渲染合同与投影正确，不代替用户在真实终端里确认排版满意。若发现宽度/截断观感问题，按新 bug 处理。
