# Bug：Task 8B1 GREEN 在 cleanup debt 后挂住测试进程

## 1. 现象

Task 8B1 Executor 在实现 `RootBrokerServer.closeRootSession()` 后运行：

```sh
node --test --test-name-pattern='Root session ordered drain' test/root-subagent-broker.test.mjs
```

命令没有返回并耗尽 600000ms dispatch deadline。父级使用 20 秒 watchdog 串行复跑后确认 5 项中 2 项通过、3 项失败；其中 cleanup-debt 用例失败后测试进程保持运行。改动仍是未提交的 `root-broker-server.ts` diff。

## 2. 影响

Task 8B1 无法形成可信 GREEN、完整 Root Broker 回归和提交证据。失败后的测试 server 保持监听，也会阻塞固定 socket suite 的后续串行验收；若误把 dispatch timeout 当作实现完成，会将不完整 shutdown 语义带入 8B2。

## 3. 触发条件与证据

- 正常 ordered drain 在约 7ms 失败：`socketEnd` 为 `undefined`，读取 `sequence` 触发 `TypeError`。
- single-flight/idempotent 在约 8ms 失败：期望一次 `socket.end`，实际为 0。
- cleanup-debt 在约 53ms 失败后不退出；测试在调用 close 后立即要求两个 Executor stop 已启动。
- production teardown 只遍历 `this.sockets` 调用 `end()`，没有对 subscription sockets 与 accepted sockets 构造去重 union。
- production close 在启动 drain 前无条件 `await Promise.allSettled(...)`；即使观测、grant 和 spawn 都已完成，也会先让出当前 microtask，导致 close 返回时 `stopOrder` 仍为空。
- 失败用例的 `t.after` 只能复用尚在进行或已形成 cleanup debt 的 close；测试未执行后续 observed proof 与显式 retry，因此 server 按设计保留并让 Node 进程持续运行。

## 4. 根因

实现没有把“关闭屏障”和“停止启动时机”建模为可判定状态：已 settled 的 started/grant promises 仍留在集合中，使 close 无法区分真实 pending 工作与历史完成工作，只能无条件异步等待。同时 transport teardown 分别依赖 `subscriptions` 和 `sockets` 两个集合，却只结束后者，遗漏了订阅集合中的连接。两个缺口叠加后，正常路径缺少 socket end 证据，debt 路径的首个断言又会在 stop 启动前失败并留下有意保留的监听资源。

## 5. 处理决策

- 保持 tests-only RED 不变，不通过延长 timeout 或弱化断言规避问题。
- 显式清理或跟踪仅“正在进行”的 started observation、Executor grant 和 spawn promise；当 startup barrier 没有 pending 工作时，同一调用栈内启动所有 Executor drains。
- 若 barrier 仍有 pending 工作，必须先等待其 all-settled，再启动 drain，继续保持 late-start fencing。
- teardown 对 accepted sockets 与 subscription sockets 构造去重 union；每个 socket 最多 `end()` 一次，随后保留既有有界 destroy fallback。
- observed proof 到达后清除对应 timeout timer 和 waiter；cleanup debt 继续保留 server、listeners、subscriptions、ledgers 与 upstream RPC。
- `upstream.dispose()` 抛错时仍通过嵌套 `finally` 清理内存状态，保持既有 teardown 异常语义。

## 6. 验证

1. 严格串行运行 5 项 `Root session ordered drain`，要求 `5/5` 且命令自然退出。
2. 严格串行运行完整 `root-subagent-broker.test.mjs`，要求全部通过且无 open handle。
3. 运行 protocol 与 process birth helper 回归。
4. 检查提交只包含 `root-broker-server.ts`；本 bug 文档单独提交，不混入用户并发完成的 Pi 升级、TUI stderr guard 或其他工作树改动。
