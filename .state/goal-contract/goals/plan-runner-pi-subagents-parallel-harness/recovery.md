# Recovery: plan-runner-pi-subagents-parallel-harness

Read these files before acting:

1. `.state/goal-contract/registry.json`
2. this file
3. `state.json`
4. `goal-contract.md`
5. `feature-list.json`
6. last 20 lines of `evidence.jsonl`
7. `amendments.jsonl`
8. `docs/superpowers/plans/2026-07-24-plan-runner-pi-subagents-parallel-harness.md`

## Current State
- Status: completed
- Phase: completed
- Current slice: none
- Tracked plan: 14 Task、30条依赖边；14/14完成
- Audited package: current `pi-subagents@0.37.0`; original compatibility audit covered `0.35.1` gitHead `d6e8005e3958adea634bf27c615abac7407aedc4`

## Compatibility Findings
- Pi 0.80.10、0.81.1、0.82.0均可加载0.35.1 root extension并响应RPC；Task 1真实门禁当前在Pi 0.82.1通过。
- 标准`pi install npm:pi-subagents@0.35.1`不安装可选peer`typebox`。
- 从0.34.0升级到0.35.1会移除旧版直接依赖的`typebox`。
- 缺少`typebox`时detached async runner在导入`typebox/compile`时失败。
- 本机`pi/npm`当前显式锁定`pi-subagents 0.37.0`和`typebox 1.1.38`；Task 12/13真实Standalone双root smoke均通过。
- 上游Unreleased已包含host TypeBox compiler解析修复，尚未发布。
- 0.35.1提供child `subagent_wait`，但不提供child RPC/delegation bridge或nested Supervisor parent channel；批准架构不再依赖这些child能力。
- nested event超过1000后仍会重新处理旧文件；Executor无`subagent`能力，Task 1在Executor阻塞于Supervisor期间证明nested event文件为0，允许一个root route元数据文件。
- Native Supervisor request不会立即唤醒正在阻塞的`subagent_wait`；已实现“pending -> 1秒有界wait -> pending”控制循环。
- Standalone Host移除继承的`PI_SUBAGENT_PARENT_SESSION`后由新进程建立自己的session identity；遇到child/fanout环境仍fail closed。
- Task 2完成`pi-plan.v2` parser与IR：repo-relative allowedPaths、资源容量、稳定hash/fingerprint和并发所有权冲突检查；v1固定SHA保持不变。
- Task 13已删除通用Runtime五文件和三套旧测试，薄Host内聚spawn/signal，Plan widget改读typed artifacts；迁移边界19项和删除后真实smoke通过。
- Task 12真实双root parallel-success smoke已通过：Plan为validated，两个Attempt共享base/独立cwd，README.md和worker.txt产物精确，组合故障矩阵116项通过。
- 真实smoke修复记录见`docs/bugs/bug-plan-harness-smoke-blocked-after-dispatch.md`：RPC UUID/sessionFile、Standalone route继承、spawn可见性竞态和runtime artifact cleanup均已全链路复测。
- Task 14最终门禁通过：自动测试410项、真实Pi Skill 1项、Standalone subagents 3项、Plan领域2项、真实Harness 1项全部通过；Doctor为ok，diff check clean，独立artifact review为ACCEPT。
- 独立代码/安全审查的有效finding已修复：dispatch uncertain、未记账cherry-pick恢复、Host processIdentity、Attention retry/recover轮询、output binding及0700/0600权限均有回归测试。
- Task 11完成当前v3 Host handle、Standalone process/session、Root shutdown生存、typed Attention ref和legacy migration fail-closed；Host/Launcher定向测试22项通过。
- Task 10完成单Writer queue、Plan order、owner token、conflict abort、validation enqueue和workspace cleanup；定向14项通过。
- Task 9完成单commit/非merge/clean、allowedPaths/rename/symlink和controlled command evidence门禁；定向26项通过。
- Task 8完成active control loop、native Supervisor request持久化、Root command inbox、reply成功后resolve和Standalone backend装配；定向37项通过。
- Task 7完成authorize-dispatch-bind、直接Backend多root派发、无tool返回、乱序settle和保守dispatch恢复；定向17项、组合103项通过。
- Task 6完成requestId-fenced RPC client、PiSubagentsExecutionBackend、lifecycle/session/cwd绑定和artifact权威读取；单元20项、真实Standalone 3项通过。
- Task 5完成deterministic ResourceClaimSet、active claim重放、路径exclusive和deadlock区分；资源授权/IR测试27项通过。
- Task 4完成per-attempt真实Git worktree、owner token lease、Plan status授权释放与失败保留；Task 3/4组合回归37项通过。
- Task 3完成Attempt/Attention/Integration reducer、单blocking request、projection version fencing与状态脱敏；Task 2/3组合回归51项通过。

## Approved Architecture
用户已批准Standalone Plan Runner加薄Host Runtime：Host只管理Plan Runner进程；Plan Runner加载官方完整pi-subagents服务；Executor通过公开RPC运行；Root往返通过durable Plan Control/Attention完成。

## Next Action
本Goal已完成。Crash Fix V2启动前建立独立Goal Contract，并把本Goal的completed状态作为A-H Lane前置证据。

## Warnings
- 不得把child extension提前return误解为child进程退出。
- 不得通过清除`PI_SUBAGENT_CHILD`或`PI_SUBAGENT_FANOUT_CHILD`绕过child-safe边界；薄Host遇到child环境必须fail closed。只移除继承的`PI_SUBAGENT_PARENT_SESSION`并验证新session identity。
- Task 1兼容门禁已通过；任何Pi、pi-subagents或TypeBox版本变化都必须重新执行。
- 旧runtime integration绑定的`Qwen3.7-Max-DogFooding`已下架；协议门禁必须使用本地`fake/deterministic`provider。
- 当前`pi-config`工作区包含用户已有未提交修改；`plan-runner-dependencies.mjs`中的并行`spawnPiAgent`半成品是迁移输入，不是可回退基线。
