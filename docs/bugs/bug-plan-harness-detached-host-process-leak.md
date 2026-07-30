# Bug: Plan Harness 泄漏 detached Standalone Host 进程

## 症状

开发机同时存在 30 个 `pi` 进程，其中 23 个没有 TTY，已运行 7 至 13 小时。它们的工作目录或启动参数全部指向 `/tmp/pi-plan-amendment-harness-*`、`/tmp/pi-plan-harness-real-*` 或 `pi-plan-host-parent-exit-*`；同时存在 18 个父进程为 PID 1 的 `pi-plan-host-keeper` shell 及其 `sleep 2147483647` 子进程。

## 影响

泄漏进程不会随 Node test 或发起测试的 Pi session 退出。现场 23 个无用 `pi` 合计占用约 1327% CPU 和 39.8% 内存，导致电池快速耗尽、机器持续发热，并污染后续 Harness 对进程数量、Host ownership 和清理行为的判断。

## 复现

使用 `PI_REAL_BIN=/opt/homebrew/bin/pi` 运行 amendment crash Harness，并在首次 `spawnPlanRunner()` 成功后、显式 `host.stop(first)` 前让断言失败或中断测试。测试退出后执行 `ps`，可观察到父进程为 PID 1 的 keeper；其进程组内仍有无限期 `sleep` 和 `pi --mode rpc`。重复失败会为每个 `pi-plan-amendment-harness-*` 临时目录新增一组常驻进程。

现场分类结果为：15 个 amendment Harness keeper、1 个 real Harness keeper、2 个 parent-exit 测试 keeper；16 个 `pi` 仍位于 keeper 进程组内，另有 7 个 `pi` 已直接挂到 PID 1。后者的 cwd 仍全部位于 amendment Harness worktree，证明不是交互会话或当前 subagent。

## 根因

`spawnStandaloneHost()` 使用 `detached: true` 和 `child.unref()` 创建独立进程组，并以 `sleep 2147483647` 保持 RPC stdin。这是 Standalone Host 需要跨 Root 生命周期存活的既有设计，因此测试父进程退出本身不会回收 Host。

`plan-amendment-harness.integration.mjs` 在 `finally` 中只执行 `host.stop(second)`。如果测试在首次 Host 创建后、正常路径的 `host.stop(first)` 前失败，`second` 仍为空，`first` 没有任何清理路径。该 `finally` 还吞掉 `host.stop()` 异常，没有验证进程组确实消失；其他真实 Harness 在测试被强制中断时也无法执行普通 `finally`。detached 生命周期与不完整的测试 ownership 叠加后，keeper、stdin sleep 和 RPC Pi 会长期存活；部分清理只结束 keeper 时，还可能留下直接由 PID 1 接管的 Pi。

## 修复

Harness 必须在拿到每个 Host handle 后立即登记所有权，并在 `finally` 中分别清理 `first`、`second` 及任何部分启动的 handle，不能以 `second` 是否存在代替完整 ownership。清理应逐个执行并汇总错误，禁止静默吞掉 stop 失败；每次 stop 后必须有界等待整个 process group 消失，身份仍匹配且超时后才升级为强制终止。

`spawnStandaloneHost()` 的启动失败路径也应在 handle 尚未返回给调用者时回收已创建的进程组。测试临时目录是否保留只能控制 artifact 删除，不能控制进程存活。Standalone Host 完全退役前，真实 Harness 还需要独立的进程清理兜底；退役后应删除 keeper 与无限期 stdin sleep 这组生命周期面。

## 验证

先新增失败路径 RED：首次 Host ready 后在 `host.stop(first)` 前抛错，断言测试 teardown 最终使 keeper PGID、sleep 和 Pi 全部不存在；再覆盖第二次 spawn 失败、`host.stop()` 抛错、测试保留临时目录和 parent-exit 场景。GREEN 后连续运行 Harness 失败矩阵，确认每轮前后无新增无 TTY `pi` 或 `pi-plan-host-keeper`。

本次现场处置按 Harness 临时目录和无 TTY/PID 1 身份精确终止 25 个进程组。处置后 `pi` 从 30 个降为 7 个，剩余进程均有 TTY；Harness Pi 和 keeper 均为 0，Pi CPU 从约 1327% 降到约 28%，内存从约 40% 降到约 3%。该处置只恢复机器资源，不代替上述代码修复。
