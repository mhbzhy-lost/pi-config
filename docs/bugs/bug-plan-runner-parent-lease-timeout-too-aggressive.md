# Plan Runner 因 Parent Lease 超时误杀导致 "Plan session shutdown failed"

## 现象

plan-runner 子进程在等待 executor subagent 完成时被 SIGTERM 杀死（exit 143），
stderr 输出 `Extension error (...plan-runner-entry.mjs): Plan session shutdown failed`。
计划执行中断，task-1 的 executor run 成为孤儿进程。

## 触发条件

parent Pi session 在 plan-runner 运行期间暂时阻塞（event loop 被大响应占满、macOS
App Nap、或用户切走焦点后系统降频），超过 5s 未续约 parent-lease.json。
watchdog 判定 lease 过期后发送 SIGTERM。

实际案例：parent PID 96885 在 12:50:34 前后停止心跳，12:50:39 watchdog 触发，
但 parent 在 ~13:01 恢复正常心跳——说明 parent 并未死亡，只是暂时阻塞。

## 影响范围

- plan-runner 被误杀，正在执行的计划中断
- 已派发的 executor subagent 成为孤儿（stopActiveRuns 在 SIGTERM 期间 RPC 失败）
- 用户需要手动清理 worktree 和残留进程

## 根因

两层问题叠加：

1. **lease timeout 过于激进**：`startParentLeaseWatchdog` 的 `timeoutMs: 5000`
   由 `plan-run` 命令硬编码传入。parent Pi session 的 event loop 在处理大模型响应
   或 compaction 时可能阻塞数秒到数十秒，5s 阈值在正常负载下即可触发误判。

2. **shutdown handler 不容错**：`plan-capsule-extension.mjs` 的 `session_shutdown`
   中 `stopActiveRuns()` 尝试通过 RPC 停止嵌套 run，在进程即将被杀时 RPC 必然失败，
   但代码将 rejection 重新 throw 为 `AggregateError("Plan session shutdown failed")`，
   导致 Pi 框架记录 extension error 而非静默退出。

## 为什么现有测试未发现

- `parent-lifecycle.mjs` 的单元测试使用 fake timer 和 mock，不模拟 parent 暂时阻塞
  后恢复的场景
- shutdown 路径的测试（`bug-plan-shutdown-test-consumes-run-id-too-early.md` 相关）
  未覆盖 "SIGTERM 期间 RPC 不可达" 的情况
- 5s 超时在 CI 环境下不会触发（CI 无 App Nap / 无大响应阻塞）

## 修复方案与防回归

1. **提高 lease timeout**：将 `plan-run` 传入的 `timeoutMs` 从 5000 改为 30000，
   `startupGraceMs` 相应调整为 15000。parent 心跳间隔保持 1s 不变，30s 超时意味着
   容忍 30 次连续心跳丢失才判定死亡。

2. **shutdown best-effort**：`session_shutdown` handler 中 `stopActiveRuns()` 的
   rejection 不再 re-throw，改为 console.warn 记录后静默继续。进程即将退出时清理
   失败是可接受的，不应阻塞退出流程。

3. **防回归测试**：
   - 单元测试：watchdog 在 timeout 内 lease 恢复则不触发 expired
   - 单元测试：shutdown handler 在 stopActiveRuns reject 时不 throw
