# 恢复后的 subagent footer 丢失标题

## 现象

同一 `runId` 的 subagent 已收到终态记录后，主 agent resume 产生再次带 `title` 的 `subagent:async-started` 事件。footer 的 selector 仍显示无标题的 agent（或此前持久化的旧标题），而不是恢复事件携带的新标题。

## 数据来源与分类

这是预期 production 数据未被正确处理（AGENTS 第 1 类）：数据来自真实 subagent async runner 的终态记录和 resume/start 生命周期事件，`runId`、`sessionId`、`asyncDir`、`cwd` 与用户 dispatch `title` 均属于正常事件字段；不是手工 projection 或 mock 调用次数问题。

## 首个偏离点

`SubagentSessionBrowserState.trackStarted` 找到已有 `runId` 时只补充缺失的 `sessionId` 即返回，未将恢复事件中的 `title` 更新到已有 `BrowserChild.label`。随后 selector 按 `runId` 查询 title registry，未有新 registry 标题时只能使用旧 label 或 agent fallback。

## 完整调用链

```text
subagent async runner
  -> subagent:async-complete(runId, terminal state)
  -> custom-footer lifecycle handler
  -> SubagentSessionBrowserState.trackCompleted
  -> run remains in terminal roster
  -> same runId is resumed
  -> subagent:async-started/resume(runId, title, sessionId)
  -> SubagentSessionBrowserState.trackStarted
  -> existingRun branch updates sessionId and returns (title dropped)
  -> snapshot().children
  -> formatBrowserSelector
  -> title registry by runId, then BrowserChild.label, then agent
  -> footer displays stale/empty title
```

## 修复边界

- existing run 收到合法 resume/start `title` 时，仅更新该 run 的显示 label，并保留原有执行 identity、runId、children index 与 session 生命周期语义；必要时同步 resume 的 session metadata。
- selector 继续按 `runId` 优先使用权威 title registry，并以 `BrowserChild.label` 作为无 registry 标题时的 fallback。
- 不改变终态分类、历史保留、upstream 事件脱敏或 footer 排版；本记录对应的最小回归测试只验证真实 `SubagentSessionBrowserState` 到 `formatBrowserSelector` 的行为。

## 当前验证状态

本轮仅建立 TDD RED：production 修复留待后续任务。预期新增回归断言在当前实现中失败，证明 resume title 在 existing-run 分支丢失。
