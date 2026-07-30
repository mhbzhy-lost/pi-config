# Bug：delayed stop rejection 未进入 cleanup debt 诊断

## 1. 现象

`drainRun()` 为stop Promise安装handler并记录`stopSettled/stopError`，但只在一次microtask后的“immediate rejection”检查中使用。若stop稍后reject且没有official proof，terminal deadline最终只返回`missing official proof for run ...`，丢失stop错误。

## 2. 影响

cleanup debt调用方无法区分“stop请求成功但observer缺proof”与“stop RPC已经失败且也没有proof”。这会削弱8B2 force cleanup的决策和诊断，并使transport/上游故障被伪装成单纯artifact缺失。

## 3. 触发条件与证据

- stop Promise在初始`await Promise.resolve()`之后、`terminalTimeoutMs`之前reject。
- `c899718` rejection handler会更新局部`stopError`，但timeout callback没有读取该变量。
- 现有immediate stop failure测试约1ms reject，不能覆盖延迟rejection。
- pending stop bounded test覆盖永不settle，同样不能证明delayed error被保留。

## 4. 根因

有界等待修复将stop从await链拆出后，只保留了immediate兼容分支，没有把异步stop outcome纳入deadline错误构造。`stopError !== undefined`还无法表示`Promise.reject(undefined)`，缺少独立`stopFailed`状态。

## 5. 处理决策

- 新增独立RED：stop在约2ms后reject `delayed stop failure`，artifact/status始终missing；close在固定deadline形成AggregateError且深层诊断必须包含该错误。
- 保留“delayed stop failure后若official observed proof及时到达，run仍成功”的authority语义。
- 使用`stopFailed`布尔值区分resolve、reject(undefined)和pending。
- deadline错误在触发时读取最新stop outcome并附加bounded error text；不得await stop ACK或因rejection提前跳过proof窗口。

## 6. 验证

1. delayed rejection + no proof在deadline内返回debt，诊断含原错误。
2. immediate rejection既有重试测试保持约1ms并形成debt。
3. pending stop + observed proof仍可成功；stop ACK仍不是proof。
4. 所有stop Promise均有handler，不产生unhandled rejection或残留timer。
