# 真实 Runtime enqueue 断开

## 根因

Root Broker 关闭时只等待已经解析并登记到 `integrationRequests` 的
`coordinator.request`。Unix socket 的请求可能已经收到部分或完整字节、但尚未
到达首个换行边界；此时连接不在 integration drain 集合中。`closeRootSession`
随后结束 transport，真实 child client 将该请求报告为 `BROKER_DISCONNECTED`。

## 修复

Broker 为每个已接受的 socket 建立 request-boundary barrier，并在收到首个完整
frame、进入 `respond` 前移除 barrier。关闭流程先等待 request boundary 和已登记
integration request；超过既有 bounded deadline 时记录可观察 debt，而不是无限等待
或静默丢弃。Coordinator 仍由 production runtime 的统一 teardown 顺序在 Broker
drain 后关闭。

## 验证范围

应使用真实 RootBrokerServer/RootBrokerClient、coordinator socket/server/client、
managed workspace、授权 run 和真实 runtime disposal 顺序验证；不能以直接调用
coordinator handler 代替 Broker transport。
