# Amendment crash 工具重放 pending official proof

## 1. 现象

真实amendment Harness已到达event-to-pointer crash窗口，但Root crash工具连续产生2048个result。首个结果为`official terminal is non-observed (pending)`，Harness在第二个result出现时以`duplicate result`失败；随后Root close与仍在运行的工具循环相撞并超时。

## 2. 影响

双Plan Harness已GREEN，但amendment场景无法取得唯一crash proof，不能继续验证同Root revival、pointer修复、supersede cleanup、revision 2和四Gate；失败还制造不必要的Root工具风暴。

## 3. 时间线

- old Executor在Supervisor回复后保持活跃，Plan amendment已持久化并停在pointer barrier。
- Harness发送唯一`PI_PLAN_FLAT_AMENDMENT_CRASH` marker。
- tests-only control调用官方`broker.drainRun(executor)`；stop后status短暂为`pending`，调用立即拒绝。
- provider看到marker后不检查已有`plan_harness_crash_amendment`结果，立刻再次发起同一工具。
- 重放持续到Harness失败并关闭Root，共记录2048个result。

## 4. 根因

control把stop到official proof之间的正常短窗口直接暴露为最终tool result；provider又把Root marker当成每轮无条件命令，而不是one-shot请求。两者组合形成无退避重放。

## 5. 触发条件

Executor或Runner的官方terminal sidecar/event晚于`drainRun()`首次读取status，且Root会话历史仍保留同一crash marker。

## 6. 修复与验证

新增RED：provider对已有crash result必须返回终止文本，不得第二次调用工具；control在一次官方`drainRun()`遇到`non-observed (pending)`后只轮询broker已有`terminalProofs`，在有界deadline内取得exact run proof，再处理下一角色，不得重复stop。所有owner、active generation和role fence保持不变。focused provider/fixture tests及下一冻结HEAD唯一真实Harness验证。
