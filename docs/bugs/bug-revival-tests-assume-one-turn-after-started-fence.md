# Bug：revival 测试把单次 setImmediate 当作 started handoff 完成

## 1. 现象

revived started ownership 屏障加入后，四个 revival 测试在生产行为正确时失败。它们在 resolve resume 或接受 proof 后只等待一次 `setImmediate`，随后立即断言 follow-up 已消费、single-flight 已清理、subscription 已获 grant 或下一代 resume 已启动。

## 2. 影响

完整 revival 门禁出现 33/37，阻塞真实 ownership 修复。若为迁就测试而提前 grant，会重新打开 close-before-started 进程逃逸问题。

## 3. 触发条件

fixture 的 revived `async-started` 按真实异步边界在 resume continuation 后的 `setImmediate` 发布；生产代码必须先由 `observeStarted` 登记 ownership，再在后续 microtask 完成 grant/alias。

## 4. 根因

测试用事件循环轮数代替领域后置条件。单次 `setImmediate` 只说明一个调度点经过，不保证 started event、birth capture、ownership promise、grant 和 alias continuation 全部完成。

## 5. 为什么此前未发现

旧实现没有 started ownership 屏障，resume result 后可直接 grant，因此一次 `setImmediate` 偶然足够。测试把该偶然时序固化为 oracle，没有表达真正需要等待的 active generation、revive promise 清理或 resume call 数量。

## 6. 修复与验证

仅调整四个失败测试，使用已有有界 `waitFor` 等待语义条件：logical activeRunId 切到目标 generation、`revivePromises` 清零或 `resumeCalls` 达到目标数量。FIFO 内容、wake 顺序、exact caller wake、grant token、proof 与 count transfer 断言保持不变。生产代码不改。完整 revival 必须恢复 37/37。
