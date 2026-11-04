# goal-runtime 可用性缺陷实测报告（2026-11-04）

一晚完整实测：goal-runtime.plan.v1 计划（yugang engage next-only + 弹药补货，planId b93ae48c）从绑定、T1 执行、child 复活、集成发布到最终死锁的全过程。四个阻塞缺陷 + 一个运维语义确认 + 若干防误判澄清，全部带源码定位与证据坐标。

## 时间线（本地时间）

1. 23:5x 绑定成功（rev 4），T1（executor，worktree ff4e45f5）派发
2. 01:2x T1 完成：代码正确、验收全过，但 **child 未在其 worktree 内提交**，run 终结时集成队列项（979903af）无法发布
3. 主代理接管 worktree 提交（6dbb51b）并清理 origin 阻塞
4. 01:3x 经 subagent_run_resume 复活 child（新 run ebb0e5ec）补完收尾 → 队列 rebase-ff 发布进**本地 origin main**（81dc5f3，01:50:07 completed）→ workspace released
5. 但 goal 引擎侧 T1 事实链断裂：terminalProofRef/integrationReceiptRef 清零，blocker=PLAN_EXECUTION_FACTS_UNAVAILABLE
6. `/plan resume` 多次：命令生效（JSON 即成功输出）但 reconcile 无事实可推进，且每条普通用户消息重新 paused
7. `/plan cancel` 成功 → 重新 plan_execute 被 GOAL_CANCELLED_REPLACEMENT_REQUIRED 挡死（缺陷④）
8. 删除 goal 存盘文件 → 本会话内 plan_execute 仍被旧实例拒绝（缺陷⑤）
9. 最终绕过：放弃 goal 实例，T2/T3 经典 subagent 派发 + 契约检查命令手工验收

## 缺陷①：typed-resume 后任务事实绑定断裂，无自愈

- 现象：child run 被 `subagent_run_resume` 复活后，引擎 T1 的 `terminalProofRef`/`integrationReceiptRef` 归零，blocker=PLAN_EXECUTION_FACTS_UNAVAILABLE，永不解除；引擎永远等待旧 run（8bd518a5）的事实，而事实已随复活链转移到新 run（ebb0e5ec）。
- 位置：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2254-2263`（resume 绑定要求 `plan.intent.sourceProofId === facts.terminalProofRef` 且 runId 不变，复活链两项都不满足）。
- 期望：resume 血缘产生新 run 时，goal 引擎应重绑 task.run 至最终 run 并继承闭合事实（或显式标记需人工闭合并给出可执行的 typed 路径）。

## 缺陷②：集成队列完成回执没有通往 goal 引擎的送达通道

- 现象：integration-queue 台账 `state=completed`、带 workspaceDispositionReceiptId（01:50:07），但引擎 `reconcile` 只认 run 事实；集成事实变化不触发任何唤醒/结算。
- 位置：`src/goal-runtime/continuity.ts:111-135`（control/resume → `runtime.reconcile(session)` 是唯一推进点）；`packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`（队列侧无 goal 通知钩子）。
- 期望：队列 completed/preserved 事件应泵送为 goal 引擎的订阅事实（先例：recovery intent 的 handoff 泵送机制在 subagent-runtime.ts 已存在，集成回执缺同款通道）。

## 缺陷③：resume 不唤醒 turn + 用户消息即暂停（UX）

- 现象 A：`/plan resume` 生效（JSON 是设计内的成功输出），但 `reconcile` 无可派发事实时不排续跑 turn——用户观感「resume 无效」。
- 现象 B：`pi.on("input")` 对每条非 extension 输入都把 active 打回 paused，实操要求「resume 后零用户消息」，交互上极易踩雷。
- 位置：`src/goal-runtime/continuity.ts`（registerCommand("plan") 与 pi.on("input") 段）。
- 期望：resume 后无事实可推进时给出明确 notify（「已恢复，等待 XX 事实」）；或提供 resume 顺带触发一次 reconcile-wake 的语义。

## 缺陷④：cancel→replace 门死锁

- 现象：/plan cancel 成功后，重新 plan_execute 恒被 `GOAL_CANCELLED_REPLACEMENT_REQUIRED: 取消计划仍有未闭合运行或资源` 拒绝；plan_retry 对已结束计划返回 GOAL_NOT_ACTIVE → 实例既不能修也不能换，永久卡死。
- 位置：`src/goal-runtime/scheduler.ts:344-376`（replaceCancelled：对每个有 run 的任务 `execution.inspect(task.run)` 后要求 `sameRun && closed(fact)`）；`scheduler.ts:69-72`（closed = provedTerminal ∧ integrated ∧ released ∧ recovery=none ∧ blocker=null）；`scheduler.ts:58-63`（provedTerminal 要求 terminalProofRef 非空、integrated 要求 completed+receipt）。
- 死锁成因：缺陷①清零了两个 ref；集成回执挂在复活 run 的队列项（childRunId=新 run），`inspect(旧run)` 永远给不出 completed+receipt → closed() 恒假 → 门恒关。
- 期望：replaceCancelled 的 inspect 按 resume 血缘解析最终 run；或接受 integration-queue 台账的 completed/workspaceDispositionReceiptId 作为 integrated 证据；或提供 admin 强制闭合命令（核实资源已 released/queue completed 后清 task.run 引用）。

## 缺陷⑤：删除 goal 存盘文件不清运行时内存态

- 现象：直接删除 goal 存盘文件后，同会话内 plan_execute 仍被旧 cancelled 实例的替换门拒绝（引擎持内存态实例，读不到盘不等于不存在）。
- 期望：至少在 plan_execute 的错误里指出「实例仍在会话内存中，需重启会话/提供强制清理命令」；理想是 store 读不到时按无实例处理并允许新绑定（或确认当前会话 runtime 生命周期设计后补文档）。

## 运维语义澄清（防误判，实测确认非 bug）

1. **集成队列发布目标 = 本地 origin 仓 main**（rebase-ff + fast-forward 本地 main），**不推 GitHub**。排查发布时先看本地 main 与 reflog，不要只看远端。
2. worktree 原提交对象在 rebase 发布后变为不可达并被清理（cat-file 查无）——**不等于代码丢失**；以队列台账 candidateHead 与本地 main reflog 为准。
3. 父侧 `managed_workspace_dispose(integrate)` 对 publication=allowed 的工作区返回 CHILD_OWNS_INTEGRATION 是护栏设计，非故障。
4. **child 必须在 run 终结前在自己的 worktree 内提交**——未提交状态下 run 结束，队列项发布不了（本次问题的起点）。建议在 coding 派发合同里把「结束前显式路径 git add + commit」写成必做步骤。

## 证据坐标

- 队列台账：`pi-config/var/workspaces/repositories/784d2e1d…/integration-queue/979903af….json`（completed 2026-11-03T17:50:07Z、candidateHead=81dc5f3、childRunId=复活 run）
- 本地 main reflog：`merge 81dc5f3…: Fast-forward`
- goal 快照：rev 11（cancelled，T1 两 ref null、blocker=PLAN_EXECUTION_FACTS_UNAVAILABLE）
- 持久笔记：`main/pi-infra/goal-runtime-可用性缺陷记录-2026-11-04` 与 `main/pi-infra/goal-runtime-缺陷④cancel-replace-门死锁-2026-11-04`

## 修复优先级建议

1. 缺陷④ + ①（同根）：replaceCancelled/refreshRuns 按 resume 血缘解析最终 run——解锁「死实例可替换」，这是自愈路径的咽喉
2. 缺陷②：集成回执 → goal 订阅事实（复用 recovery intent 泵送先例）
3. 缺陷⑤：强制清理/会话内重置命令
4. 缺陷③：resume 的 notify 文案与 wake 语义
5. 文档：上节「运维语义澄清」四条写进 goal/queue 的使用文档
