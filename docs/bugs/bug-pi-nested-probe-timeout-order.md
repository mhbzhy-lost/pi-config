# Bug：Nested Probe 外层 watchdog 短于内部证据 deadline

## 1. 现象

Nested integration 在约 60 秒被 `runRpcUntil` 标记为 `Pi RPC timed out after 60000ms`，没有返回目标 notify。

## 2. 影响

外层进程会在内部仍合法等待 nested tool result/sentinel 时被终止，导致测试无法区分模型启动延迟、nested runtime 失败和客户端主动 kill；active run cleanup 也被迫走异常路径。

## 3. 稳定复现

运行 nested integration。生成的 `/nested-probe` command 使用 `deadline = now + 120000`，调用它的 `runRpcUntil` 却显式传 `timeoutMs:60000`；测试稳定由外层 timeout 先触发。

## 4. 证据

失败栈来自 `runRpcUntil` 的 timeout handler，不是 Extension error、RPC error或 artifact terminal。源码中的两个 timeout 常量存在严格冲突：外层 60 秒，小于内层 120 秒，内部成功路径在后半窗口不可达。

## 5. 根因

测试在重构 nested 等待策略时只扩大了 Extension 内部 deadline，没有同步调整 transport watchdog，破坏了 timeout 层级：transport 应覆盖 command deadline、notify 传输和 shutdown，而不是提前终止业务等待。

## 6. 修复与验证策略

保留当前真实失败作为 RED，把外层 timeout 调整为 180 秒，明确大于内部 120 秒并留出 60 秒停止/退出空间。继续使用条件等待，不增加固定 sleep。若仍失败，输出有界 stdout/stderr 和最后 artifact，再定位真正阻塞点。
