# Custom footer 丢失子代理标题并清空 running child

## 现象

真实 `pi-subagents@0.62.0` 的 `subagent:async-started` 事件可能只包含 `task`/`goal: "[prompt redacted]"`，不携带 dispatch title。项目 typed dispatch 已在 title registry 保存用户标题，但 custom footer 直接把 raw event 交给 Browser state，因此 BrowserChild/footer 只显示 agent，不显示用户 dispatch title。

同时，真实运行中的 status 轮询可能返回 `{ state: "running", steps: [] }`。Browser state 当前把空 steps 映射成空 children，导致已 trackStarted 的 running child 从 selector/footer 消失。终态 `{ state: "complete", steps: [] }` 仍应保留既有清理语义，让 browser 退出。

## 数据来源与分类

两项均属于预期 production 数据未被正确处理（AGENTS 第 1 类）：事件来自公开 typed dispatch、真实 upstream async runner 和正常 status watcher，不是手工 event/projection 或缺字段 mock。首个偏离分别发生在 footer 未查询共享 title registry，以及 active status 空 steps 未按 run state 分类。

## 完整调用链

```text
typed subagent(agent=executor, title=用户标题)
  -> titleRegistry.prepare/remember
  -> pi-subagents 0.62.0 async runner
  -> subagent:async-started(task/goal="[prompt redacted]", title absent)
  -> custom-footer raw event handler
  -> BrowserChild.label absent
  -> footer selector displays only agent

status watcher
  -> status.json { state: "running", steps: [] }
  -> reconcileRun
  -> run.children = []
  -> active selector/footer empty
```

## 修复边界

- footer 在接收 raw start event 时从共享 title registry 消费已准备的 dispatch title，并只把解析出的用户标题作为 BrowserChild label；不得把 typed workflow key 展示给用户；
- active run 收到空 steps 时保留已 trackStarted children 及其 selection；terminal run 收到空 steps 时继续清空并退出 browser；
- 不改变 upstream 脱敏、终态清理或 agent execution identity。

## 残余风险

同一 agent 的多个并发 dispatch 若 upstream 同时只提供脱敏 task/goal，registry 只能按 pending FIFO 关联标题；如果事件顺序与 dispatch 顺序不一致，标题可能暂时错配。typed workflow key 不作为可见 fallback，无法关联时宁可不显示标题。

## Main footer 多 active 折叠补充

production 主界面同时存在多个 active subagent 时，`formatBrowserSelector` 仍复用 child/browser 的选中窗口算法。该算法先构造“第一项 +N”，当这个折叠字符串本身能放入 `safeWidth` 时提前返回，导致 main footer 只显示第一个 active 和 `+3`，其余真实 active 被隐藏。

完整调用链为：真实 async-start roster -> `SubagentSessionBrowserState.snapshot().activeChildren` -> main `formatBrowserSelector` -> selected window 初始仅包含第一项 -> `render()` 生成 `first +N` -> 宽度检查提前返回 -> footer 第二行显示折叠计数。修复后 main 模式在进入窗口算法前分流，所有 active item 分别 wrap 并逐行输出，history 独立置于最后；child/browser 模式继续保留窗口和 `+N` 语义。该变更只影响 TUI 字符串，不修改 roster、event、tool result 或 session 数据。

## 并发标题被二次消费

2026-09-03 的真实 taoappuse session 同时产生 `c58b22be`、`dc6756ae`、`6f5c4d9e` 三个 typed executor run，每个 tool result details 都有独立 title，但 active roster 只有部分条目显示 title，另有裸 `executor`。这是预期 production event 未被 TUI 正确消费。

完整调用链为：typed dispatch 为同一 agent 连续 `titleRegistry.prepare` -> `runtime-membrane.decorateLifecycle(STARTED_EVENT)` 调用 `titleRegistry.started(rawEvent)` 并返回带权威 `event.title` 的新事件 -> custom footer listener 收到带 title 事件 -> 再次调用 `titleRegistry.started(event)` -> 因 task 已脱敏或不能精确匹配而消费下一条同 agent pending FIFO -> 首 run 被错误覆盖为下一 title，后续 run 无 pending title 并退化为裸 agent。首个偏离点是 footer 没有优先使用已经存在的 `event.title`。修复只改变 footer renderer 对事件的读取，不改 event、registry dispatch 事实或 session。

### Reload recovery

旧进程已经可能把缺失或错位的 `BrowserChild.label` 持久化到 roster，reload 会按设计保留这些 active children。typed execute 在 child binding 后仍通过 `titleRegistry.remember(runId, authoritativeTitle)` 保存每个 run 的权威标题，因此 reload 后可从 registry 恢复显示。调用链为：旧错误 start -> 空/错 label 持久化 -> reload/hydrate roster -> registry 仍按 runId 保留权威 title -> selector 若只读 child.label 则继续显示裸 agent/错 title。首个偏离点是 selector display projection 未按 `child.runId` 优先查询 registry。修复仅决定显示标签，不改持久化 roster 或 registry 事实；没有 registry title 的 untyped child 继续使用 child.label/agent。
