# Goal 生产终审 provider 未接通

## 现象

`runRecoverableFinalReview()` 已持久化终审 intent，却只将 review identity 传给 provider；真实 `pi/extensions/goal-engine.ts` 也没有注入 provider。因此 production `goal_finalize` 在任何模型调用前以 `FINAL_REVIEW_PROVIDER_UNAVAILABLE` 结束。

## 调用链与首个偏离点

公开入口为 `pi/extensions/goal-engine.ts → createGoalEngineExtension() → goal_finalize → runRecoverableFinalReview()`。权威 approval 是当前 Pi session branch 中与终审 intent 配对的 user entry；manifest 是 Store authority 构建并深冻结、hash 验证的对象；review store 是 `<stateRoot>/final-reviews`。

首个偏离发生在 `runRecoverableFinalReview()` 的 provider 调用：它遗漏了 manifest 和 approval。随后 production composition root 没有构造 provider，故不具备终审模型能力。

## 来源分类

这是 production 可达缺陷，不是 fixture：T3 的集成测试经公开 `runRecoverableFinalReview()` 复现精确五键输入缺失；production entry 的无 provider 路径在真实 `goal_finalize` 前拒绝，不写 started event。

## 修复边界

仅由 production entry 解析非敏感、显式的 `{provider,id,timeoutMs}`，以 Pi 公开 SDK 创建无工具 in-memory provider factory。factory 从 `goal_finalize` 已验证的 stateRoot 创建 0600 content-addressed report store；模型文本不进入 Goal ledger 或 session authority。配置、模型、factory、超时、输出或持久化任一失败均保持 fail closed。
