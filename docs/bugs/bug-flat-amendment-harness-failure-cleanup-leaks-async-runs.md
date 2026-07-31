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

迁移Harness复用了只负责Root RPC进程的close helper，却把它误当成完整fixture cleanup。flat runtime的进程是Root-owned siblings，不是Root进程树；杀Root不能证明children退出。第一版补偿实现又只核对`status.runId + status.pid`，没有证明PID仍属于原runner；它在发TERM前只快照一次进程树，也会漏掉runner在TERM handler内新建的同组后代。

## 5. 触发条件

任一真实Harness前置断言失败，或Root EOF shutdown超时/拒绝，同时至少一个async Plan Runner或Executor仍活跃。old decision Executor的长`bash sleep`使该窗口更容易稳定出现。

## 6. 修复与验证

`test/support/plan-e2e-process-cleanup.mjs`只在以下身份同时成立时发信号：目录名匹配`status.runId`、`status.startedAt`匹配当前`ps`启动时间、当前命令行包含本次唯一`runtimeTmp`、PID仍是独立进程组leader。信号发送给负PGID；TERM后按整个进程组等待，超时再KILL同组，因此无路径命令行的子进程和TERM竞态新后代也必须收敛。任一身份不可证明时fail closed，不得向PID发信号。

RED必须覆盖三个独立行为：stale status指向无关活进程时不得误杀；runner在TERM handler内新建后代时最终整个进程组退出；主体成功但cleanup失败时不得删除fixture，且聚合错误包含主体/cleanup细节。amendment Harness仅在主体成功、所有cleanup成功且未要求preserve时删除fixture；fixture删除失败也进入聚合。最后确认broker socket移除并且唯一runtime路径无残留runner。真实Harness只在新冻结HEAD运行一次。
