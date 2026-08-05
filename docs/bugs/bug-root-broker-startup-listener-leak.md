# Bug: Root Broker 启动失败泄漏生命周期监听器

## 症状
Root Broker 启动时如果 started 生命周期监听器注册成功、随后 terminal 监听器注册失败，`start()` 虽然抛错并关闭 socket server，但第一个监听器仍留在事件总线上。

## 影响
对外失败的 Broker 仍会接收后续 Executor started 事件、建立 ownership 并尝试写入授权文件；重试启动还会叠加监听器。失败实例由此保留隐蔽的授权副作用和进程内资源，破坏启动回滚与失败关闭契约。

## 复现
让 `events.on("subagent:async-started", ...)` 成功返回 unsubscribe，再让 `events.on("subagent:process-terminal", ...)` 抛错。等待 `start()` 失败后发送 started 事件，仍可观察到 `ownedRuns` 增加。

## 根因
`start()` 的异常分支只清空 server 字段、关闭 server 并删除 socket，没有调用已成功取得的 `unsubscribeStarted`；listener 注册是分步执行的，但回滚逻辑没有保存和逆序释放部分成功状态。

## 修复
启动失败时注销所有已经注册成功的生命周期监听器并清空对应字段，然后再完成 transport 回滚；保留原始 listener 注册错误作为 `start()` 的失败原因。

## 验证
新增 Root Broker 回归测试：部分 listener 注册失败后确认先前监听器已注销，再发送 started 事件不会建立 ownership。随后重跑 Root Broker、通用 subagent runtime、Goal Engine 与全仓测试。
