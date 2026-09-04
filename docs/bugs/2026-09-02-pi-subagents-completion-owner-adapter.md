# 自定义 completion notifier 缺少 upstream completionOwnerId

## 现象

项目在接入 `pi-subagents@0.62.0` 时启用了自定义 completion notifier，以保留项目自己的标题装饰和 upstream completion suppression。该 notifier 收到正常 `subagent:async-complete` 事件后，`complete` 与 `failed` 终态都没有投递到主 Agent。

## 来源与分类

这是预期 production 数据未被正确处理（AGENTS 第 1 类）：

- 入口是 `pi/extensions/subagent-runtime.ts` 的真实 upstream bootstrap 和 completion notifier factory；
- upstream 在 `src/extension/index.ts` 创建权威 `SubagentState`，其中 `completionOwnerId` 由 `currentCompletionOwnerId()` 生成；
- 子代理完成事件由真实 `pi-subagents` runtime 生成，并携带同一 `sessionId` 与 `completionOwnerId`；
- 项目 notifier factory 另建的 state 只更新 `currentSessionId`，缺少 owner 字段，导致 ownership 判断失败；不是手工拼接 projection、缺字段 mock 或不可达状态。

## 首个偏离点与调用链

```text
pi-subagents extension bootstrap
  -> SubagentState.completionOwnerId = currentCompletionOwnerId()
  -> async runner writes completionOwnerId
  -> subagent:async-complete event
  -> project completionNotifierFactory(api, state)
  -> state.currentSessionId updated, state.completionOwnerId remains undefined
  -> registerSubagentNotify.ownsResult(sessionId, completionOwnerId)
  -> owner mismatch
  -> complete batched item / failed immediate item rejected
  -> pi.sendMessage never called
```

## 修复

项目 notifier state 必须直接使用 upstream 同一 `currentCompletionOwnerId()` 结果。这样保留现有 `suppressCompletionNotifications` 语义，同时让 complete/failed 终态由项目 notifier 正常投递。不得放宽 owner 校验，也不得把缺失 owner 当作当前 owner。

## 残余风险

owner 是单个 parent Pi 进程跨 extension reload 稳定的全局 identity；若未来 upstream 改变生成或持久化语义，项目必须继续从 upstream 导入该 helper，不能复制实现。
