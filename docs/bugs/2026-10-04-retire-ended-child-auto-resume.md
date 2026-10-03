# 结束 child 不再自动 resume，改由主 Agent 接管 merge queue

产品语义：child 生命周期结束且 merge queue 未完成时，系统继续保留 queue/worktree/proof/owner 检查和 durable resume intent，但不再调用 upstream resume 拉起已结束 child。coordinator 生成明确主 Agent handoff 文本，主 Agent 接管 worktree、提交未提交修改并完成 merge queue。普通控制面 resume 与运行中 child 的 lease heartbeat renewal 不变。

T7 上游 `subagentOnlyExtensions` 传播缺陷因此不再是本产品路径的阻塞；测试改为验证不调用 resume、handoff 可观察且 intent 不静默丢失。
