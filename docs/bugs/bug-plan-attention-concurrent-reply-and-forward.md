# Bug：Plan Attention 并发回复与转发重复

## 症状

同一 Attention 的并发 reply 会在读取现有回复与写入之间竞态，可能覆盖持久决定；两个并发 status/poller 也可能在 sendMessage 成功前同时转发同一 Attention。

## 影响

用户的互斥决定可能被后到请求静默改写，或同一 Attention 触发多次 follow-up，造成执行语义和用户界面不一致。

## 复现

运行 `node --test test/plan-launcher-extension.test.mjs test/plan-control.test.mjs` 中新增并发用例：相同 reply 必须只写一次，不同 reply 仅一个成功；并发转发仅发送一次，发送失败后下一次可重试。现有实现会出现重复 write 或 sendMessage。

## 根因

Launcher 在 `readAttentionReplies()` 与 `writeAttentionReply()` 之间没有同请求串行栅栏；PlanControl 的 rename 发布可覆盖目标文件。转发去重仅在 send 成功后写入集合，发送前不存在共享中的 Promise。

## 修复

Launcher 以 `planId:requestId` 串行化 reply，并以 `planId:requestId:projectionVersion` 共享转发 in-flight Promise。PlanControl 用同目录临时文件和不可覆盖发布；遇到已存在文件时严格比较完整身份与消息，只允许完全一致的幂等成功。

## 验证

运行 Launcher 与 PlanControl 聚焦测试，验证并发相同/不同决策、跨调用持久发布、重复转发、失败重试、正文 hash 与 follow-up 参数合同。
