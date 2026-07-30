# Bug：official artifact polling 早于 stop kickoff

## 1. 现象

`RootBrokerServer.drainRun()` 在安装waiter后立即调用 `pollTerminalArtifact()`，随后才调用 `upstream.stop()`。poll async函数会同步进入第一次`readFile(process-terminal.json)`，因此artifact读取在stop request之前已经开始。

## 2. 影响

- 违反Root close的固定顺序：waiter/deadline -> stop request -> event/artifact observation。
- stop同步发出official observed event时，仍会先产生artifact read；若artifact stale/malformed，event与artifact发生不必要竞争。
- 无startup barrier场景的核心动作应是同调用栈kickoff所有Executor stop，当前先执行了可注入I/O入口。
- readFile实现若同步执行昂贵前置逻辑，会延迟后续Executor stop。

## 3. 触发条件与证据

- `c899718` 的`drainRun()`先构造`const artifact = this.pollTerminalArtifact(...)`，后调用`this.upstream.stop(...)`。
- `pollTerminalArtifact()`在第一个`await`之前调用`readJson()`，而`readJson()`立即调用injected `readFile`。
- 现有artifact成功/拒绝测试的stop都只返回ACK，不同步发event，因此没有覆盖优先级。
- 既有ordered drain同步event测试没有注入readFile spy，无法证明event路径没有提前读artifact。

## 4. 根因

实现把artifact Promise的“并行等待”误等同于“可以在stop前启动”。固定deadline需要在stop前启动，但artifact observation不是stop kickoff的前置条件。缺少同步event + artifact spy的时序测试，使I/O启动顺序没有被约束。

## 5. 处理决策

- 新增独立RED：stop同步发matching observed event，injected readFile若调用就计数/返回invalid；close必须resolve且artifact read次数为0。
- `drainRun()`先安装waiter与deadline，调用stop并完成既有immediate rejection检查；若terminalProofs已由同步event写入，直接完成。
- 只有仍缺proof时才启动artifact poll，并与waiter/deadline竞争。
- event到达与poll开始之间的竞态仍由waiter优先和poll cancellation保护。

## 6. 验证

1. 同步official event路径close resolve且readFile调用0次。
2. 无event路径仍读取sidecar/status并通过现有8项artifact测试。
3. pending stop + event、ordered drain、full Root Broker保持GREEN。
4. polling timer和late read在event获胜后不产生state写入。
