# Plan E2E 超时后泄漏 Detached Pi 进程

## 现象

运行或调试 `test:plan` 后，系统中长期残留多组 `pi-subagents` runner 与 Pi child。现场确认 5 组进程已运行 40–45 分钟，runner 的父进程均为 PID 1，child 持续占用约一个 CPU 核心。

## 影响范围

所有在 detached Plan child 到达终态前失败、超时或关闭 Parent RPC 的真实 Plan E2E 都可能泄漏。重复运行测试会累积高 CPU、高内存进程，并干扰后续时序测试。

## 复现步骤

启动真实 Parent Launcher E2E，在收到 `PI_PLAN_HANDLE` 后关闭 Parent RPC stdin，再让状态等待超时或断言失败。测试 `finally` 删除 package/origin 临时目录，但 detached runner 与 Pi child 继续运行；其配置文件已被删除，无法再通过正常 artifact 控制恢复。

## 根因

测试 harness 只管理顶层 Parent Pi 进程，不持有 detached runner 的清理责任。`finally` 仅删除目录，没有根据 handle 的 `asyncDir/status.json` 终止 runner 进程树；Parent 退出后 runner 被 PID 1 收养。新增多 prompt harness 同样只结束 stdin，未等待或回收后台 run。

## 修复方案

测试 harness 必须登记每个已返回的 handle，并在 `finally` 中先等待正常终态；若测试失败或超时，则从可信 `asyncDir/status.json` 读取 runner PID，终止该 runner 的全部 descendants 后再终止 runner，确认退出后才能删除临时目录。真实并发测试不得只靠关闭 Parent stdin 代替后台 run 回收。

## 验证方式

先用独立进程树测试证明旧 cleanup 只杀 Parent 会留下 descendant；修复后证明 cleanup 同时回收 runner 与 child。再故意让真实 Plan E2E 提前失败，确认测试结束后不存在引用该临时 package/config 的进程，并运行完整 `test:plan` 检查无新增孤儿。
