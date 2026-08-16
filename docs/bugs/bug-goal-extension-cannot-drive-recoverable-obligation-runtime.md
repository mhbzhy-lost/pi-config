# Goal Extension 无法驱动可恢复义务运行时

## 问题
现有 `goal_init` 只能建立 planned 任务，runtime 草稿、真实用户审批与进度账本没有接入 Host。

## 复现
以 `execution.schema=goal-runtime.v1` 调用 `goal_init`，此前会因 schema 不支持而无法建立 runtime 草稿，也不会产生 readiness 记录。

## 修复方案
由 Host 注入注册表与 CurrentWorld 捕获器，规范化 runtime 合同后以单批事件保存草稿、会话绑定和 readiness；审批仅接受 challenge 后的真实用户输入，并把 checkpoint 作为 reducer 的进度账本。审批哈希必须绑定目标、提案、合同、HEAD 和会话，且使用独立 `runtimeApproval` 审计字段，避免污染执行修订的 `pendingHumanDecision`。未被已展示 challenge 消费的 runtime 输入必须仅记录无原文的 intent-pending 门禁，并在真正 suspend 前拒绝后续业务动作。

## 安全收口补充

运行时审批事件曾仅校验调用方带入的会话字段，未对投影中的 owner session 复核；CurrentWorld 缺失 canonical HEAD 时也可能在组装草稿事件时触发非结构化异常。修复要求 reducer 重算提案哈希并绑定 event-sourced owner，且在任何追加前将缺失 HEAD 统一转换为 `RUNTIME_READINESS_BLOCKER`。意图门禁先在内存闭锁，再尽力写入 custom entry，持久化异常不得恢复业务动作。

## 审批元数据恢复加固

Pi session custom entry 属于不可信恢复输入。此前恢复逻辑通过对象合并接受 challenge、decision、tombstone 与 intent 的未知字段和跨记录错配，伪造记录可能被重新解释为运行时审批权威。

恢复时必须逐条按顺序仅接受原始持久 shape 的普通精确对象：challenge 重算提案哈希并绑定合同哈希、HEAD、目标与会话；decision 与其已恢复 challenge 逐字段绑定；tombstone 只接受关联 challenge 的 `{id}`；intent 只接受无原文的五字段门禁。重复、冲突或异常原型记录一律失效闭锁，且不得输出原始输入或 nonce。

## Cycle 0 未接线

### 复现
审批消费后，runtime 进入 `calibrating`，但每次 `goal_status` 只返回 `RUNTIME_CALIBRATION_REQUIRED`，没有请求、恢复、记录或释放既有 Observation runner 的运行，重载后也没有可恢复的 managed supervisor 收据。

### 修复方案
仅由 Host 注入的 observation adapter、managed-validation 服务与终端 artifact 引用驱动 `goal_status`；Extension 用 Store 作为唯一 Goal 事件持久化权威，并按 Condition 声明顺序每次推进一个 Cycle 0 语义步骤。运行收据从 projection 和确定性 managed allocation 重建，缺少 Host 接线、身份冲突或不可判定终端一律闭锁为 attention，绝不接受调用方的 verdict、命令或 artifact。
