# 下线结束 child 自动恢复，保留主 Agent 接管检查

产品裁决：child 生命周期结束且 merge queue 未完成时，继续生成并持久化 resume intent，保留 queue/worktree/proof/owner 检查；不再调用 upstream `resume`，避免从已结束生命周期自动拉起 child。coordinator 通过 `subagent-integration-handoff` 向主 Agent 发送可执行文本，主 Agent 接管 worktree、提交未提交修改并完成 merge queue。

普通控制面 resume、运行中 child 的 authority lease heartbeat renewal、workspace cleanup 与 fail-closed 状态不在本次下线范围。
