# 2026-09-17 resolving-conflict 状态的 agent_end 不驱动 rebase-continue 导致 resume 循环空转

## 现象

真实五 child 验收（`2/5/4`，qoder-pool/GLM-5.3-0.6x）第二轮：seq2 进入真实 resolving-conflict，durable resume 机制恢复 6 个 resumed child；模型在第一轮已正确解决冲突（staged、无 unmerged），但每次 resume 后 agent_end 都只产生一个 no-op turn，rebase --continue 从未执行，6 attempt 耗尽后 fail-closed preserve。child 模型自己的诊断文本准确指出："队列未达到其 rebase-continue 步骤"。

## 数据来源与调用链（诊断日志实证）

- 现场：`repository-merge-queue-acceptance-UDZ9NE`（含新加 integration-lifecycle 诊断打点）。
- resumed child 的 events.jsonl `child.stderr` 轨迹：`integration-gate-passed{queueState:resolving-conflict}` → `integration-lifecycle-agent-end` → `integration-lifecycle-prepare-result{queueState:resolving-conflict}` → **无任何 advance-result 日志**。
- 根因：`child-integration-lifecycle` 的 advance 中，admission poll 循环的进入条件不含 `resolving-conflict`（只含 queued/admitted/rebasing/prepared）。prepare 返回 resolving-conflict 时直接落入冲突分支发 CONFLICT follow-up——但冲突已解决，模型 no-op 回复被 acceptance gate 以 "no-staged-files evidence missing" 拒绝，run 终止；coordinator 侧（durable queue state 自动 `continue:true` 的 `advanceAutoIntegration`）从未被调用。

## 首个偏离点

`advance()` 中 poll 循环状态集合遗漏 `resolving-conflict`：conflict continuation 依赖 follow-up 触发模型行为，而非先由 coordinator 执行 durable rebase --continue。

## 修复

- poll 循环进入条件加入 `resolving-conflict`：agent_end 先经 `advanceAutoIntegration`（coordinator 依 durable 状态自动 continue），rebase 完成即 publish/completed；
- CONFLICT follow-up 只在 advance 后仍返回同 digest 未解决冲突时才发（此刻才真正需要模型解决文件冲突）；
- RED/GREEN：`test/subagent-auto-integration-lifecycle.integration.mjs` 新增「resolving-conflict 状态下的 agent_end 直接驱动 advance」「advance 后同 digest 未解决时仍发 follow-up」两测试。

## 分类

预期 production 数据未被正确处理（类别 1）：冲突已被模型解决、sequencer 挂起等待 continue 是正常事件顺序可达的真实状态；R8 scripted fixture 在 resolve 后同 turn 退出走 shutdown→reconcile 路径，未覆盖「已解决冲突后 child 存活并触发 agent_end」的顺序。
