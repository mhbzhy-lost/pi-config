# Flat amendment Harness 失败清理遗留 async runs

## 1. 现象

`test/plan-amendment-harness.integration.mjs` 的失败路径只调用 `RootRpc.close()`。graceful EOF若超过8秒，helper仅向Root PID发送`SIGKILL`并等待Root退出；Root直接拥有的Plan Runner generations与Executors是独立进程，Root死亡后不能再执行broker drain。正常路径的PID和socket断言位于主体末尾，前置断言失败时不会执行。

## 2. 影响

真实Harness失败、超时或Root close卡住时，Plan Runner、Executor、sleep命令和broker socket可能残留，污染后续固定socket测试、下一次Harness和本机资源。测试报告失败并不意味着现场已安全保留；残留进程还可能继续写worktree或session。

## 3. 时间线

- Root启动一级Plan Runner与Executor async runs。
- 主体断言失败，进入`finally`。
- `rpc.close()`等待8秒后强杀Root；broker的有序Executor/Runner drain不再可用。
- `finally`只保留fixture目录，没有枚举`runtimeTmp`下的async run status，也没有补偿signal或PID收敛检查。
- 正常路径的`process.kill(pid, 0)`和socket `ENOENT`断言被跳过。

## 4. 根因

迁移Harness复用了只负责Root RPC进程的close helper，却把它误当成完整fixture cleanup。flat runtime的进程是Root-owned siblings，不是Root进程树；杀Root不能证明children退出。既有`terminateDetachedRun`只接受单个已知handle，Harness失败早期又可能尚未保存全部run身份。

## 5. 触发条件

任一真实Harness前置断言失败，或Root EOF shutdown超时/拒绝，同时至少一个async Plan Runner或Executor仍活跃。old decision Executor的长`bash sleep`使该窗口更容易稳定出现。

## 6. 修复与验证

先扩展`test/support/plan-e2e-process-cleanup.mjs`：在受控`runtimeTmp`下递归寻找`async-subagent-runs/<runId>/status.json`，核对目录名/runId/PID，对每个run调用已有process-tree TERM/KILL与有界退出验证，并聚合错误。单元RED必须创建嵌套async root和多个真实子进程，证明一调用全部回收。amendment Harness finally在Root close之后无条件执行该补偿清理、确认fixture路径无残留进程并移除broker socket；失败仍保留文件证据，但不能保留运行进程。真实Harness只在新冻结HEAD运行一次。
