# Plan Child 丢失计划身份且未授权 Worker 与新 HEAD

## 现象

`plan_open` 后只保存 workspace 与 task ID，未保存 `planPath/planHash`；后续固定读取不存在的 `<worktree>/approved-plan.md`。依赖工厂提供 `authorizeNestedSubagent`，但 Capsule 未注册 `tool_call` hook。workspace HEAD 永久停留在启动 base，worker commit 后 Gate 要求真实 HEAD 等于旧值，验证必然失败。

## 影响范围

真实 Plan child 首次 `plan_continue` 即找不到批准计划；即使测试夹具手工补文件，模型仍可绕过 coordinator intent 调用任意 nested subagent；产生代码提交后四类 Gate 无法绑定当前提交，计划永远不能达到 `validated`。取消操作也缺少 child intent acknowledgement。

## 复现步骤

用 Launcher 启动时检查 worktree，不存在 `approved-plan.md`。搜索 Capsule 无 `tool_call` 对 `subagent` 的拦截。重放启动时 `plan.created` 后在 worktree commit，再调用 `verifyPlan`，`runPlanGates` 因 `projection.workspace.headCommit !== git HEAD` fail-closed。

## 根因

12B 测试自行在 worktree 创建固定文件，并在验证前直接篡改 created fixture 的 `headCommit`，绕过了真实 append-only 生命周期。测试只直接调用 authorization helper，没有验证 Extension hook。计划 identity、HEAD 观察和 cancel control 没有形成持久化领域事件。

## 修复方案

在 `plan.created` workspace identity 中持久化已验证的 `planPath/planHash`，后续始终按该身份重读并复核 hash。Capsule 用 `tool_call` fail-closed 拦截每次 `subagent`，仅接受 coordinator 的一次性精确 intent。新增 workspace HEAD 观察事件：无 active attempt 时记录当前 commit、使旧 Gate projection stale，并允许同类 Gate 在新 HEAD 上产生新的 immutable attempt。实现原子 cancel request/ack，child 先 append `plan.cancelled` 并 ack，Parent 才 stop。

## 验证方式

使用 Launcher 真实 planPath、不创建固定计划副本；测试未授权/偏离 nested call 均被阻断；worker commit 后通过 HEAD 观察在当前 commit 运行 Gate，旧 Gate 不可用于新 HEAD；cancel 测试严格 request→child event→ack→stop。最后运行目标测试与完整 E2E。
