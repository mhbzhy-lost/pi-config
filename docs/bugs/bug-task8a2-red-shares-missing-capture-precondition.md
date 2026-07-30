# Bug: Task 8A2 RED 共享缺失 capture 前置

## 症状
已验证的 executor 与 plan-runner ownership RED 测试在 `captures=[]` 处失败；合并的 duplicate/conflict 测试也在同一前置断言失败，尚未到达各自声明的 ledger、去重或冲突断言。

## 影响
这些 RED 结果只能证明当前运行时未捕获 process birth identity，不能证明目标 `ownedRuns` ledger 字段是否缺失，也不能证明重复事件与冲突事件的语义是否错误，因此无法为后续实现提供可定位的失败证据。

## 复现
使用严格串行命令 `node --test --test-name-pattern='started ownership|birth identity' test/root-subagent-broker.test.mjs` 运行定向测试。verified executor、plan-runner 与合并 duplicate/conflict 均先报告 `captures=[]`；malformed 与 foreign 则直接暴露错误 grant 副作用。

## 根因
当前 Root Broker 仅对 executor/spark 的 started 事件调用既有授权流程，未提供 ownership ledger 或 process-birth capture 路径。父级曾将 `--test-name-pattern` 放在文件参数之后并并发运行固定 socket suite，产生既有假失败；该问题不是 production 回归。

## 修复
仅在测试中、且构造后的 broker 缺少 `ownedRuns` Map 时安装局部 started-event fallback。fallback 先制造 capture 前置满足，再保留每个测试目标 ledger、去重、冲突或错误 grant 断言为 RED；运行时 API 出现后完全使用真实 listener。

## 验证
严格串行运行定向 Root Broker 测试，确认七项 RED 分别落在 exact entry、unavailable entry、malformed/foreign grant 副作用、duplicate single-flight 与 conflict 保留首个 facts 的断言，且无运行时异常、超时或取消；direct executor grant fixture 单独保持 GREEN。
