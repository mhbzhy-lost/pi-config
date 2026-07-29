# attempt.bound CAS 竞争遗留 Executor

## 现象

Coordinator 在 Executor 已成功启动后，先读取到非终态投影，再调用 `attempt.bound` 写入。若取消事件在 Writer 实际执行 CAS 前提交，Writer 会以 `PROJECTION_CONFLICT` 拒绝绑定，已启动的 Executor 没有停止。

## 影响

计划已取消但 Executor 仍在运行，且事件日志没有对应的 `attempt.bound` 记录。该运行实例无法通过正常恢复路径追踪或回收，可能继续修改独立工作区并消耗执行资源。

## 复现

使用包装 Writer 在收到 `attempt.bound` 时暂停转交；Coordinator 完成 spawn 后，另一个共享 Writer 提交 `plan.cancelled`，再解除暂停。旧实现的派发 Promise 拒绝，`backend.stop` 调用次数为零，事件日志中没有 `attempt.bound`。

## 根因

`dispatchAuthorized` 仅在调用 `appendEvent("attempt.bound")` 前做一次终态检查。`appendEvent` 会再次刷新投影并让出执行权，CAS 失败会直接向上传播；该失败分支没有保留 spawned binding 的清理责任，也没有依据最新投影判定终态、同一绑定幂等成功或可重试冲突。

## 修复

将 spawn 后的绑定过程收敛为内部 bind-or-cleanup helper。每次写入失败均刷新最新投影：终态时停止本次 run 并返回终态；同一 durable binding 视为成功；相同 dispatch-requested 且错误为 `PROJECTION_CONFLICT` 时重试。不同绑定、不可绑定状态及非冲突错误均先停止，再按既有 fail-closed 或错误传播语义处理。

## 验证

新增确定性 late-cancel 测试与非终态冲突重试测试，验证 stop 恰好一次、未写入 bound、日志可 replay、取消状态正常返回，以及冲突后仅写入一个相同 bound 且不停止。运行 Coordinator 与 Task 4 完整回归套件。
