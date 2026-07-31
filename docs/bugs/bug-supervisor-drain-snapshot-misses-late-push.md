# Bug：Supervisor drain 快照遗漏 late push 且空闲时不主动提交

## 症状

adapter drain对pending数组只取一次快照。若新Supervisor push在某个record或ACK await期间入队，当前pass不会处理；等待该成功drain的并发调用也直接return，不检查新队列。

此外live push只入队，不主动启动drain，完全依赖未来的`agent_settled`、`session_shutdown`或subscription start。

## 影响

shutdown期间的late push可留在内存中，随后typed runtime关闭RPC，既未record也未ACK。普通空闲Plan Runner若没有后续turn/hook，Executor可无限期等待，直到generation偶然退出并由proof重放。

## 复现

1. request A进入drain并让recorder await。
2. await期间route request B到同generation。
3. 释放A并让record/ACK成功。
4. 当前snapshot结束，session shutdown继续执行typed `rpc.dispose()`；B仍在pending数组。

空闲场景中，在最后一次`agent_settled`之后发送B且保持generation存活，因没有新hook，B从不提交。

## 根因

一次snapshot被误作queue quiescence barrier。drain成功只表示snapshot完成，不表示期间没有新arrival。

adapter虽在`startLifecycleSubscription(ctx)`获得可信Plan context，却没有保存它供live push立即尝试领域提交。

## 修复

成功pass结束后若pending仍非空，继续下一轮直到队列quiescent；等待existing drain成功的调用也必须复查queue。存在失败项时仍按Executor隔离并报告首错，避免无限自旋。

adapter保存最近一次subscription/lifecycle context。live push入队后用该context立即启动single-flight drain；若因binding时序失败，item保留并由`agent_settled`/`session_shutdown`重试。立即尝试的rejection需被隔离，不能产生unhandled rejection。

## 验证

RED在A recorder await期间注入B，单次`session_shutdown`或`agent_settled`返回前必须record并ACK A、B。另一个RED在subscription已ready且无后续hook时route live request，必须在有界microtask内完成record+ACK。

保留并发失败重试、per-Executor FIFO和shutdown drain-before-dispose现有门禁。
