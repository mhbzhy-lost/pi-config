# Bug：Supervisor promotion 验证异常产生部分提交

## 症状

`promoteSupervisorIngress()`先删除per-Executor pending队列和requestId reservation，再把entry写入 `supervisorRequests`，最后才调用 `parseBrokerPush()`。如果promotion后的callerRunId使最终frame超过64 KiB或其他schema校验失败，函数抛错，但前面的索引修改不会回滚。

独立审查探针复现后得到pending队列已空、`supervisorRequests`仍保留request和原始context。多entry FIFO还可能只删除部分reservation，形成无法按统一规则清理的混合状态。

## 影响

一个未真正投递的request会出现在 `supervisor.pending` 并可被reply，导致模型和native channel状态分叉。原始context继续被Root引用，requestId可能永久冲突或错误复用，global capacity统计也不再对应实际payload。

spawn catch只调用 `releasePendingSupervisorIngress(runId)`；队列已提前删除后，它无法清理写入 `supervisorRequests` 的半提交entry。

## 复现

1. 使用合法最大长度logical caller ID和接近frame上限的Supervisor content，使unbound阶段以短占位caller校验通过。
2. 在owner绑定后触发promotion。
3. `parseBrokerPush()`因最终frame过大抛错。
4. 检查pending、reservation、supervisorRequests和context：观察队列已删除而request已写入，未形成全有或全无结果。

## 根因

promotion把schema构造与投递准备放在mutation之后，没有遵循Broker其他恢复路径采用的“先构造并完整验证operations，再执行权威mutation”原则。异常处理又只知道executor queue，不知道已经promote的entry集合。

单线程事件循环只能避免并发交错，不能避免同步校验在循环中途抛错造成部分提交。

## 修复

promotion必须先对完整FIFO生成所有candidate `SupervisorRequest` 与最终 `BrokerPush`，验证reservation仍精确指向同一pending对象、requestId未被bound map占用、owner/caller/principal fence仍成立，并对所有push执行 `parseBrokerPush()`。任何一项失败时零mutation。

全部预验证通过后再一次性删除executor queue、逐项删除精确reservation、写入 `supervisorRequests`，最后按FIFO调用 `deliverOrQueuePush()`。若mutation阶段发现identity变化，fail closed并保持原队列，不允许部分promotion。

## 验证

新增接近frame上限的多entry RED，强制第二项promotion校验失败，断言pending FIFO、requestId reservations、context与bound requests全部保持原状；spawn cleanup后这些引用全部释放。另保留正常多entry FIFO exact delivery GREEN。

真实Harness在原子promotion门禁完成前不得运行。
