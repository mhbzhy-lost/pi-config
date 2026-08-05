# Bug: Root Broker 启动失败无法完整回滚

## 症状
Root Broker 启动时如果 started 生命周期监听器注册成功、随后 terminal 监听器注册失败，第一个监听器仍会留在事件总线上。即使监听器已注销，后续 transport 回滚错误仍可能覆盖原始启动错误；如果失败前已有客户端连接，`server.close()` 还会等待该连接而不返回。

## 影响
对外失败的 Broker 可能继续接收 Executor 事件、建立 ownership 并尝试写入授权文件；也可能丢失真正的启动故障诊断，或永久卡在启动 Promise 中。失败实例由此保留隐蔽的授权副作用、连接和进程内资源，破坏启动事务回滚与失败关闭契约。

## 复现
一是让 `events.on("subagent:async-started", ...)` 成功返回 unsubscribe，再让 terminal listener 注册抛错；失败后发送 started 事件仍会增加 `ownedRuns`。二是在原始启动错误后让 socket 删除失败，会只看到删除错误。三是在权限设置失败前连接并保持一个客户端，失败分支直接等待 `server.close()`，启动不会结束。

## 根因
`start()` 的异常分支只清空 server 字段、关闭 server 并删除 socket，没有把 listener、已接入 socket、server 和 socket 文件视为分步取得的资源。它既未逆序释放部分成功状态，也未在等待 server close 前终止连接；回滚步骤本身又没有与原始启动错误隔离。

## 修复
启动失败时逆序注销所有已注册监听器，结束并兜底销毁所有已接入 socket，再关闭 server 和删除 socket 文件。每项回滚独立尝试且不覆盖最初捕获的启动错误；字段同步清空，使失败实例不再接收事件或持有 transport 资源。

## 验证
新增三项 Root Broker 回归：部分 listener 注册失败后不会处理后续 started 事件；socket 文件清理失败时仍返回原始启动错误；权限设置失败前接入空闲客户端时，启动在期限内失败且连接被释放。随后重跑 Root Broker、通用 subagent runtime、Goal Engine 与全仓测试。
