# Goal Extension 无法驱动可恢复义务运行时

## 问题
现有 `goal_init` 只能建立 planned 任务，runtime 草稿、真实用户审批与进度账本没有接入 Host。

## 复现
以 `execution.schema=goal-runtime.v1` 调用 `goal_init`，此前会因 schema 不支持而无法建立 runtime 草稿，也不会产生 readiness 记录。

## 修复方案
由 Host 注入注册表与 CurrentWorld 捕获器，规范化 runtime 合同后以单批事件保存草稿、会话绑定和 readiness；审批仅接受 challenge 后的真实用户输入，并把 checkpoint 作为 reducer 的进度账本。审批哈希必须绑定目标、提案、合同、HEAD 和会话，且使用独立 `runtimeApproval` 审计字段，避免污染执行修订的 `pendingHumanDecision`。
