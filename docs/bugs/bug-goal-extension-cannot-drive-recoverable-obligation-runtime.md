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

R9 将 `requested` 与 `lease_allocated` 同时命名为 `observation_start`；active 分支此前只接受前者，导致进程在 durable allocation 后 reload 时永久 attention。`requested` 仍只能调用 `startObservation`，但 `lease_allocated` 必须先重建并校验同一 managed receipt，再调用 `recoverObservation`，使 runner 回放 process/terminal callbacks 而不生成第二个 supervisor。

## R10 Repair-owned 复验观察未接线

### 复现
最后 remediation Task 被接受后 Episode 已进入 `reverifying`，但 R9 仍持续以 priority 4 的 `repair_episode` 选中它，永久遮蔽该 Episode 下一次 requested Observation 的 priority 5 生命周期。Extension 也没有在 repair 被选中时请求 Observation 并用 `repair.observation_linked` 显式归属；随后 PASS 只记录 Observation，未同批解决 Episode/Finding。

### 修复方案
R9 仅在 reverifying Episode 没有 owned 且未完成的 run 时选择 `repair_episode`；已有 owned requested、lease、process、terminal 或 recorded run 时仅记录 `REPAIR_REVERIFICATION_PENDING` blocker，让既有 Observation 生命周期按原优先级推进。Extension 对这个唯一 repair 语义步骤从当前 world 请求下一 cycle Observation、对中间 projection 规划 link，并用一次 batch 原子提交 request/link。记录 linked run 时先 apply record，再只对显式 owned、fresh PASS 的 reverifying Episode 规划 resolve，单批提交 record/resolve；release 仍由既有 runner 单独闭合资源。所有 batch 的 append 后异常都 reload 验证既成事实，绝不重复请求、link、record 或 resolve。

## Active FAIL 缺少原子修复归属

当前产品 Cycle 1 的 FAIL 虽会记录 evidence 并返回 attention，却没有将 Finding、Repair Episode 与 `condition.observation_recorded` 放进同一个 Store batch。若记录后进程崩溃，failed 账本会没有修复归属；恢复也不能可靠地判定该失败是否已经拥有唯一的 Finding 与 Episode。

修复要求由 Extension 持有记录持久化边界：先以 record event 构造中间 Projection，只从 failed ledger refs 派生 Finding 和 Episode，再将三类事件按顺序使用一次 CAS batch 追加。Cycle 0、PASS、UNKNOWN、INFRA 继续只记录 observation；预追加失败不得留下部分 Goal 状态，durable 后抛错则必须在 reload 后以已提交 batch 为准且不重复追加。

## R10A3 remediation Task 生命周期未接线

### 复现
Cycle 1 autonomous Condition 的产品观察为 FAIL 后，原子 Finding/Episode 虽已落盘，但 `active` Episode 没有由 Host 物化严格 remediation Task。即使已有 waiting Task，R9 仍以 priority 4 `repair_episode` 覆盖 pending Task；runtime status 又向 `actionableFrontier` 传空 `taskActions`，因此无法签发 root Task action offer。最后 runtime `goal_accept` 沿用了 accept-auto 分支，提前追加 `goal.completed`，且未把最后 owned Task 的验收推进到 `reverifying`。

### 根因与修复方案
`schemaVersionForMutation`只认 planned/legacy，generic Task writer 的 `makeGoalEvent` 会拒绝 runtime。

Extension 必须只根据已提交 Condition 的 id、statement、expected 和 remediation.allowed_paths 确定性构造 criteria-only TDD Task，并交给 `validateRemediationTask` 生成 Host-internal metadata 与同批 `goal.amended`/`repair.task_linked`。user-approved 本切片闭锁为 `R10A3_REPAIR_APPROVAL_REQUIRED`。R9 的 waiting episode 仅作 blocker，runtime status 将真实 `taskActionState` Map 传入 frontier，并对选中的 root Task action 签发一次性 offer。runtime generation 的 accept 仅追加 `task.accepted`；最后 owned task 使用同一 batch 追加 `repair.reverification_requested`，永不完成 Goal。

## 非末修复任务 durable accept 恢复边界

### 复现
同一 waiting Episode 含两个 remediation Task 时，第一个 Task 的 `task.accepted` 已由 Store durable 写入后抛错。`goal_accept` 把所有仍 waiting 且包含当前 Task 的 Episode 列入 `reverifyingEpisodes`；durable 恢复即使本次 transition 为空，仍要求该 Episode 已是 `reverifying`，于是第一个 Task 已 accepted 却误报失败。

### 修复方案
按每个 Episode 的实际 transition plan 建立恢复证明：只有本次确实计划并追加 `repair.reverification_requested` 的 Episode 才要求 durable reload 后为 `reverifying`。transition 为空的非末 Task 仅证明自身已 accepted；最后 Task 仍须在同一 canonical batch 中同时证明 accepted 与 reverifying。

## Cycle 0 未接线

### 复现
审批消费后，runtime 进入 `calibrating`，但每次 `goal_status` 只返回 `RUNTIME_CALIBRATION_REQUIRED`，没有请求、恢复、记录或释放既有 Observation runner 的运行，重载后也没有可恢复的 managed supervisor 收据。

### 修复方案
仅由 Host 注入的 observation adapter、managed-validation 服务与终端 artifact 引用驱动 `goal_status`；Extension 用 Store 作为唯一 Goal 事件持久化权威，并按 Condition 声明顺序每次推进一个 Cycle 0 语义步骤。运行收据从 projection 和确定性 managed allocation 重建，缺少 Host 接线、身份冲突或不可判定终端一律闭锁为 attention，绝不接受调用方的 verdict、命令或 artifact。
