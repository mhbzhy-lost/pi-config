# Managed child 自动集成生命周期缺口

## 问题

现有 Completion Guard 只能在 child 结束后提示模型继续调用 `subagent_integration`。prompt 与 guard 都不是可信执行边界：模型可能忽略提示、provider 可能在 follow-up 前失败，reload/Root 关闭也会丢失仅存在于进程内的推进意图。因此，“代码已 clean commit”不能保证 enqueue、admission、Managed Rebase、Publish 与最终 receipt 真正发生。

## 信任边界

Pi 0.85.1 的真实 awaited 时序是：`agent_end` handler 全部完成后，runtime 才检查 handler 排入的 continuation；随后才会进入 `agent_settled`。当前实现的首个偏离点，是 `agent_end` 仅设置进程内 `pending`，直到 `agent_settled` 才调用 trusted `prepareAutoIntegration`。这既错过 Pi 的 continuation 决策窗口，也把正常机械推进绑定到了过晚的 settled 事件。

正常路径必须由 child extension 在 `agent_end` 的 awaited handler 中启动 **Auto Integration（自动集成）**，并通过 Root Broker 的 run grant 获取绑定；`agent_settled` 只记录/补偿观察结果，绝不作为正常启动入口。模型不得提供 workspace path、HEAD、target ref、queue lease、session 或 token。私有事实只可在 extension、Broker、coordinator 与 ManagedWorkspaceService 之间传递，不得进入模型可见 tool result、message 或 TUI。

模型仅在 Managed Rebase 返回真实冲突时获得限定 continuation，用于解决当前冲突并 `git add`；enqueue、等待 admission、`rebase --continue`、重新验证、Publish 和 completion receipt 均由可信状态机完成。每个 admission generation 的无进展 continuation 必须有界；关闭、漂移、Git/provider/Broker 异常必须保留为 preserved/debt，不得自动 abort、stash 或 reset。

## 回归合同

真实事件顺序为：awaited `agent_end` 自动执行 Auto Integration Prepare、等待队首 admission、Managed Rebase、Publish、Inspect；`agent_settled` 仅记录且不得重复启动。无冲突机械阶段不得发送 follow-up。冲突时保留 sequencer/unmerged，由同一次 `agent_end` 最多发送一个限定 follow-up；模型仅解决当前冲突并 `git add`，下一次 `agent_end` 自动 continue/publish。按持久 generation/conflict digest 最多允许两次有进展 continuation；无进展或 Broker/provider/lease/target 异常进入 preserved/debt。

成功不得来自模型文本、TUI 或 `agent_end` payload；只能由 trusted queue `completed`、有效 integration receipt、terminal proof 与 workspace `released` 的组合证明。duplicate/reload/late/dispose 事件必须 generation fenced 且幂等；非 managed、generic、`worktree=false` 与 Goal acceptance child 不创建 Auto Integration record。
