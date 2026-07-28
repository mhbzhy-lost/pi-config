# Progress: plan-runner-pi-subagents-parallel-harness

- Status: completed
- Phase: completed
- Current slice: none
- Completed slices: 14/14
- Tracked plan: `docs/superpowers/plans/2026-07-24-plan-runner-pi-subagents-parallel-harness.md`
- Final verification: 2026-07-26T18:38:35Z

## Completed
- Task 1完成Pi `0.82.0/0.82.1`、`pi-subagents@0.37.0`、`typebox@1.1.38`的Standalone真实兼容门禁。
- Task 2-10完成Typed IR、事件状态机、Attempt worktree、资源锁、官方RPC Backend、并行Coordinator、Attention、Attempt验证和单Writer集成。
- Task 11完成Standalone Plan Runner与thin Host v3迁移；Root shutdown不终止Host，旧v1/v2及缺`processIdentity`的handle fail closed。
- Task 12完成真实双root smoke和组合故障矩阵；Plan到达`validated`，`validatedHead == headCommit`，最终两文件逐字节正确。
- Task 13删除通用自建Executor Runtime五文件和三套旧测试；Plan widget与fleet只读typed状态和官方artifact。
- Task 14完成文档、Doctor、全量/真实门禁、独立产物审查及两轮代码/安全审查。

## Final Evidence
- [Evidence-Backed] `npm test`: 410 passed, 0 failed。
- [Evidence-Backed] 真实Pi Skill integration 1/1、Standalone subagents 3/3、Plan领域integration 2/2、真实Harness 1/1。
- [Evidence-Backed] 最新真实smoke：`lifecycle=validated`，`validatedHead=headCommit=99361d93f4205a954ab9d96b5250f6838550c265`。
- [Evidence-Backed] smoke独立产物验收：`README.md`为`base\nworker\n`，`worker.txt`为`worker-2\n`，恰好两个非merge提交且Attempt已清理。
- [Evidence-Backed] Doctor输出`[ok] Pi Skill allowlist extension is ready`；`git diff --check`无输出。
- [Evidence-Backed] 独立artifact reviewer返回ACCEPT；代码/安全审查发现的dispatch、集成恢复、Host identity、Attention、output binding和权限缺口均有bug文档、RED测试及回归证据。

## Residual Risks
- macOS/Node没有pidfd式原子signal；实现已在每次signal前、stop grace轮询中和SIGKILL前重复核验`processIdentity`，但核验与系统调用之间仍存在不可彻底消除的微小竞态。
- 上游nested event replay超过1000文件的缺陷仍存在；Executor不暴露`subagent`且真实门禁要求`nestedEvents=0`。
- 未来Pi、pi-subagents或TypeBox版本变化必须重跑兼容门禁。

## Next Action
为Crash Fix V2建立独立Goal Contract，将本Harness完成状态作为A-H Lane启动前置条件。
