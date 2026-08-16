# Goal Extension 无法驱动可恢复义务运行时

## 问题
现有 `goal_init` 只能建立 planned 任务，runtime 草稿、真实用户审批与进度账本没有接入 Host。

## 复现
以 `execution.schema=goal-runtime.v1` 调用 `goal_init`，此前会因 schema 不支持而无法建立 runtime 草稿，也不会产生 readiness 记录。

## 修复方案
由 Host 注入注册表与 CurrentWorld 捕获器，规范化 runtime 合同后以单批事件保存草稿、会话绑定和 readiness；审批仅接受 challenge 后的真实用户输入，并把 checkpoint 作为 reducer 的进度账本。审批哈希必须绑定目标、提案、合同、HEAD 和会话，且使用独立 `runtimeApproval` 审计字段，避免污染执行修订的 `pendingHumanDecision`。未被已展示 challenge 消费的 runtime 输入必须仅记录无原文的 intent-pending 门禁，并在真正 suspend 前拒绝后续业务动作。

## 安全收口补充

运行时审批事件曾仅校验调用方带入的会话字段，未对投影中的 owner session 复核；CurrentWorld 缺失 canonical HEAD 时也可能在组装草稿事件时触发非结构化异常。修复要求 reducer 重算提案哈希并绑定 event-sourced owner，且在任何追加前将缺失 HEAD 统一转换为 `RUNTIME_READINESS_BLOCKER`。意图门禁先在内存闭锁，再尽力写入 custom entry，持久化异常不得恢复业务动作。
