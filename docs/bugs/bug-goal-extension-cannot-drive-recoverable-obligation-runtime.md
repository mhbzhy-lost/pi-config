# Goal Extension 无法驱动可恢复义务运行时

## 问题
现有 `goal_init` 只能建立 planned 任务，runtime 草稿、真实用户审批与进度账本没有接入 Host。

## 复现
以 `execution.schema=goal-runtime.v1` 调用 `goal_init`，此前会因 schema 不支持而无法建立 runtime 草稿，也不会产生 readiness 记录。

## 修复方案
由 Host 注入注册表与 CurrentWorld 捕获器，规范化 runtime 合同后以单批事件保存草稿、会话绑定和 readiness；审批仅接受 challenge 后的真实用户输入，并把 checkpoint 作为 reducer 的进度账本。审批哈希必须绑定目标、提案、合同、HEAD 和会话，且使用独立 `runtimeApproval` 审计字段，避免污染执行修订的 `pendingHumanDecision`。未被已展示 challenge 消费的 runtime 输入必须仅记录无原文的 intent-pending 门禁，并在真正 suspend 前拒绝后续业务动作。

## 安全收口补充

运行时审批事件曾仅校验调用方带入的会话字段，未对投影中的 owner session 复核；CurrentWorld 缺失 canonical HEAD 时也可能在组装草稿事件时触发非结构化异常。修复要求 reducer 重算提案哈希并绑定 event-sourced owner，且在任何追加前将缺失 HEAD 统一转换为 `RUNTIME_READINESS_BLOCKER`。意图门禁先在内存闭锁，再尽力写入 custom entry，持久化异常不得恢复业务动作。

## 受管校准收据目录边界

`validation-runtime` 是 detached supervisor 的私有运行目录，只能保存运行期握手和状态，不能作为父级收据账本。此前 Extension 对 Host 返回的 public receipt 错误要求该目录，导致真实 `managed-validation.mjs` 的 `<stateRoot>/managed-validations/<id>.json` 被拒绝，而测试替身也掩盖了此偏差。

Extension 必须在任何 Observation 事件或启动之前，验证 id、绝对 stateRoot/receiptPath/workspacePath 和 canonical Goal root；public receiptPath 必须严格等于 `<stateRoot>/managed-validations/<id>.json`。不安全 id、相对路径、账本外路径或越界 workspace 一律 attention 且不得产生 Observation 业务事件。

## 校准观察意图优先恢复边界

Cycle0 首次校准曾在持久化 `condition.observation_requested` 前调用 `prepareManagedValidation`。该调用会创建 managed receipt、工作区和租约，不是无副作用的预检；若进程在两者之间崩溃，恢复投影没有 Goal 侧 run intent，却已经留下受管资源。

修复必须固定为：首个 calibration status 仅生成并持久化唯一 requested intent；下一次 status 才经 Extension-owned prepare wrapper 验证 receipt root、path 与 id，并分配租约/启动进程。prepare 抛错或返回不安全 receipt 时保留同一 requested run，返回 attention，reload 不得创建第二个 run；这份 durable intent 是唯一恢复 authority。

## 审批元数据恢复加固

Pi session custom entry 属于不可信恢复输入。此前恢复逻辑通过对象合并接受 challenge、decision、tombstone 与 intent 的未知字段和跨记录错配，伪造记录可能被重新解释为运行时审批权威。

恢复时必须逐条按顺序仅接受原始持久 shape 的普通精确对象：challenge 重算提案哈希并绑定合同哈希、HEAD、目标与会话；decision 与其已恢复 challenge 逐字段绑定；tombstone 只接受关联 challenge 的 `{id}`；intent 只接受无原文的五字段门禁。重复、冲突或异常原型记录一律失效闭锁，且不得输出原始输入或 nonce。

## Observation 请求身份漂移

Observation 请求原先只持久化快照和资源 claims 摘要；reload 时用当前投影和 Host adapter 重建收据，因此同一 adapter ref 换了 version（或 claims）会被误当成原请求。现在 requested Goal event 精确保存 HEAD、执行 revision/contract、condition hash、`{ref,version}` 和 claims hash；replay projection 逐字段保存。恢复在任何 prepare/recover/start/artifact 前对 event-sourced 身份、当前 Condition、Host adapter version 和 canonical claims hash 逐项比对，漂移一律保持 requested 并进入 managed attention。完整 CurrentWorld hash 不作为 reload 闭锁条件，避免 `capturedAt` 等易变字段阻断合法恢复。

## Active 产品 Observation 未接线

### 复现
Cycle 0 完成并激活后，`goal_status` 仅计算 R9 frontier 并返回；即使 frontier 已选择 `request_observation`、`observation_start`、`observation_recover`、`record_observation` 或 `release_observation`，Host 也不调用既有 runner。因此产品 cycle>=1 无法形成事件、证据或稳定性 streak。

### 根因与修复方案
active 分支没有像校准分支一样持有 Host-owned adapter registry、CurrentWorld、Store 和 managed-validation 服务，且没有把 `actionableFrontier` 的唯一 `nextObligationAction` 接到 state-aware Observation 生命周期。修复时每个 status 先捕获 world、追加 checkpoint，再从 registry 构造精确 condition claims 后计算 R9 frontier；只执行被 R9 选中的一个 Observation 内部动作。请求先持久化 requested intent；后续 status 分别 start/recover、record、release。重建收据时复核 event-sourced HEAD、adapter version、claims、Condition hash 和 allocation；任何漂移或缺失 authority 都 attention 且不改变 Observation。Finding/Repair/finalize 保持未接线。

## Cycle 0 未接线

### 复现
审批消费后，runtime 进入 `calibrating`，但每次 `goal_status` 只返回 `RUNTIME_CALIBRATION_REQUIRED`，没有请求、恢复、记录或释放既有 Observation runner 的运行，重载后也没有可恢复的 managed supervisor 收据。

### 修复方案
仅由 Host 注入的 observation adapter、managed-validation 服务与终端 artifact 引用驱动 `goal_status`；Extension 用 Store 作为唯一 Goal 事件持久化权威，并按 Condition 声明顺序每次推进一个 Cycle 0 语义步骤。运行收据从 projection 和确定性 managed allocation 重建，缺少 Host 接线、身份冲突或不可判定终端一律闭锁为 attention，绝不接受调用方的 verdict、命令或 artifact。
