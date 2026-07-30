# Bug：Root close 的 startup barrier 没有 deadline

## 1. 现象

`RootBrokerServer.closeRootSession()` 会快照 `startedObservations`、`executorGrants`、`callerGrants` 和 `spawnLedger.promise`，随后无条件：

```ts
await Promise.allSettled(startupBarrier);
```

只要其中一个 Promise 永不 settle，close 就永远无法进入 Executor drain，也不会形成 cleanup debt。

## 2. 影响

Root graceful shutdown 可在发送任何 stop 前永久阻塞。server、subscriptions、terminal listener、grant/ledger 和 upstream RPC 会一直保留，但调用方拿不到有界 `AggregateError`，无法诊断、重试或进入 8B2 的 artifact/force cleanup。`terminalTimeoutMs` 对这一阶段完全无效。

## 3. 触发条件与证据

- birth identity capture、grant write、已发出的 broker spawn 或其 result reconciliation 任一 pending 即可触发。
- 当前代码只对 run terminal waiter创建 timer，startup barrier 没有 timer 或 cancellation结果。
- 独立 review `09556c85-fdac-43bc-a655-eeeeb375c7f7` 将其评为 Important，并指出它会阻断整个 drain phase。
- 现有 87 项 Root Broker 测试只覆盖可释放的 concurrent caller grant，没有覆盖永不 settle 的 started observation/grant/spawn。
- 父级静态时序验证确认：向 `startedObservations` 注入 never-settling Promise 后，close 超过 `terminalTimeoutMs` 仍 pending。

## 4. 根因

实现把 startup barrier 视为必然完成的本地准备步骤，而不是 shutdown cleanup 的一部分。实际这些 Promise 跨越进程探测、文件写入和上游 RPC，具备与 stop 相同的丢 reply/永久 pending 风险。缺少统一的绝对 deadline 和 debt分类，使“等待已进入操作完成”退化为无界等待。

## 5. 处理决策

- 增加独立 RED：真实 started observation 的 birth capture 永不 settle，close 必须在配置 deadline 内以 `AggregateError` 返回。
- barrier timeout 时不得启动任何 run stop，不得 unsubscribe、push `root.closing`、end socket、close server、删除 grant/ledger 或 dispose upstream。
- 保留原 pending Promise 与 ownership事实；Promise 后续 settle 后，重复 `closeRootSession()` 必须继续 ordered drain，而非永久复用旧 rejection。
- deadline 只停止等待，不尝试取消未知 Promise，也必须附 handler 避免 late rejection 变成 unhandled rejection。
- 采用可注入的有界 deadline，避免测试依赖长时间 wall-clock；与 run terminal deadline可共享配置，但错误诊断必须区分 startup barrier debt。

## 6. 验证

1. never-settling started observation 在明显小于外部 test timeout 的窗口内返回 `AggregateError`，测试自然退出。
2. timeout 前 `upstream.stop` 调用数为 0，server仍 listening，terminal listener仍注册，upstream未 dispose。
3. 释放 observation 后重复 close，会按 Executor -> Plan Runner顺序继续并最终完整 teardown。
4. focused ordered drain、Root Broker全量、protocol 和 process birth helper继续通过。
