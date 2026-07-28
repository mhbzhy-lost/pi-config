# 并行事件使 durable Attention 回复永久 stale

## 1. 现象

blocking Attention在projection version 6创建并升级后，如果另一并行Attempt产生version 7事件，Attention本身仍然pending且内容未变，但Root使用通知中的version 6调用回复工具会被判定stale。即使重新读取status也无法获得可用版本，因为Attention投影保留其创建版本。

## 2. 直接原因

Root工具、`processAttentionReplies()`和`authorizeSupervisorReply()`都把command的`expectedProjectionVersion`与Plan全局当前version比较，而Host通知携带的是`attention.projectionVersion`。

## 3. 根因

一个字段混用了两种fence：

- Root command需要证明它回复的是哪一份不可变Attention请求；应绑定`attention.projectionVersion`。
- `attempt.attention-resolved`事件需要证明它附加到哪个当前Plan projection；应在native delivery授权时绑定当前`projection.version`。

单Task运行中二者数值碰巧相同，现有测试因此未暴露混用。

## 4. 影响范围

任何带并行Attempt的Plan，只要Attention升级后发生无关领域事件，用户回复都会被永久忽略；command留在inbox且不会ack，Executor最终在native Supervisor的10分钟窗口后超时。

## 5. 修复方案

- Root工具校验通知版本等于pending `attention.projectionVersion`，command原样保存该版本。
- `processAttentionReplies()`按pending Attention版本接受command，不再要求等于Plan全局version。
- `authorizeSupervisorReply()`用Attention版本验证command，但生成authorization时使用当前Plan version，供resolution事件fencing。
- requestId、attemptId、runId和message逐字段校验保持不变。

## 6. 验证策略

使用两个并行Attempt：Task 1进入blocking Attention后，Task 2产生一个progress event推进全局version。证明Root仍可用原通知版本写command，Plan Runner可宣布并授权exact reply，且resolution authorization绑定推进后的当前version。

## 验证结果

RED阶段中，Root工具将原Attention版本误判为stale，Plan Runner也忽略已经写入的command。修复后并行fence定向测试`25/25`通过；command保留Attention版本，authorization使用推进后的当前Plan版本。
