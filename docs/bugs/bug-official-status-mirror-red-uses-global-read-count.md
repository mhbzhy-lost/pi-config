# Bug：status mirror RED 使用全局读取计数

## 1. 现象

`Root official terminal artifact uses status mirror only after sidecar ENOENT` 的fixture用全局 `reads.status` 决定何时返回 `status.json.processTerminal`：只有全局第一次status读取不含proof，之后任意run首次读取就会拿到proof；测试却断言三个runs合计至少读取6次。

## 2. 影响

GREEN实现若正确地并发读取两个Executor，会出现：Executor A首读无proof、Executor B首读已有proof、A第二次有proof、Plan Runner首读已有proof，总计约4次。行为满足当前fixture实际语义，却会被`status >= 6`误判失败；同时测试不能证明每个run的`state:'stopped'`都没有单独解锁。

## 3. 触发条件与证据

- callback签名接收全局`read`与`file`，当前判断只使用`read > 1`。
- fixture包含`executor-a`、`executor-b`、`plan-runner`三个不同status路径。
- Executors同phase并发poll，读取全局顺序不绑定run。
- 期望断言`counters.status >= 6`隐含每个文件至少两读，与fixture不一致。
- 当前production完全不读artifact，所以RED阶段只看到close rejection，缺陷要到GREEN才暴露。

## 4. 根因

测试把“每个artifact的状态演进”错误建模为“整个broker共享的读取代数”。并发phase下全局计数不能代表某个run的sidecar/status历史，导致fixture语义与断言脱节。

## 5. 处理决策

- 在该测试内用`Map<file, count>`记录每个status路径的读取次数。
- 每个文件第一次只返回`state:'stopped'`，第二次及以后才附matching observed `processTerminal`。
- 保留`status >= 6`并额外断言三个status文件都至少读取两次。
- 不修改production、不改变sidecar ENOENT优先级、不放宽official proof要求。

## 6. 验证

1. 当前production下official artifact pattern仍精确8 RED，status case失败于未读取artifact而非fixture异常。
2. full Root Broker仍为90 PASS/8 RED、cancelled 0并自然退出。
3. GREEN后status case证明三个run各自先观察stopped-only，再由matching mirror解锁。
4. commit只包含该test fixture校准。
