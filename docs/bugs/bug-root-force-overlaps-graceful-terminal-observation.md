# Root force 与 graceful terminal observation 重叠

## 1. 现象

`drainRun()` 的 graceful observation 首次 deadline 到期后，`catch` 立即 `await forceCleanup(run, error)`，而 graceful observation 的资源释放位于外围 `finally`。因此 force 阶段已经开始时，graceful waiter、artifact poll、sleep cancel handle 和 deadline timer 仍由 graceful 阶段 owned；这些资源可继续跨越 recapture、signal、第二个 proof 窗口与 death probe。

## 2. 影响

两个 observation 阶段同时拥有同一 run 的观察资源，可能产生双 poll、双 waiter，或让旧 artifact poll 在 force 阶段晚到并修改 artifact/proof 状态。sleep cancel handle 与 timer 的生命周期也不再属于单一阶段，导致 force 的结果依赖 graceful 异步工作何时结束，而非明确的阶段边界。

## 3. 触发条件与证据

- graceful `Promise.race()` 先以 `TerminalDeadlineError` 拒绝，且该 run 尚无 official proof。
- 当前 `drainRun()` 的 `catch` 在外围 `finally` 前 `await this.forceCleanup(run, error)`；外围 `finally` 才执行 `cancelled = true`、`cancelSleep?.()`、`clearTimeout(timeout)` 与 `waiter.cancel()`。
- exact force success RED：在 `captureProcessBirthIdentity()` 的 recapture callback 中观察 `terminalWaiters`，当前仍含该 run，断言为 `true`；GREEN 应为 `false`。
- late force artifact continuation RED：保持 force artifact read pending；`killProcess()` 同步发出 matching official event，使 event proof 先赢得 proof race。death probe 中释放一个同 run、但 `runnerProcessInstanceId` 不同且有效的 late artifact read。当前 force observation 的 `finally` 尚未执行，late read 会被接受并覆盖 `terminalProof`；GREEN 必须在 death probe 前取消 force observation，使 late read 看到 `cancelled` 且不得修改 proof。

## 4. 根因

实现把“首次 deadline 的错误处理”和“进入 force ownership”放在同一 `catch` 内，却把 graceful cleanup 留在稍后的外围 `finally`。`await` 允许 `forceCleanup()` 在该 `finally` 执行前完成 recapture、signal、force proof observation 和 death probe，故 graceful 与 force 的资源所有权重叠。force observation 本身也必须在进入 death probe 前结束其 waiter、timer 与 poll 的所有权，否则同样会把观察资源跨阶段带入 probe。

## 5. 处理决策

- deadline `catch` 只保存 `TerminalDeadlineError`，不在其中调用 force。
- 外围 `finally` 必须先取消并清理全部 graceful 资源：停止 artifact poll、调用 sleep cancel handle、清除 timer、取消 waiter；完成后才在 `try/finally` 外进入 force。
- force proof observation 同样必须先在自身 `finally` 清理 waiter、timer、poll 与 sleep cancel handle，再执行 death probe。
- 每个 observation 阶段完成资源清理后才转移 ownership；不得以共享 waiter 或继续运行的 poll 跨越 graceful、force proof observation 与 death probe。

## 6. 验证

本文件为 docs-only 缺陷记录，不修改 production 或 tests。future GREEN 至少覆盖以下独立 RED：

- exact force success：recapture callback 观察 `terminalWaiters.has(runId)` 为 `false`。
- force artifact continuation：保持 artifact read pending，令 matching official event 先取得 event proof；death probe 中释放同 run、不同 `runnerProcessInstanceId` 的有效 late read。GREEN 在 probe 前取消 force observation，late read 返回后看到 `cancelled`，不接受该 artifact，death callback 观察到的 `terminalProof` 仍是 event proof 而非 late artifact proof。
- recapture waiter 从当前 `true` 变为 GREEN 的 `false`；late read proof 污染从当前会覆盖 event proof 变为 GREEN 的隔离，且保持 existing exact force、official proof 与 death-probe 语义不变。
