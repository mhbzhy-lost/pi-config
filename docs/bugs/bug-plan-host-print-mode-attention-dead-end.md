# Standalone Plan Host print mode使durable Attention无回复入口

## 1. 现象

Plan Runner收到blocking Attention并结束当前turn等待Root决策后，`pi --mode json -p`随assistant stop立即退出。Root随后可收到通知并成功写入durable command，但已没有存活Plan Session消费command、调用native Supervisor reply或记录resolution。

## 2. 直接原因

`spawnStandaloneHost()`使用一次性print模式，并把bootstrap作为`-p`参数。该进程只能完成一个连续agent run；`pi.sendMessage(... followUp)`无法在进程退出后恢复同一Session。

## 3. 根因

Host设计把“一个模型turn保持活跃”误当成“Plan Session持久存活”。此前Plan Runner抢先回复使Executor在同一turn内恢复，掩盖了问题；一旦正确等待Root/user，生命周期死路立即暴露。

## 4. 影响范围

- 用户在通知后回复也无法恢复Executor。
- durable command留在inbox且无ack，Attention永久pending。
- Executor最终触发native Supervisor 10分钟超时。
- 任何需要跨turn的recover、HITL和长期Attention都不可靠。

## 5. 修复方案

- Standalone Host改用官方`pi --mode rpc`，通过stdin发送首个`prompt`命令并保持控制管道存活。
- 仍用官方`type=session`事件完成启动身份握手，stdout保持严格JSONL artifact。
- Root launcher观察到Plan terminal后停止持久RPC Host；Root shutdown期间继续保持Host存活，recover可重新附着。
- stop/interrupt继续使用v3 processIdentity和进程组清理。

## 6. 验证策略

- RED：fake Pi捕获argv/stdin，要求`--mode rpc`、无`-p`，且bootstrap来自JSONL prompt；旧实现失败。
- GREEN：Host单测、真实Attention E2E、原parallel-success Harness和完整回归通过。
- E2E必须证明Plan Runner结束等待turn后进程仍存活，Root command触发新turn并最终resolve/validated。
