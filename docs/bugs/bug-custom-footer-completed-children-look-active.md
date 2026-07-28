# Bug：完成的 Subagent 在 footer 中看起来仍在运行

## 1. 现象

Subagent 完成很久后仍出现在 footer。运行中与已完成 child 都显示为 `◯ agent`，用户据此判断状态没有刷新。

## 2. 影响

Footer 无法回答“现在是否仍有后台任务”这一高频问题。完成历史与活动任务混在同一紧凑选择器中，随着 recent runs 增加会持续占用宽度并降低扫描效率。

## 3. 稳定复现

1. 派发 async child 并等待 `status.json.state = complete`。
2. 等待 footer 的 500ms reconcile。
3. Child 仍保留在 footer，文本与 running 状态时相同。
4. Reload 后 plain roster 仍按设计保留该完成项。

## 4. 证据

`SubagentSessionBrowserState` 明确设置 `RECENT_RUN_LIMIT = 20`，completion 只更新 state、不删除 child；测试和实施计划均固定了这一行为。每个 child 的 step 状态可以从 `status.json` 独立收敛，混合 completed/failed 也已有测试。`formatBrowserSelector()` 只读取 label/agent，不读取 `child.state`；`⏺/◯` 只表示当前 viewport 选择，不表示 lifecycle。

因此现场主要不是 poll 失效，而是“有意保留 history + 完全不展示状态”的表达缺陷。只有 completion event 丢失且 artifact 永久不可读时，才可能真正长期保持旧状态。

## 5. 根因

同一个 roster 同时承担活动监控和历史浏览，却没有 active/history 分区，也没有运行、完成、失败状态 glyph。Footer 将历史入口呈现成了活动任务入口。

## 6. 修复与验证策略

推荐把 footer 默认 roster 限定为 active children；completed/failed/stopped 等终态进入独立 Recent/History 浏览集合，避免立即删除 transcript 入口。进入 browser 后通过明确分区访问 history，状态使用 `●` running、`✓` completed、`✗` failed 等 glyph；`⏺/◯` 继续只表示 viewport selection。

若不实现分区，最低限度必须在单列表中显示 lifecycle glyph。测试应覆盖 active 优先、terminal 分区、混合 workflow、完成时 footer 消失或迁移、history 上限、reload reconciliation 和不可读 artifact 的 unknown 状态。

## 7. 验证结果

用户在真实 iTerm2 确认 active 与 terminal 生命周期 glyph 正确，Child browser 中完成项显示 `✓/✗`；所有 Child 完成后空闲主 Footer 不再保留 `history N`，但 `Alt+O` 仍能浏览 retained history。最终扩大回归 158/158 通过。
