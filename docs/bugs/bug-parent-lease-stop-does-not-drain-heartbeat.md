# Parent Lease Stop 未等待正在执行的 Heartbeat

## 现象

Plan launch 失败后已执行 `stop` 和 `remove`，但一个先前启动、尚未完成的 heartbeat 仍可能随后 rename `parent-lease.json`，导致失败现场残留有效 lease；heartbeat 写入失败还可能形成未处理的 Promise rejection。

## 影响范围

所有在 heartbeat timer 写入期间发生 spawn、artifact 等待或 handle 持久化失败的 Plan launch；正常 Parent shutdown 使用同一 lease API 时也存在相同竞态。

## 复现步骤

启动 lease timer，让一次 heartbeat 写入停在完成前；调用同步 `stop()` 后立即 `remove()`，再放行 heartbeat。最终 lease 文件会在 remove 之后重新出现，因为 stop 只清除了未来 timer，没有等待当前写入。

## 根因

`createParentLease.start()` 使用 `void beat()` 丢弃异步写入，`stop()` 只调用 `clearInterval`。lease API 没有跟踪和排空 in-flight heartbeat，Launcher 也没有可等待的停止屏障。

## 修复方案

串行跟踪 heartbeat Promise，使 timer 写入错误可由停止屏障观察；将 `stop()` 改为异步等待当前 heartbeat 完成。Launcher 在删除 lease 前必须 `await stop()`，保证 remove 是该 lease 的最后一次文件操作。

## 验证方式

用受控 writer 挂起 heartbeat，先调用 stop 并确认其尚未完成，放行写入后再 remove，断言没有重建 lease或未处理 rejection；运行 lifecycle 与 launcher 全部单元测试。
