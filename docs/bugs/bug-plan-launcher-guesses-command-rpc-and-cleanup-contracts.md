# Plan Launcher 猜测命令、RPC 与清理契约

## 现象

Launcher 用 `registerCommand(..., { execute })` 注册命令，但 Pi 0.80.6 要求 `handler`；它从 spawn 返回值顶层读取 `runId/asyncDir`，而已验证的 stable RPC v1 返回 `result.details`。交互入口缺少确认实现时仍继续，失败回滚则调用只接受 validated HEAD 的删除函数并吞掉错误。Plan Runner profile 仍加载 `plan-capsule.ts`，新建装配入口没有生效。

## 影响范围

真实 `/plan-run` 不可调用；即使绕过命令注册，Parent 会持久化含 `undefined` 的无效 handle。交互模式可未经授权创建 commit worktree，spawn 失败会遗留 worktree/branch/lease，Plan child 也只能加载无依赖的 fail-closed Capsule，无法执行计划。

## 复现步骤

对照 Pi `ExtensionAPI.registerCommand` 类型可见字段为 `handler`。对照 `test/pi-subagents-runtime.integration.mjs` 的真实报告可见 run identity 位于 `spawned.details`。令 spawn 抛错后，`removePlanWorkspace(lease,{requireValidatedHead:undefined})` 必然拒绝并被静默忽略。读取 `plan-runner.md` 可见它未引用 `plan-runner.ts`。

## 根因

Task 12 测试只调用自定义 mock 的 `.execute()`，并伪造了与真实 stable RPC 不同的返回结构；测试没有以 Pi 类型、已有 compatibility probe 和 workspace 删除约束为 contract。实现为满足静态源码断言创建装配文件，却没有验证 profile 实际加载链路。

## 修复方案

测试改用真实 `handler(args,ctx)` shape 和 `{details}` RPC result。交互确认从真实 `ctx.ui.confirm` 获取，缺失即 fail-closed；headless 授权从明确命令参数或注入调用边界读取。新增仅供“创建后尚未持久化启动”的 lease 安全回滚 API，校验 owner 后移除 clean worktree/branch/lease，失败必须上报。profile 加载真实装配入口；装配依赖通过 child 可读取的持久化 bootstrap，而非 Parent 闭包或占位函数。

## 验证方式

新增真实 command/RPC shape、无 UI 确认、spawn 不完整返回、spawn 失败无残留、装配入口实际被 profile 加载等 RED。修复后运行 Launcher/Workspace/Capsule 目标测试与完整单元测试，Task 13 再跑真实 child E2E。
