# Subagent 生命周期总计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 在 Pi `0.85.1` 和 `pi-subagents@0.62.0` 上，先冻结缺失的 authority 契约，再建立可验证的 standalone subagent 生命周期、异常孤儿恢复、durable 投递、completion replay，以及 reply/steer 单投递控制协议基线。

**架构：** `/tmp/subagent-orphan-t0-report.md` 是现场事实门禁：当前没有 `OwnerReceipt`、owner generation/create/rebind/revoke、execution lease、durable registry/outbox/barrier 或 scheduler recovery outcome。本计划将这些全部作为新增 API；Root Broker 是唯一新增 owner/rebind/revoke/lease issuer，workspace 仍只通过 `managed-workspace.v2` public service 改变 workspace。durable 层只保存已签发 receipt 的引用和 delivery 事实，绝不推导或授予 authority。Supervisor control-plane 在 replay/rebind 后新增独立的 request/reply/steer 状态机：它只路由匹配 identity/generation 的 pending request 或仍可 steer 的运行 child，绝不以两种路径重复投递同一 user intent。

**技术栈：** Pi `0.85.1`、`pi-subagents@0.62.0`、Node.js `>=22.19.0`、TypeScript、Node `node:test`、Root Broker RPC、package `./workspace`/`./workspace/admin` public exports、JSON-only private persistence。

## 全局约束

- **本次文档审阅阶段**仅允许修改本总计划；不得修改代码、测试、依赖、其他计划或提交。**获授权的计划执行阶段**不受本次文档审阅的单文件限制，但每个任务只能修改其自身 `WritePaths`；不得借用、扩展或合并其他任务的 `WritePaths`，尤其不得让并行 P2-T3/P2-T4 发生写入冲突。`docs/plans/2026-09-20-subagent-orphan-recovery.md` 是早期背景/现场资料，未完成、不可作为任何任务已完成的前置，也不得按其 DAG 启动实现。
- Pi `0.86.0` 升级不进入本执行批次；它必须另获授权、另写独立计划，且不阻塞 P0–P5。
- `pi-subagents` 固定 `0.62.0`。所有 `pi-subagents/src/*` 深层 import 必须集中到现有 `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts`；其他文件只能使用该 compat 入口或 package public export。升级时必须同步更新 compat 入口、补丁与全量验收。
- T0 仅证明：`registerAuthorizedRun(authorization): Promise<void>`、`stopGoalOwnedRun`、`closeRootSession`、`createManagedWorkspaceService` 和 `managed-workspace.v2` runtime receipt 已存在。`OwnerReceipt`、owner generation/create/rebind/revoke、lease、durable registry/outbox/barrier、120s orphan path 和 scheduler outcome 都是**待新建**能力，文中后续签名不得被理解为现场已有 API。
- 新 Root Broker authority contract 是唯一 owner/stop/rebind/revoke/lease authority。journal、registry、outbox、barrier、child 和 scheduler 不得 stop child、创建/撤销 owner、授予 lease、改变 workspace disposition、settlement 或 terminal fact。
- workspace receipt **只能**来自 `managed-workspace.v2` public service 经 package `./workspace` / `./workspace/admin` exports 返回的实际 receipt；不得从 ledger 私有记录推导、deep import `src/workspace/*`、直接调用 ledger `mutate`、写 workspace record、另建 owner token/ledger，或以 fixture 伪造 receipt。registry/outbox 只保存 receipt reference，绝不修改或推导 workspace、owner 或 disposition。
- durable journal/inventory 只能保存 authorization、Owner、workspace receipt 的 `{id,digest,revision,reference}`，以及 identity、cursor 与 delivery receipt；这些记录不构成 owner、stop、disposition 或 settlement authority。
- JSON-only。payload UTF-8 byte 长度最多 `32 * 1024`，完整 envelope（序列化 JSON、metadata、receipt/correlation 和 broker frame 内容）最多 `64 * 1024`。Root Broker 当前 `64 KiB` frame limit 不等于有效载荷预算：编码、JSON escaping、字段名和 frame overhead 必须计入 envelope，发送前按 UTF-8 byte 测量并 fail closed。
- 敏感键递归检查任意 object/array 深度（大小写无关的 `token`、`secret`、`password`、`credential`、`authorization`、`cookie`、`privateKey` 及产品评审冻结的同义词）；命中、坏 JSON、partial write、锁无法证明或 provenance 未证实时保留现场并产生 `blocked-unknown`，不得预防性兼容。
- delivery 是 durable at-least-once；consumer 用稳定的 `eventId + payloadDigest` 幂等；用户可见 completion 仅以 `runId + terminalReceiptId` exactly-once。必须区分 transport receipt、consumer-processing receipt 和 user-visible completion receipt。
- source identity 永不被 resumed identity 覆盖：保留 `sourceRunId`、`resumedRunId`、`sourceAsyncDir`、`resumedAsyncDir`、同一 `sessionFile`、`processIncarnationId` 和 `ownerGeneration`，并保存每个字段的来源、采集时机、持久化结果及失败原因。正常方案 A 是 stop/drain；resume 不自动收集或接管 active child，只 replay facts；仅用户显式 continuation 才复用同一 `sessionFile` 创建新的 process incarnation。
- **Identity mapping（统一且不可互换）：**`processBirth` 是由受信 `captureProcessBirthIdentity(pid)` 观察的 OS 出生事实（来源：OS/Host；采集：child-start、注册和 rebind 前；持久化：仅 Owner/lease receipt 的 provenance；采集失败：`blocked-unknown`）。`processIncarnationId` 是一次 child 进程生命周期 ID，由真实 `pid + processBirth + 单调 capture sequence` 生成（来源/生成：P0 observation；持久化：lifecycle identity；任一事实缺失即 fail closed）。`sessionId` 是现有 `RunBindingIdentity.sessionId` binding 字段（来源：typed async-started/binding；持久化：authorization reference；不把它当 lifecycle identity）。`sessionFile` 是 native JSONL 文件路径（来源：native session metadata；持久化：identity；不可证明/不完整即 fail closed）。`lifecycleSessionId` 是新增、显式持久化的 lifecycle identity（来源：P1 生成并由 durable lifecycle record 保存；缺失、冲突或写入失败即 `blocked-unknown`）；它绝不由 `sessionId`、`sessionFile`、pid 或 ledger 私有记录推导。
- 默认产品方案为 A：正常 shutdown 经既有 Root close/stop-drain 语义 stop；只有异常 crash 才使用短 orphan lease。P1 在写实现前保留显式产品决策门：若批准 B detached，必须记录审批、更新 policy version 和完整矩阵；未获显式 B 批准绝不静默 detached。
- lease 是版本化、可调策略，而非当前事实：第一版建议 `LifecyclePolicyV1 = {version, heartbeatLeaseMs:60_000, heartbeatRenewMs:15_000, progressStallMs:1_200_000, continueLeaseMs:600_000, brokerRpcDeadlineMs:5_000}`。`ExecutionLeaseV1.expiresAt` 是 authority 是否过期的唯一判定；不得使用 missed-heartbeat counter、连续丢失次数或推算窗口替代它。这些是受信 Host policy，不是模型输入；P1 冻结初值和批准人，后续仅通过新 policy version 调整，不能就地改变已签发 lease 的解释。`childStartTimeoutMs:120_000` 是 P4 独立的启动超时，不是 heartbeat lease。
- 既有 integration `createRecoveryResumeOrchestrator` 的 `startTimeoutMs = 15_000` 保持不变；新增 standalone orphan 入口固定显式 `childStartTimeoutMs = 120_000`，不得复用或覆盖 integration 默认。
- reply 仅回复存在且 identity/generation 匹配的 pending Supervisor request；steer 仅向仍运行且可 steer 的 child 注入新指令。同一 user intent 不得先 reply 再等价 steer；有 pending request 时优先 reply，无 pending request 时禁止伪造 reply；reply 成功后不得自动重复 steer。
- reply/steer 的幂等键、owner/generation 校验、状态迁移、失败和过期语义属于新增 production runtime control-plane 协议；它不是 lease、completion 或 replay 的隐含行为，且在独立协议任务验收前不得修改 Skill。
- 控制协议只在 runtime/tool adapter/RPC 边界执行；TUI 只能基于原始结果作独立精简展示，Skill 只能在最后后置任务描述已验收的模型可见语义。两者不得保存、回显或改写 raw payload，且持续适用敏感信息边界。
- 本计划冻结三类相互独立的语义：`heartbeat authority lease` 只证明受信 Host/Root Broker 的 authority 仍有效，并且只能以 durable `expiresAt` 判定过期；`progress stall detector` 只观察 progress 事件/时间并触发主 Agent 决策，20 分钟 progress stall 不是总执行超时；`stalled-suspected` 不设 decision grace 硬期限。普通长耗时 Bash（包括 active 异步 Bash）、合法 Supervisor 等待和正常 provider/tool I/O 都是 active/合法等待，不计入 stall；只有排除这些情况后才可判定 progress stall。heartbeat renew 不开新 turn、不 spawn、不代表 progress；progress stall 不撤销 authority。进入 `stalled-suspected` 后仅通知主 Agent，并继续 heartbeat renew，直到主 Agent 显式 `reply`、`steer`、`continue` 或 `stop`，或运行进入 `terminal`、`authority lease expiry`。
- 第一版生命周期状态为 `running`、`stalled-suspected`、`stopping`、`terminal`、`lease-expired`。状态转换由 Host/Root Broker 的 durable lease/CAS 机械事实驱动：progress stall（仅在排除 active tool execution/合法等待后）进入 `stalled-suspected` 并请求主 Agent 决策；`now >= expiresAt` 进入 `lease-expired` 并记录 `authority_lease_expired`，不得使用连续 heartbeat 丢失推导 `authority-lost`。正常 stop、`authority_lease_expired`、`progress_stalled` 与 `explicit_stop` 必须以不同 reason/event 记录；不得把这些状态或事件互相等价为 terminal 或 workspace disposition。
- heartbeat 只由主 Host/runner control plane 按 lease/CAS 机械续租；它不读取模型输入、不启动 turn、不 spawn、不改变 session。续租不能依赖 child Node event loop。subagent 自身 timer/运行时读取 durable `expiresAt`，到期记录 `authority_lease_expired` 并退出；不作语义进展判断。主 Host crash 后停止 renew，subagent 按 `expiresAt` 自行退出。pending Supervisor request 只能 `reply`，无 pending 才能 `steer`，reply 成功后禁止等价 steer；`continue` 只能签发有限的 `continueLeaseMs` 新 lease。stalled-suspected 仅通知主 Agent并继续 heartbeat renew，直到显式 reply/steer/continue/stop、terminal 或 authority lease expiry，不设决策硬期限。
- **Heartbeat/progress stall 硬不变量：** heartbeat/lease renew 是纯 control-plane 操作，绝不触发主 Agent 或 subagent 的任何 model turn；heartbeat/renew 路径不得调用 `sendMessage`、`sendUserMessage`、`triggerTurn`、`followUp`、`steer`、`reply`、`resume` 或 `spawn`。它只允许校验 `runId`、`ownerGeneration`、`processIncarnationId`、`sessionFile`，并以 CAS 更新 `lease.lastRenewedAt`、`lease.expiresAt`、`renewalSequence`。heartbeat 不得新增主/子 session entry、user/assistant/custom message、tool call、`tool_execution_start`/`tool_execution_end`、`async-started`、completion 或改变 `runId`/`sessionFile`/`processIncarnationId`。`progress_stalled` 可以是 durable control-plane event，但 heartbeat renew 绝不产生它；两条路径均不得产生 session/message/tool/async/completion/turn 副作用。progress stall 同样不得自动触发任何 turn 或上述投递动作，只更新 control-plane 状态并等待主 Agent 主动控制；普通异步 Bash/合法等待不计 stall。
- **Heartbeat/progress TDD 门禁：** P2/P3/P4 必须先以失败测试锁定上述禁止调用、四项 identity 校验、三项 lease CAS 更新、零 session/message/tool/async/completion side effect、progress stall 不自动 turn 和普通异步 Bash/合法等待不计 stall；再实现最小行为并运行 GREEN 与对应回归。任何只凭 prose、日志或模型输出的证明均不满足验收。

## 现场事实、命名与边界

- `SessionManager.open` 已在 package native conversation 中以 `SessionManager.open(snapshot)` 使用，适合只读 materialization/inspect；它本身不能被写成创建 child 或 resume 的既有公开入口。
- 现有官方 runtime resume 调用入口是 `createRecoveryResumeOrchestrator` 注入的 typed `rpc.resume({ id, message })`；其生产顺序是 `rpc.resume` → `subagent:async-started` identity 校验 → `registerAuthorizedRun` → `activateResume`。P0 必须以此真实调用入口作临时 PoC，而不是声称存在未定义的 collector。
- `processIncarnationId` 是本计划的新 identity 字段：P0 以真实 child pid、`captureProcessBirthIdentity` 结果和单调本地 capture sequence 组成可比较值；若任一来源不可采集，记录 provenance 与失败并 fail closed，不伪造既有 collector/public API。
- `managed-workspace.v2` 是现有运行时 receipt schema，且没有名为 `WorkspaceReceipt` 的现场导出；P2 只冻结其 reference adapter，不伪造类型名或 revision 字段来源。

## DAG

```text
P0-T1（仓库外只读/临时 resume PoC）
  └─> P0-T1-GATE（recovery eligibility gate；P0 收尾）
        └─> P1-T2（identity、纯 policy/contract 与可注入 clock 冻结）
        ├─> P2-T3（新 Root Broker authority contract 与实现）
        └─> P2-T4（durable inventory/outbox/barrier contract 与实现）
              \                                      /
               └──────── T3/T4 均完成 ──────────────> P3-T5（Supervisor replay）
                                                        └─> P3-T6（Supervisor reply/steer control-plane）
                                                              └─> P4-T7（orphan recovery 与 crash matrix）
                                                                    └─> P5-T8（scheduler typed outcome 冻结和真实路径接入）

P6-T9（dispatch Skill 同步）是 P0–P5 当前执行批次之外的独立后置变更：仅在 P3/P4/P5 已验收、完整 runtime/control-plane 回归通过且另获执行授权后启动。

Pi 0.86.0 兼容性＝后续独立授权、独立计划；不属于本图或当前执行批次。
```

**依赖理由：** P0-T1-GATE 是 P0 收尾和 P1-T2 的硬前置：它在任何官方 `rpc.resume` 前验证 session content/provenance eligibility，证明 `SessionManager.open` 只读且不构成恢复资格；只有合法 header、可解析 session content/provenance 和字段身份一致时才允许继续。Root authority gate 不属于 P0，移至 P2-T3；P0 通过只证明 feasibility/eligible-for-P1，不代表安全 orphan recovery 已完成。T3 产出所有后续可引用的新 schema、revision/digest、CAS 和 deadline 契约。T3 与 T4 仅消费 P1 的不同产物且 WritePaths 不重叠，故可并行；T5 同时消费 T3 的有效 OwnerReceipt/lease 和 T4 的 inventory/outbox/barrier，必须在两者汇合后执行。T6 消费 T5 已验收的 replay/rebind identity、generation 与 delivery 边界，才能把 pending reply 和 live steer 的单投递决策放在真实 Supervisor runtime protocol；它不授予 authority，也不改变 completion。T7 只能在 T6 已建立控制协议后串联 orphan/rebind；T8 只能消费 T7 已验收的 typed outcome。T9 是当前 P0–P5 批次外的独立后置文档/Skill 变更，必须消费 P3/P4/P5 已通过的真实生命周期与 control-plane 行为和完整验收结果。

## Waves

- Wave 1：P0-T1。
- Wave 2：P0-T1-GATE（P0 收尾；仅在 T1 证据完整后执行）。
- Wave 3：P1-T2。
- Wave 4：P2-T3、P2-T4（可并行；WritePaths 不重叠）。
- Wave 5：P3-T5（等待 T3/T4 汇合）。
- Wave 6：P3-T6。
- Wave 7：P4-T7。
- Wave 8：P5-T8。
- P6-T9 不属于当前 P0–P5 执行 Waves；它是另获授权后的独立后置批次。

**关键路径：** `P0-T1 → P0-T1-GATE → P1-T2 → (P2-T3 && P2-T4) → P3-T5 → P3-T6 → P4-T7 → P5-T8`。P6-T9 是当前批次外、另行授权的后置任务；Pi 0.86.0 兼容性也不属于当前关键路径。

---

## P0：仓库外只读/临时 PoC

### Task P0-T1：证明官方 resume 的 source/resumed identity

**Deps：** `none`

**WritePaths：** `/tmp/subagent-lifecycle-poc/`（仅临时脚本、session fixture、日志和进程现场；不进入仓库、不得提交）。

**Resources：** 一个临时 native session root 与最多一个 child process；PoC 串行。

**Files：** Create：`/tmp/subagent-lifecycle-poc/resume-poc.ts`、`/tmp/subagent-lifecycle-poc/native-session-fixture.jsonl`、`/tmp/subagent-lifecycle-poc/resume-poc.test.mjs`。 Modify：none。 Test：`/tmp/subagent-lifecycle-poc/resume-poc.test.mjs`；特别禁止 `test/subagent-lifecycle-poc.test.mjs` 或任何 repo WritePath。

**接口契约：**
- Consumes：只读 `SessionManager.open(sessionSnapshot)`，其真实可达 import 是 `@earendil-works/pi-coding-agent`（现有 `packages/pi-subagents-enhanced/src/tui/native-conversation.ts` 的同一 public import）；fixture 入口采用临时 native JSONL sessionFile，并由该 package 的真实 `SessionManager.open(sessionFile)` materialize。resume 只经现有 `createRecoveryResumeOrchestrator` 注入的 typed `rpc.resume({id,message})`、`subagent:async-started` 事件和现有 process-birth capture；不得虚构 collector 或另一种官方 resume API。
- Produces：仅 `/tmp` evidence JSON，含 source/resumed identity、每一字段的 source/capture time、`processIncarnationId` 组成、native eligibility 和失败 provenance；不产出 production collector、registry 或 lease API。

**验收标准（P0 报告边界）：** 核心 A–F 必须分别报告且只有实证后才能标为通过：A provider 可用；B ping；C spawn；D `async-started`；E child native `sessionFile`；F `SessionManager.open`；以及同一 `sessionFile` 的 resume 新 run/process incarnation（该 resume 关系也必须在报告中保留）。G 为分层负向验收：`--no-session`、missing session 和 external CLI 必须 fail closed，三者均通过才可标为通过。`SessionManager` 对合法 session header 加 torn JSONL tail 的逐行跳过 malformed JSON/补换行，是官方 repair 行为，不是本 P0 的 fallback，也不应作为失败；不得把该场景的成功当作损坏输入普遍可恢复的证据。

无合法 session header、header identity mismatch、以及完全不可解析的 JSON 必须 fail closed；其中任一项尚未被真实验证时，P0 整体状态必须为 `blocked-unknown`，不得进入 P1。尤其要记录目前 all-invalid damaged fixture 曾 unexpected-success 的事实，不能将其报告为通过或用官方 repair 合理化。上述 gate 仅验证 session content/provenance eligibility，不验证 OwnerReceipt、ownerGeneration 或 processBirth。临时环境无法启动 native child（包括 `SessionManager.open` materialization 或官方 resume 无法完成）时，也记录实际入口、失败 provenance 和现场后以 `blocked-unknown` 结束；不得强制 GREEN、伪造 collector、将 fake child 当 production proof，或创建仓库 fixture/test。

- [ ] **步骤 1：先 Create 失败的 `/tmp` probe assertions**：创建 `/tmp/subagent-lifecycle-poc/resume-poc.test.mjs`，断言核心 A–F 与同一 `sessionFile` 的新 run/process incarnation；将 G 分成 `no-session`、missing session、external CLI 三个 fail-closed 断言，并另测无合法 header、header identity mismatch、完全不可解析 JSON。对合法 header+torn JSONL tail 单独记录官方 `SessionManager` repair（逐行跳过 malformed JSON/补换行），不得将 repair 当 fallback 或把它混入失败断言。断言 `{sourceRunId,resumedRunId,sourceAsyncDir,resumedAsyncDir,sessionFile,processIncarnationId}` 非空、run/asyncDir 不等、sessionFile 同一。
- [ ] **步骤 2：运行 RED**：`node --test /tmp/subagent-lifecycle-poc/resume-poc.test.mjs`；预期 probe 尚未实现导致断言失败（不是 module-not-found）。
- [ ] **步骤 3：实现最小临时 probe**：以 `SessionManager.open` 只读 inspect session snapshot；经 existing typed `rpc.resume({id,message})` 真正触发 resume；从 async-started + process-birth capture 组装 identity。不可定义或导出虚构的 `collectProcessIncarnation`。
- [ ] **步骤 4：运行 GREEN 或受阻结束**：同命令；只有真实 native child 可启动且核心 A–F、G 分层负向项及三项损坏输入均真实验证时才可 GREEN。合法 header+torn tail 的成功只能记为官方 repair；无合法 header、header identity mismatch、完全不可解析 JSON 任一未验证或 all-invalid fixture 仍 unexpected-success 时，记录现场并将 P0 标为 `blocked-unknown`，停止 P0，不虚构 GREEN 或 fallback。
- [ ] **步骤 5：生成 P0 报告并做 DAG 门禁**：报告逐项列出 A–F、G 三层、三项损坏输入、官方 repair 与 source/resumed/process incarnation provenance；任何未验证的损坏负向项都阻断 P1，不能仅以合法 torn-tail repair 放行。
- [ ] **步骤 6：运行未改动路径回归**：`node --test test/recovery-resume-contract.test.mjs`；确认现有 15s integration contract 未变。

**P0 当前状态：** `feasibility-proven / eligible-for-P1`（已确认 Colima A–F、no-session/missing/external fail closed、合法 header+torn tail 为官方 repair、且 `SessionManager` 接受 header mismatch）。该状态仅表示 session content/provenance gate 已通过，不代表安全 orphan recovery 完成；OwnerReceipt、ownerGeneration、processBirth、rebind 与 lease 仍由 P2 新建。mismatch、no-header、unparseable 或身份不一致必须保持 `blocked-unknown` 且 `resumeCallCount === 0`。

### Task P0-T1-GATE：在官方 resume 前冻结 recovery eligibility gate

**定位：** P0 收尾、P1-T2 的硬前置。根据 P0 Colima 实证结果，`SessionManager.open` 会接受 header identity mismatch；因此它只能负责只读读取/物化内容，不能作为恢复资格证明，也不能替代本 gate。本 gate 只做 session content/provenance eligibility；Root authority gate、OwnerReceipt、ownerGeneration 和 processBirth 校验移至 P2。

**Deps：** `P0-T1` 的 source/resumed identity 观察、合法 header+torn-tail repair 观察及三类拒绝 fixture 证据。

**WritePaths：** `/tmp/subagent-lifecycle-poc/`（仅临时 probe、provenance fixture、日志和证据；不进入仓库、不得提交）。不得修改 `SessionManager`、官方 runtime、生产代码、仓库测试或依赖。

**Files：** Create：`/tmp/subagent-lifecycle-poc/recovery-eligibility-gate.mjs`、`/tmp/subagent-lifecycle-poc/recovery-eligibility-gate.test.mjs`、`/tmp/subagent-lifecycle-poc/fixtures/eligible-header-torn-tail.jsonl`、`/tmp/subagent-lifecycle-poc/fixtures/header-identity-mismatch.jsonl`、`/tmp/subagent-lifecycle-poc/fixtures/no-header.jsonl`、`/tmp/subagent-lifecycle-poc/fixtures/unparseable.jsonl`、`/tmp/subagent-lifecycle-poc/provenance.json`。 Modify：none。 Test：`/tmp/subagent-lifecycle-poc/recovery-eligibility-gate.test.mjs`。

**Gate contract：** 在调用官方 typed `rpc.resume({id,message})` 之前，先读取 session header 并验证 session content/provenance eligibility：合法 header、canonical `sessionFile`、`status/result/recovery descriptor`、`sourceRunId`、`sessionId`、`agentProfile`、`cwd` 及其身份一致性。gate 不要求、也不验证 `OwnerReceipt`、`ownerGeneration` 或 `processBirth`；这些是 P2 的 Root authority gate。不得从 `SessionManager` 成功、prompt、profile 或 started event 推导 authority。gate 只返回 `eligible` 或带脱敏 provenance 的 `blocked-unknown`。

**判定矩阵：** 合法 header 加可由官方 `SessionManager` repair 的 torn JSONL tail 可标记 `eligible`，并允许随后调用官方 `rpc.resume`；header identity mismatch、无 header、header 不可解析/完全不可解析 JSON、任一 `status/result/recovery descriptor`、`sourceRunId`、`sessionId`、canonical `sessionFile`、`agentProfile` 或 `cwd` 缺失/身份不一致，均必须为 `blocked-unknown`，且 `resumeCallCount === 0`。不得把“`SessionManager.open` 成功”升级为资格证明；不得用 repair 放宽 mismatch、no-header 或 unparseable 输入。Root authority 缺失、过期、代际或 process identity 不匹配由 P2 gate 拒绝，不是 P0 gate 的判定条件。

**Provenance fixture：** 每个 fixture 及 gate 结果必须记录 `fixtureId`、canonical `sessionFile`、header digest、`status/result/recoveryDescriptor`、`sourceRunId`、`sessionId`、`agentProfile`、`cwd`、采集时间、判断结果、失败 reason 和 `resumeCallCount`。P0 仅记录 session content/provenance；Root Broker authority receipt/reference、owner generation、process identity 属于 P2 provenance。日志只保存脱敏 identity/digest/reference，不保存 token、secret、credential、authorization、cookie、privateKey 或 raw payload。

- [ ] **步骤 1：先 Create 失败测试和 provenance fixture**：创建上述 `/tmp` 测试、四类 fixture 及 provenance schema；stub 官方 `rpc.resume` 计数器，断言合法 header+torn tail 仅在全部 session content/provenance 字段一致时可放行，四类非法/不一致场景均 `blocked-unknown` 且 `resumeCallCount === 0`。断言 `SessionManager.open` 即使接受 mismatch 也不改变 gate 结果。
- [ ] **步骤 2：运行 RED**：`node --test /tmp/subagent-lifecycle-poc/recovery-eligibility-gate.test.mjs`；预期为 gate 尚未实现导致的具体 assertion failure，不接受 `ERR_MODULE_NOT_FOUND` 或缺测试文件作为 RED。
- [ ] **步骤 3：实现最小只读 gate**：只解析 header、读取并比对既有 provenance/authority 输入；先 gate、后官方 `rpc.resume`，不修改 `SessionManager`，不创建 collector、owner、lease 或 recovery API，不把读取内容写回 session。
- [ ] **步骤 4：运行 GREEN 与 P0 门禁**：同 RED 命令；只有合法 header+torn tail 通过且所有 mismatch、无 header、不可解析、身份不一致均 `blocked-unknown`、`resumeCallCount === 0` 才能将 P0 结束状态设为 `feasibility-proven / eligible-for-P1`；该状态不表示安全 orphan recovery 完成。任一失败或证据缺失，P0 保持 `blocked-unknown` 并阻断 P1。
- [ ] **步骤 5：运行 P0 回归**：`node --test /tmp/subagent-lifecycle-poc/resume-poc.test.mjs && node --test test/recovery-resume-contract.test.mjs`；确认官方 repair 仍是唯一允许的 torn-tail 行为、现有 integration 15s contract 未变，且 SessionManager 无任何修改。

## P1：identity、stop 语义与策略冻结

### Task P1-T2：冻结 identity、纯 policy/contract、可注入 clock 与 LifecyclePolicyV1

**Deps：** `P0-T1-GATE`（消费真实 `/tmp` source/resumed fixture、拒绝矩阵及已验证的 session content/provenance eligibility；不得绕过 gate 直接恢复；不把 P0 证据当作 OwnerReceipt 或 orphan-safety 证明）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/lifecycle-identity.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/lifecycle-policy.ts`
- `test/subagent-lifecycle-contract.test.mjs`
- `test/lifecycle-policy.test.mjs`

**Resources：** none。

**Files：** Create：`lifecycle-identity.ts`、`lifecycle-policy.ts`、`test/subagent-lifecycle-contract.test.mjs`、`test/lifecycle-policy.test.mjs`。 Modify：none。 Test：`test/subagent-lifecycle-contract.test.mjs`、`test/lifecycle-policy.test.mjs`。

**接口契约：**
- `LifecycleIdentityV1` 包含所有 source/resumed 字段、`processIncarnationId`、`ownerGeneration`、每字段 `provenance`、`capturedAt`、`persistenceState` 和 `failure`；`parseLifecycleIdentityV1` 拒绝交换 source/resumed、缺 process birth 或不可证明的 sessionFile。
- `classifyRecoveryEligibility(sessionMeta)` 返回 `eligible` 或 `blocked-unknown` 及 `native-session-required|no-session|external-cli|incomplete-session|identity-unproven`。
- `resolveGracefulShutdownPolicy({decision,approval})`：未冻结为 `pending-decision`；冻结 A 后仅为 `stop-drain`；B 必须具备显式 approval。`LeasePolicyV1` 随 identity/receipt 保存其 policy version。
- 只定义纯函数 policy/contract 与 `Clock = { now(): number }` 注入点：`evaluateLeaseExpiry` 仅以 `expiresAt` 判定，`classifyProgressStall` 仅在排除 active tool execution（包括 active 异步 Bash）、合法 Supervisor 等待和正常 provider/tool I/O 后给出 `stalled-suspected`/`progress_stalled` 建议，`resolveGracefulShutdownPolicy` 和 `continueSession` 仅返回 next-state/lease-input contract。它们不得创建真实 timer、调用 storage、broker、workspace、child RPC 或写 durable event；不得执行 renew、expiry self-exit 或 recovery。这些实际 renew/expiry/recovery 行为分别由 P2-T3/P4-T7 实现。
- 状态解析只允许 `running|stalled-suspected|stopping|terminal|lease-expired`；正常 stop、`authority_lease_expired`、`progress_stalled` 与 `explicit_stop` 分开建模，且不得由模型或 progress 事件直接授予/延长 authority。

**验收标准：** 字段来源分别覆盖 PoC event、Root receipt、workspace public receipt 或 policy；生成时机为 resume observation/rebind/lease issuance；持久化失败 fail closed。默认 A 的正常 stop/drain 和异常 crash 短 lease 明确可测，B 没有审批不能生效。

- [ ] **步骤 1：先 Create 失败测试**：创建 `test/subagent-lifecycle-contract.test.mjs`、`test/lifecycle-policy.test.mjs`，覆盖完整 schema/serialization、字段 provenance、四类 eligibility、五种状态、60s/15s/20m/10m policy 初值、可注入 clock、仅 `expiresAt`、A/B 决策门、普通长耗时 Bash/合法等待不 stall、四类独立 reason/event，以及明确断言纯 contract 不创建 timer、不调用 storage/broker/workspace/child RPC、不执行 renew/expiry/recovery。
- [ ] **步骤 2：运行 RED**：`node --test test/subagent-lifecycle-contract.test.mjs test/lifecycle-policy.test.mjs`；预期为新增 pure-contract assertion failure，不接受 module-not-found。
- [ ] **步骤 3：实现最小 identity/policy 模型**：只实现 pure identity/policy/clock contract；不接入真实 timer、storage、broker、workspace、child RPC、既有 close/stop 或 integration timeout。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：回归**：`node --test test/recovery-resume-contract.test.mjs test/recovery-resume-orchestrator.test.mjs`。

## P2：先冻结 authority，再分别实现 authority 与 durable 投递

### Task P2-T3：新建并实现 Root Broker owner/rebind/revoke/lease authority contract

**Deps：** `P1-T2`（消费 identity、纯 policy/contract、可注入 clock 与方案 A 决策；本任务同时冻结并实现 authority contract）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/rebind-fencer.ts`
- `packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts`
- `test/root-subagent-rebind.test.mjs`
- `test/root-subagent-broker-protocol.test.mjs`
- `test/root-subagent-broker.test.mjs`
- `test/workspace-recovery-contract.test.mjs`

**Resources：** one serial local broker fixture。

**Files：** Create：`authority-contract.ts`、`rebind-fencer.ts`、`test/root-subagent-rebind.test.mjs`、`test/workspace-recovery-contract.test.mjs`。 Modify：`root-broker-protocol.ts`、`root-broker-client.ts`、`root-broker-server.ts`、`root-session-owner.ts`、`test/root-subagent-broker-protocol.test.mjs`、`test/root-subagent-broker.test.mjs`。 Test：`test/root-subagent-rebind.test.mjs`、`test/workspace-recovery-contract.test.mjs`、`test/root-subagent-broker-protocol.test.mjs`、`test/root-subagent-broker.test.mjs`。

**接口契约：** **Root authority gate 从 P0 移至本 P2 任务。** 本任务开头显式声明：`OwnerReceiptV1`、owner generation、`createOwnerReceipt`、`rebindRun`、`revokeOwner` 与 execution lease 全部是待新建的 authority contract，不是现有 API。先在 `authority-contract.ts` 冻结 `OwnerReceiptV1 = {receiptId,rootSessionId,runId,ownerGeneration,processBirth,revision,digest,authorizationReference}`、`ExecutionLeaseV1`、canonical digest、generation/revision CAS、processBirth/PID-reuse fail-closed 错误码及新 RPC 专用 `deadlineMs:5_000`；再由 Broker producer/validator 实现。`createOwnerReceipt`、`rebindRun({runId,expectedGeneration,processBirth,lifecycleSessionId,expectedRevision})`、`revokeOwner(...)` 与 `issue|renew|releaseExecutionLease(...)` 是新 surface；`registerAuthorizedRun(authorization): Promise<void>` 保持原签名、返回值和调用者语义，`createRootBrokerClient` 通用默认 10s 保持不变。workspace adapter 只能验证从 `./workspace`/`./workspace/admin` public service 获得的真实 `managed-workspace.v2` receipt；缺少可证明 revision/digest 时返回 `blocked-unknown`。child 只新增 `observeExecutionLease(runId,leaseId,now)` 和 expiry report，不可 create/rebind/revoke/renew lease。正常 stop 继续只经既有 `stopGoalOwnedRun`/`closeRootSession`，不能由 lease expiry 伪造 stopped。

**验收标准：** 三层 receipt（Owner、lease、workspace reference）各有签发/验证边界；所有 authority durable commit 先于成功回复；重复 renewal 用 `expectedRenewalSequence` 幂等且不延长 expiry，renew 不 spawn/new turn/session change；主 Host crash 停止 renew 后，subagent 自身 timer/运行时只按 durable `expiresAt` 检查并退出；不判断 progress，且不依赖额外进程。旧 generation、PID reuse、CAS 冲突、timeout 均 fail closed。

- [ ] **步骤 1：先 Create 失败测试**：创建 `test/root-subagent-rebind.test.mjs` 与 `test/workspace-recovery-contract.test.mjs`，并在既有 broker tests 添加断言；覆盖新 contract 的 create/rebind/revoke、receipt durable commit、CAS/PID reuse、重复 renew 不 spawn/new turn/session change、专用 5s deadline、child 只观察、public workspace receipt provenance 和旧 register compatibility；主 Host crash 后停止 renew，subagent 在 `expiresAt` 到期时自行记录 `authority_lease_expired` 并退出；不能保证同步阻塞 JS/第三方扩展期间的 timer 执行，不引入额外进程补偿。
- [ ] **步骤 2：运行 RED**：`node --test test/root-subagent-rebind.test.mjs test/workspace-recovery-contract.test.mjs test/root-subagent-broker-protocol.test.mjs`；预期为新增 contract 行为的具体 assertion failure，禁止以 `ERR_MODULE_NOT_FOUND` 或缺少测试文件作为 RED。
- [ ] **步骤 3：实现最小 authority**：先实现 `authority-contract.ts` 的冻结 parser/type/error surface，再按该新 contract 修改 Broker/client；保持旧 `Promise<void>`、通用 10s client/integration 行为和仅新 RPC 的 5s deadline。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：回归**：`npm run typecheck:subagents-enhanced && node --test test/root-subagent-rebind.test.mjs test/workspace-recovery-contract.test.mjs test/root-subagent-broker-protocol.test.mjs test/root-subagent-broker.test.mjs test/recovery-resume-orchestrator.test.mjs`。

### Task P2-T4：实现 durable inventory、outbox 与 replay barrier

**Deps：** `P1-T2`（消费 identity、policy version、可注入 clock 与 authority-negative contract；Owner reference 在本支保持 opaque，不等待 T3 实现）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-contract.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-run-registry.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-event-outbox.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/replay-barrier.ts`
- `test/durable-lifecycle.test.mjs`
- `test/subagent-delivery-recovery.test.mjs`

**Resources：** isolated temporary durable root; tests serial per root。

**Files：** Create：`durable-contract.ts`、`durable-storage.ts`、`durable-run-registry.ts`、`durable-event-outbox.ts`、`replay-barrier.ts`、`test/durable-lifecycle.test.mjs`、`test/subagent-delivery-recovery.test.mjs`。 Modify：none。 Test：`test/durable-lifecycle.test.mjs`、`test/subagent-delivery-recovery.test.mjs`。

**接口契约：**
- inventory `recordInventory/loadInventory` 只写 authorization/Owner/workspace references 的 id/digest/revision/reference，拒绝完整 owner token、stop/disposition/settlement state；private storage root 不复用 workspace ledger，锁内不调用 broker/workspace/child RPC。
- `appendEvent` 先 durable commit transport receipt；`recordConsumerProcessingReceipt` 以 consumer idempotency key durable commit；`ackReceipt` 不在 ACK 前删除。`replaySupervisor` 以后只可产生 user-visible completion receipt。
- `ReplayCursorV1 = {rootSessionId,runId,ownerGeneration,epoch,sequence}`；`beginReplayBarrier` durable 记录 high-water cursor，`switchLiveAfterBarrier` 只接收同 root/run/generation/epoch 且 sequence 大于 barrier 的 frame。

**验收标准：** 三层 receipt、durable commit 和 consumer idempotency 分离可测；递归 sensitive-key 与 UTF-8 32/64KiB/overhead 都 fail closed；旧 generation/epoch/live frame 被拒，journal negative tests 证明其不授予 authority。

- [ ] **步骤 1：先 Create 失败测试**：创建 `test/durable-lifecycle.test.mjs`、`test/subagent-delivery-recovery.test.mjs`，以大小边界、frame overhead、深层敏感键、partial/bad JSON/CAS/lock、authority 禁止项、重复 delivery/ACK、barrier cursor 与旧 epoch/generation 编写可执行断言。
- [ ] **步骤 2：运行 RED**：`node --test test/durable-lifecycle.test.mjs test/subagent-delivery-recovery.test.mjs`；预期为未实现行为的具体 assertion failure，不接受 module-not-found。
- [ ] **步骤 3：实现最小 durable components**：使用独立 private root、revision CAS、quarantine，且只依赖 P1 冻结的 opaque receipt-reference contract，不调用或等待 T3 Broker 实现。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：回归**：`node --test test/durable-lifecycle.test.mjs test/subagent-delivery-recovery.test.mjs test/recovery-resume-contract.test.mjs`。

## P3：Supervisor replay

### Task P3-T5：实现 completion replay 与 user-visible exactly-once

**Deps：** `P2-T3`（消费有效 OwnerReceipt/lease）；`P2-T4`（消费 inventory/outbox/barrier/cursor）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-replay.ts`
- `test/supervisor-replay.test.mjs`
- `test/subagent-delivery-recovery.test.mjs`

**Resources：** two restartable Node process fixtures, one replay fixture。

**Files：** Create：`supervisor-replay.ts`、`test/supervisor-replay.test.mjs`。 Modify：`test/subagent-delivery-recovery.test.mjs`。 Test：两者。

**接口契约：** `replaySupervisor({rootSessionId,runId,ownerReceipt,after:ReplayCursorV1})` 只读 inventory 和 authority receipts，驱动 outbox；返回 `{transportReceipts,processingReceipts,userVisibleCompletionReceipt}`。用户可见 completion durable dedupe key 固定 `runId + terminalReceiptId`；不得改写 terminal/owner/workspace/lifecycle。

**验收标准：** offline/restart/ACK loss 仍 at-least-once；processing 以 event digest 幂等；completion exactly-once；replay 只在 barrier switch 后 live，receipt 无效则 `blocked-unknown`。

- [ ] **步骤 1：先 Create 失败测试**：创建 `test/supervisor-replay.test.mjs`，并在 P2-T4 已创建的 `test/subagent-delivery-recovery.test.mjs` 添加断线、重启、ACK 丢失、重复 event、重复 terminal completion、旧 cursor/owner receipt 的断言。
- [ ] **步骤 2：运行 RED**：`node --test test/subagent-delivery-recovery.test.mjs test/supervisor-replay.test.mjs`；预期为新增 replay assertion failure，不接受 module-not-found。
- [ ] **步骤 3：实现最小 replay adapter**：仅组合 P2 的 public contract，不增加 authority 或 workspace mutation。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：回归**：`node --test test/subagent-delivery-recovery.test.mjs test/supervisor-replay.test.mjs test/root-subagent-rebind.test.mjs`。

## P3：Supervisor replay/rebind 后的控制平面

### Task P3-T6：实现 stalled-suspected decision 与 reply/steer 单投递控制协议

**Deps：** `P3-T5`（理由：消费已验收的 replay barrier、`ReplayCursorV1`、有效 OwnerReceipt 和 user-visible completion 边界；control-plane 只在 rebind/replay 后对当前 generation 路由，不重写 completion）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts`
- `test/subagent-supervisor-adapter.test.mjs`
- `test/subagent-runtime-membrane.test.mjs`
- `test/subagent-dispatch-rpc.test.mjs`
- `test/pi-subagents-runtime.integration.mjs`

**Resources：** one serial native Supervisor/runtime fixture；测试使用隔离 in-memory request registry，不写 durable workspace、journal 或 TUI raw payload。

**Files：** Create：`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`。Modify：`supervisor-adapter.ts`、`extension.ts`、`rpc-client.ts`。Test：`test/subagent-supervisor-adapter.test.mjs`、`test/subagent-runtime-membrane.test.mjs`、`test/subagent-dispatch-rpc.test.mjs`、`test/pi-subagents-runtime.integration.mjs`。

**接口契约：**
- `stalled-suspected` 仅由 Host progress stall detector 在排除 active 异步 Bash、合法 Supervisor 等待和正常 provider/tool I/O 后，`progressStallMs`（20 分钟）无语义进展时产生；progress stall 不是总执行超时。它记录 `progress_stalled` 并向主 Agent 发起 decision。只有 progress stall 才能进入 `stalled-suspected`；该状态仅通知主 Agent，继续 heartbeat renew，直到主 Agent 显式 `reply`、`steer`、`continue` 或 `stop`，或 terminal/authority lease expiry，不设 decision grace 硬期限，不能由模型输入改变 authority lease。heartbeat renew 不开新 turn、不 spawn、不改变 session。
- `SupervisorRequestV1 = {requestId,runId,rootSessionId,ownerGeneration,requestGeneration,requestDigest,createdAt,expiresAt,state:"pending"|"replying"|"replied"|"expired"|"failed"}`；request ingress 幂等键为 `rootSessionId + runId + ownerGeneration + requestGeneration + requestId + requestDigest`，相同 native request 重放只返回既有 pending/terminal record，绝不增加第二个 pending。只有已由 native `subagent_supervisor_request` ingress 观察、且其 current `OwnerReceiptV1` identity/root/owner generation 与 rebind 后 live binding 全部匹配的 `pending` 记录可回复。request 不存在、已过期、request generation 旧、owner/generation 不匹配或 child 不再运行均 fail closed；不得伪造 reply。
- `SupervisorControlIntentV1 = {intentId,runId,rootSessionId,ownerGeneration,kind:"reply"|"steer",payloadDigest}`。reply 幂等键为 `requestId + requestGeneration + payloadDigest`，steer 幂等键为 `runId + ownerGeneration + payloadDigest + liveRunEpoch`；同键重试返回先前 terminal delivery receipt，绝不二次发送。不同 key 却有等价 `payloadDigest` 的同一 `intentId` 在 `replying|replied` 时必须拒绝 `steer-after-reply`，从而禁止同一 user intent 先 reply 后等价 steer。
- `resolveSupervisorControl({intent,currentOwner,now})` 先加载当前 generation 的 pending request：存在匹配 pending 时只允许 `reply`，无 pending 时 `reply` 返回 `SUPERVISOR_REQUEST_NOT_PENDING`，且仅当 `isRunRunningAndSteerable({runId,ownerGeneration,liveRunEpoch})` 为真才允许新 `steer`。它不把 `pending` 当 completion、terminal 或 lease authority；`status`/`pending` 只读。
- 状态机为 `pending → replying → replied`（native reply success 后 durable/in-memory receipt commit）或 `pending → expired|failed`；失败保持可诊断失败 receipt，只有明确 retry 且同一 reply idempotency key 可重入，不得自动 fallback steer。steer 为 `accepted → steered|failed|expired`；运行结束、generation/epoch 改变、RPC deadline 或发送失败均不得投递，返回明确 code/receipt。reply 成功后不自动 steer；只有新的、不同 `intentId` 且无 pending request 的指令可作为 steer。
- adapter/tool schema 传递 `requestId`、`intentId`、`ownerGeneration` 和 idempotency fields，且 native upstream 保持唯一实际 sender；RPC client 为 reply/steer 都透传 stable request id，extension 在调用 native `subagent_supervisor` 或 `rpc.steer` 前统一经 control-plane 决策。不得改变 upstream deep-import compat 边界、Root Broker authority、lease、workspace、outbox 或 completion receipt。
- UI 只显示 protocol outcome 的精简 projection，不能把 request、reply、steer、tool result 或 event 的 raw payload 改写给 agent；运行时 protocol 不读取 Skill。P6-T9 才能以已验收 public/model-visible 语义更新 Skill，且示例、测试记录、TUI 均不得记录 token、secret、credential、authorization、cookie、privateKey 或 raw payload。

**验收标准：** 同一个 child/user intent 至多发生一次实际 delivery，且 reply/steer 的路径选择、owner/generation fencing、expiry 和 idempotency 全由 production runtime contract 测试锁定。pending reply 优先且成功后没有等价 steer；无 pending reply、stale request/generation 或不可 steer child 均 fail closed。heartbeat/renew 和 progress stall 均不得自动触发 model turn 或调用任何 send/turn/reply/steer/resume/followUp/spawn 动作；heartbeat 只能按四项 identity 校验 CAS 更新三项 lease 字段，且不得产生 session/message/tool/async/completion 事件或改变 identity；progress stall 只更新 control-plane 状态并等待主 Agent 主动控制。replay、lease、completion exactly-once、TUI 原始消息和敏感信息边界不回归。

- [ ] **步骤 1：编写失败测试**：在四个既有根测试文件写入 schema/adapter、native membrane、RPC 和 integration 断言：request、intent、ownerGeneration、幂等 key、只读 pending、仅 progress stall 进入 stalled-suspected、普通长耗时 Bash/合法等待不 stalled、renew 不 spawn/new turn/session change；heartbeat/progress stall 禁止调用清单、仅三项 lease 字段、零 session/message/tool/async/completion 事件；`pending → replying → replied`、双投递、重复 reply、stale request/generation、steer-after-reply、无 pending reply、运行结束/不可 steer、stable request id 与失败不重发。不得新增测试文件。
- [ ] **步骤 2：运行 RED**：`node --test test/subagent-supervisor-adapter.test.mjs test/subagent-runtime-membrane.test.mjs test/subagent-dispatch-rpc.test.mjs test/pi-subagents-runtime.integration.mjs`；预期为新增控制协议 assertion failure，不接受 module-not-found。
- [ ] **步骤 3：实现最小 control-plane**：新增纯状态机及 canonical digest/idempotency/fencing parser；将 Supervisor ingress 注册为当前 generation 的 pending request，先由 `resolveSupervisorControl` 选择 reply 或 steer，再委托现有 native Supervisor target/RPC sender。仅提交成功 receipt 后推进 terminal 状态；对 timeout、transport error、expired/stale/mismatch 保存脱敏 code、identity 与时间，不自动转用另一种投递方式。
- [ ] **步骤 4：运行 GREEN**：同 RED 命令；确认双投递、重复 reply、stale request、stale generation、steer-after-reply、无 pending reply 均按 fail-closed/幂等契约通过，并确认测试没有将敏感字段或 TUI raw payload 写入 assertions/fixtures。
- [ ] **步骤 5：回归**：`npm run typecheck:subagents-enhanced && node --test test/subagent-supervisor-adapter.test.mjs test/subagent-runtime-membrane.test.mjs test/subagent-dispatch-rpc.test.mjs test/pi-subagents-runtime.integration.mjs test/subagent-delivery-recovery.test.mjs test/supervisor-replay.test.mjs test/root-subagent-rebind.test.mjs`；确认现有 reply UI projection、replay/rebind、completion exactly-once 和 Root Broker fencing 不变。

## P4：独立 orphan recovery 与 crash matrix

### Task P4-T7：串联 session continuation/crash recovery/authority expiry，验收 crash/restart

**Deps：** `P3-T6`（理由：消费 replay/rebind 后已验收的 reply/steer control-plane generation fencing 和单投递语义；orphan path 不得绕过该协议或借 completion/lease 隐含控制投递）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-orchestrator.ts`
- `test/subagent-orphan-recovery-crash.test.mjs`
- `test/subagent-orphan-recovery.integration.test.mjs`
- `test/recovery-resume-orchestrator.test.mjs`

**Resources：** two real Node processes, isolated session/durable roots, serial crash fixtures。

**Files：** Create：`test/subagent-orphan-recovery-crash.test.mjs`、`test/subagent-orphan-recovery.integration.test.mjs`。 Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-orchestrator.ts`、`test/recovery-resume-orchestrator.test.mjs`。 Test：三个列出的 recovery tests。

**接口契约：** 新 `recoverOrphanRun(input): Promise<{kind:"rebound",runId:string,ownerReceiptId:string}|{kind:"blocked-unknown",runId?:string,provenance:string}|{kind:"debt",runId?:string,debtId:string}>` 固定 `childStartTimeoutMs:120_000`；不改变 existing integration 15s constructor。P4 是最终安全组合 gate：P0 session content/provenance gate + P2 Root authority gate（OwnerReceipt、processBirth、ownerGeneration、generation/rebind、lease）+ workspace public receipt。顺序固定为：parse/assert RunAuthorization → apply P0 session eligibility → validate source/resumed/processIncarnation + OwnerReceipt/processBirth → Root Broker owner-generation/revision gate → public workspace service validation of `managed-workspace.v2` reference → read-only inventory match → Broker generation/revision CAS rebind → issue/rebind lease → ReplayCursor barrier → replay → processing ACK。authority expiry 只以 durable `expiresAt` 停止 heartbeat renew 并进入 `lease-expired`/recovery 分支，记录 `authority_lease_expired`，不伪造 terminal；主 Host crash 后停止 renew，subagent 在 durable `expiresAt` 到期后自行记录 `authority_lease_expired` 并退出；普通异步 Bash不阻塞 Node event loop，但同步阻塞 JS/第三方扩展不在保证边界内，不引入额外进程补偿。`continue` 只创建新 incarnation 并签发有限 10m lease。任何失败保存 provenance/现场并仅输出 `blocked-unknown|debt`。

**验收标准：** crash failure matrix 的**每一行**必须具有字段 `injectionPoint`、`initialFacts`、`expectedOutcome`、`retainedEvidence`、`forbiddenMutations`、`provenance`、`clockStrategy`、`processStrategy`：覆盖 resume 前、async-started 前后、Owner durable commit 前后、workspace validation 前后、inventory read、CAS 前后、lease commit 前后、barrier 前后、transport/processing ACK 前后。`processStrategy` 必须区分真实双 Node-process 边界与 fixture：PID birth mismatch 使用由受信 capture seam 控制的 fixture，显式模拟同 pid、不同 `processBirth`，但不声称操纵 OS PID；真实进程测试只证明跨进程 capture/rebind 边界。坏 session/asyncDir、PID reuse、old generation、CAS conflict、lease expiry、duplicate recovery 不得伪造 terminal/stopped/disposition；expiry 只报告 `authority_lease_expired`，正常 stop、`progress_stalled` 与 `explicit_stop` 分开记录。heartbeat/renew 在 crash/restart matrix 中仍只能校验四项 identity并 CAS 更新三项 lease 字段，不得调用任何 send/turn/reply/steer/resume/followUp/spawn，也不得新增 session/message/tool/async/completion 事件或改变 identity；progress stall 只更新 control-plane 状态并等待主 Agent 主动控制。P4 以测量提出新 policy version，不能改变 V1 含义。

- [ ] **步骤 1：先 Create 失败测试**：创建 `test/subagent-orphan-recovery-crash.test.mjs`、`test/subagent-orphan-recovery.integration.test.mjs`，并在既有 `test/recovery-resume-orchestrator.test.mjs` 增加断言；以真实双进程覆盖每个 crash injection point、eligible/non-eligible session、timeout split、fencing、仅 `expiresAt` 的 expiry、主 Host crash 停止 renew、child event loop blocked、subagent 到期自退出、duplicate 和 matrix 全字段 retained evidence。另以受信 capture seam fixture 覆盖同 pid/different-processBirth mismatch，且明确 fixture 不模拟真实 OS PID reuse；断言 heartbeat/renew 的禁止调用清单、仅三项 lease CAS 更新、零 session/message/tool/async/completion 事件、三项 identity 不变，以及 progress stall 不自动 turn。
- [ ] **步骤 2：运行 RED**：`node --test test/subagent-orphan-recovery-crash.test.mjs test/subagent-orphan-recovery.integration.test.mjs test/recovery-resume-orchestrator.test.mjs`；预期为新增 recovery assertion failure，不接受 module-not-found。
- [ ] **步骤 3：实现最小 orphan path**：只调用已冻结 public contracts；现有 integration `rpc.resume → registerAuthorizedRun → activateResume` 行为与 15s 默认不变。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：全回归**：`node --test test/recovery-resume-contract.test.mjs test/recovery-resume-orchestrator.test.mjs test/root-subagent-broker.test.mjs test/subagent-delivery-recovery.test.mjs test/subagent-orphan-recovery-crash.test.mjs test/subagent-orphan-recovery.integration.test.mjs`。

## P5：先冻结 scheduler public outcome，再接入真实路径

### Task P5-T8：冻结 scheduler typed outcome 并接入既有 adapter/extension

**Deps：** `P4-T7`（消费已实现、已验收的 orphan public outcome）

**WritePaths：**
- `src/task-scheduler/adapter.ts`
- `pi/extensions/task-scheduler.ts`
- `test/task-scheduler-adapter.test.mjs`
- `test/task-scheduler-package-isolation.test.mjs`
- `test/task-scheduler-runtime.integration.mjs`

**Resources：** one scheduler runtime fixture。

**Files：** Create：none。 Modify：`src/task-scheduler/adapter.ts`、`pi/extensions/task-scheduler.ts`、三个既有 scheduler tests。 Test：`test/task-scheduler-adapter.test.mjs`、`test/task-scheduler-package-isolation.test.mjs`、`test/task-scheduler-runtime.integration.mjs`。

**接口契约：** 第一步在 existing adapter 冻结真正 public typed union `SchedulerRecoveryOutcome = {kind:"rebound",runId,...}|{kind:"blocked-unknown",runId,provenance,...}|{kind:"debt",runId,debtId,...}` 和 `consumeRecoveryOutcome(outcome)`；仅在此测试通过后，extension 将 P4 的真实 `recoverOrphanRun` outcome 注入该入口。不得引用不存在的 trigger/cancel/recover API，也不得读取 private durable root。

**验收标准：** 三个 scheduler tests 均覆盖 union、重复 run 去重、terminal/blocked-unknown 不自动重启、membrane/session epoch/shutdown 不回归；workspace mutation 仍只走 public service。

- [ ] **步骤 1：编写失败测试**：只在三个现有根 scheduler tests 冻结 public union、duplicate、terminal 和 blocked-unknown；禁止使用 fake 未定义 scheduler recovery API 或新增测试文件。
- [ ] **步骤 2：运行 RED**：`node --test test/task-scheduler-adapter.test.mjs test/task-scheduler-package-isolation.test.mjs test/task-scheduler-runtime.integration.mjs`；预期为新 union/行为的具体 assertion failure，不接受 module-not-found。
- [ ] **步骤 3：实现 outcome surface 后接入真实路径**：先最小 typed adapter，再在 extension 注入 P4 已有 outcome；不暴露 registry internals。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：最终边界验证**：`npm run typecheck:subagents-enhanced && npm --prefix packages/pi-subagents-enhanced test && node --test test/recovery-resume-orchestrator.test.mjs test/task-scheduler-adapter.test.mjs test/task-scheduler-package-isolation.test.mjs test/task-scheduler-runtime.integration.mjs`。

## P6：生命周期验收后的独立 dispatch Skill 同步

### Task P6-T9：以已验收 runtime 行为更新 `subagent-dispatch` Skill

**Deps：** `P3-T6`（理由：消费已验收的 reply/steer 单投递 public/model-visible 语义，Skill 不得提前定义或修改该协议）；`P4-T7`（理由：消费 crash/restart、orphan、lease expiry 与 completion replay 的已验收真实行为）；`P5-T8`（理由：消费 scheduler 已接入的 typed lifecycle outcome）；以及 P0–P5 的完整 runtime/control-plane 测试均通过。此任务是生命周期实现完成后的**独立后置变更**，不得提前执行，也不得把 Skill 更新视为 P0–P5 的隐含步骤。

**WritePaths：**
- `skill-overrides/subagent-dispatch/SKILL.md`
- `test/subagent-dispatch-skill.test.mjs`

**Resources：** fresh-context Skill pressure scenarios 串行执行；不得将测试场景的 TUI 文本或 raw runtime payload 写入 Skill。

**Files：** Modify：`skill-overrides/subagent-dispatch/SKILL.md`、`test/subagent-dispatch-skill.test.mjs`。 Create：none。 Test/validation：`test/subagent-dispatch-skill.test.mjs`、`test/pi-subagents-runtime.integration.mjs`、`test/pi-subagents-enhanced-package.test.mjs`。

**接口契约：**
- Consumes：P3-T6 的 reply/steer 单投递决策、pending 优先、generation fencing、无 pending reply fail-closed 与 terminal receipt 语义，P4 的 `recoverOrphanRun` 已验收 outcome、P5 的 `SchedulerRecoveryOutcome` 消费边界、Root Broker owner/rebind/revoke/lease authority、durable replay 的三层 receipt 与现有 runtime/Skill 测试事实；只描述已经实现并经测试证明的 public/model-visible 语义。
- Produces：准确的 dispatch 文案与 Skill regression assertions；不新增 runtime API、权限、持久化格式、scheduler 行为或 TUI renderer 行为。
- 必须明确模型可见的 lifecycle/completion/reconnect/orphan/lease/control 语义：主会话正常关闭遵循既有 close/stop-drain，不承诺 detached child 继续执行；`detached` 或 `stop` 只按 runtime 实际 terminal/disposition 语义描述，不能将 lease expiry 表述为 stopped、terminal 或 workspace disposition；resume/rebind 是带 source/resumed identity、process birth、owner generation/revision CAS 和授权验证的新 incarnation/fenced rebind，不是原 OS process 的复活；对正在等待且 identity/generation 匹配的 Supervisor request 使用 reply，只有无 pending request 且 child 仍运行并可 steer 时才使用 steer，同一意图绝不 reply 后等价 steer，reply 成功不自动 steer，缺 pending/stale request/stale generation 只按 runtime fail-closed outcome 描述；completion replay 是 durable at-least-once transport/processing 与 `runId + terminalReceiptId` 用户可见 exactly-once 的区分；limited、lease expiry 或无法证明的现场只可见为受限、`authority_lease_expired`、`blocked-unknown` 或 `debt`，不得承诺自动重启、自动 settlement、自动 workspace mutation 或无条件恢复。
- 删除一切与实际 runtime 不符的承诺，尤其是从 prompt、profile、frontmatter、名称、模型或 started event 推导 authority，或把 completion/status 当作 terminal proof。持续保留敏感信息边界（不得在 Skill、示例或测试记录 token、secret、credential、authorization、cookie、privateKey 或 raw payload）和 TUI 边界（展示精简只能在 renderer，不能改写 agent 实收的原始 message、tool result、event/session payload 或 structured details）。

**验收标准：** 只有 P4/P5 和完整生命周期 runtime 测试通过后才更新 Skill。实现者先完整读取并遵循 `skill-overrides/writing-skills/SKILL.md`，按其 RED-GREEN-REFACTOR 对现有 Skill 运行 fresh-context baseline、记录实际失败/合理化、最小更新 Skill、再以相同 pressure scenarios 验证；不以 prose 或人工阅读替代。`test/subagent-dispatch-skill.test.mjs` 锁定实际 ABI、可执行示例及上述 lifecycle 禁止承诺；现有 Skill 验证命令、完整 runtime/Skill tests、typecheck 和 package verification 全部通过。

- [ ] **步骤 1：编写失败的 Skill/runtime 对齐测试与 pressure scenarios**：在 `test/subagent-dispatch-skill.test.mjs` 增加对已验收 lifecycle/control 文案、真实 ABI、pending 优先 reply、无 pending 禁止 reply、reply 后禁止等价 steer、generation fencing、completion terminal-proof 边界、lease expiry、resume/rebind、敏感信息和 TUI raw-payload 禁止承诺的断言；依照 `writing-skills` 在无 Skill 的 fresh context 运行相同场景，逐字保存 baseline failure/rationalization 的脱敏摘要。
- [ ] **步骤 2：运行 RED**：`node --test test/subagent-dispatch-skill.test.mjs`；预期新增断言在旧 Skill 上失败，且 baseline 明确显示需要补齐的实际行为。
- [ ] **步骤 3：最小更新 Skill**：仅修改 `skill-overrides/subagent-dispatch/SKILL.md`，把经 P3/P4/P5 验收的 reply/steer control、lifecycle/completion/reconnect/orphan/lease 模型可见语义写为可执行指引；删除过时或不真实承诺，不改变敏感信息与 TUI raw-payload 边界，不引入未实现 API。
- [ ] **步骤 4：运行 GREEN 与 fresh-context 验证**：`node --test test/subagent-dispatch-skill.test.mjs`，并以 `writing-skills` 要求的同一 fresh-context pressure scenarios 验证更新后的 Skill；逐项人工核查被标记命中，确认无 Skill 文本回显导致的假阳性。
- [ ] **步骤 5：完整 runtime/Skill 验收**：`npm run typecheck && npm --prefix packages/pi-subagents-enhanced run verify:package && npm test && npm run test:subagents && npm run test:subagents-enhanced`；所有命令通过才可宣告 P6 完成。不得提交。

## 执行前自检（本次已修订）

- [x] **占位扫描：**已执行危险占位词扫描且无匹配；“待审批”是 P1 明确决策门，不是实现占位。
- [x] **事实门禁：**OwnerReceipt、generation/create/rebind/revoke、lease、journal/outbox/barrier、scheduler outcome 和 120s path 均标为新 API；旧 `registerAuthorizedRun(): Promise<void>`、10s client、15s integration 和 workspace runtime receipt 已区分。
- [x] **DAG/Deps/Waves：**P0-T1 完成后必须先经过 P0-T1-GATE；gate 在官方 `rpc.resume` 前只校验 session content/provenance：合法 header、canonical sessionFile、status/result/recovery descriptor、sourceRunId、sessionId、agentProfile/cwd 及字段身份一致性。`SessionManager.open` 只读且接受 mismatch，不能证明资格。合法 header+torn-tail 仅记为官方 repair；mismatch、无 header、不可解析或身份不一致均 `blocked-unknown` 且 `resumeCallCount === 0`。P0 通过后仅标为 `feasibility-proven / eligible-for-P1`，不代表安全 orphan recovery；Root authority gate 移至 P2-T3，P4 最终组合 P0 session gate、P2 OwnerReceipt/processBirth/generation/lease 与 workspace public receipt。P2-T3/P2-T4 是 WritePaths 不重叠的并行分支，并在 P3-T5 汇合；P3-T6、P4-T7、P5-T8 依次消费明确产物。P6-T9 是当前 P0–P5 批次外、另获授权的独立后置任务，不进入关键路径或执行 Waves；Pi 0.86.0 已移出当前图和批次。
- [x] **路径自检：**P0 只写 `/tmp`；并行 P2-T3/P2-T4 WritePaths 不重叠；所有不存在的新测试文件均在对应 Files.Create 明确列出，且统一使用真实根 `test/`；package test 仅运行 manifest 的 package/packaging 边界，typecheck 单独执行。
- [x] **P3-T6/P6 路径/边界自检：**P3-T6 的 production WritePaths 对应当前 `supervisor-adapter.ts`、`extension.ts`、`rpc-client.ts`、native runtime membrane 和现有 supervisor/RPC/integration tests；其新增 state machine 与 reply/steer dispatch 只在 runtime control-plane 执行。P6-T9 WritePaths 只含 `skill-overrides/subagent-dispatch/SKILL.md` 与对应 `test/subagent-dispatch-skill.test.mjs`；当前只修订本计划，未修改 Skill。P6 的 tests/validation 明确覆盖现有 Skill 验证、完整 runtime/Skill tests、typecheck 与 package verification，且不放宽敏感信息或 TUI raw-payload 边界。
- [x] **占位扫描：**已复查新增 P6 不含危险占位词、未来再实现承诺、泛化填充语、未定义的验证命令或未指定路径；`blocked-unknown`、`debt` 与 `authority_lease_expired` 均为已在上游任务定义的模型 outcome，不是占位。
- [x] **authority/compat 自检：**journal 仅 reference；workspace 仅 public service；upstream deep import 集中 compat；payload UTF-8 和 broker overhead 已定义；authority expiry 只读 durable `expiresAt`，renew 属于主 Host/runner control plane，subagent timer 仅按已过期 lease 自行退出，绝不依赖 child event loop 或作 progress 判断。
- [x] **heartbeat/no-turn 自检：**全局约束及 P2-T3/P3-T6/P4-T7 已明确纯 control-plane renew、禁止 send/turn/reply/steer/resume/followUp/spawn、四项 identity 校验、三项 lease CAS 更新、零 session/message/tool/async/completion side effect、progress stall 仅状态更新并等待主 Agent；对应 RED/GREEN 门禁已写入任务步骤。
- [x] **提交边界：**没有 `git add`、`git commit` 或提交步骤。

## 修订摘要

本次把 heartbeat authority lease、progress stall detector 与 stalled-suspected 通知语义明确分离：authority 只由 durable `expiresAt` 判定，删除连续丢失/missed-heartbeat counter；冻结 running/stalled-suspected/stopping/terminal/lease-expired 状态与 60s heartbeat lease、15s renew、两进程 timer、20m progress stall、10m continue lease 的受信 Host policy 初值。heartbeat/lease renew 明确为纯 control-plane：仅校验 `runId`/`ownerGeneration`/`processIncarnationId`/`sessionFile` 并 CAS 更新 `lastRenewedAt`/`expiresAt`/`renewalSequence`，禁止任何 model turn、send/reply/steer/resume/followUp/spawn 或 session/message/tool/async/completion side effect；progress stall 同样只更新 control-plane 状态并等待主 Agent 主动控制。progress stall 不是总执行超时；active 异步 Bash、合法 Supervisor 等待和正常 provider/tool I/O 不计入 stall。stalled-suspected 仅通知主 Agent并继续 heartbeat renew，直到显式 reply/steer/continue/stop、terminal 或 authority lease expiry，不设 decision grace 硬期限。严格两进程模型中，主 Host/runner control plane 负责 renew，subagent 自身 timer/运行时在 durable `expiresAt` 到期时记录 `authority_lease_expired` 并退出；同步阻塞 JS/第三方扩展属于不保证边界，不引入额外进程补偿。正常 stop、`authority_lease_expired`、`progress_stalled`、`explicit_stop` 分开记录。heartbeat renew 不开新 turn、不 spawn、不改变 session，pending request 只能 reply、无 pending 才 steer，reply 后禁止等价 steer，continue 只能签发有限新 lease。后续仍可按 policy version 调整，且不把参数作为模型输入。

本次新增 P0-T1-GATE 作为 P0 收尾/P1 前置：明确 `SessionManager.open` 会接受 header identity mismatch，只能只读读取，不能作为恢复资格证明；官方 `rpc.resume` 前只校验 session content/provenance eligibility：合法 header、canonical sessionFile、status/result/recovery descriptor、sourceRunId、sessionId、agentProfile/cwd 及身份一致性。P0 不要求 OwnerReceipt、ownerGeneration 或 processBirth；Root authority gate 移至 P2。合法 header+torn tail 可由官方 repair，mismatch、无 header、不可解析或身份不一致均 `blocked-unknown` 且不得调用 resume；gate 使用 `/tmp` provenance fixtures、RED/GREEN/回归命令，明确不修改 SessionManager。P0 通过后标为 `feasibility-proven / eligible-for-P1`，不代表安全 orphan recovery；P4 再组合 P0 gate、P2 OwnerReceipt/processBirth/generation/lease 与 workspace public receipt。

本次将 P0 报告中不存在的能力全部明确为待新建 authority contract：P2-T3 先在任务内冻结并实现 OwnerReceipt/generation/rebind/revoke/lease，保持旧 `registerAuthorizedRun(): Promise<void>`、通用 client 10s 与 integration 15s；新 RPC 才使用专用 5s deadline。P1 仅定义纯 policy/contract 和可注入 clock，不创建真实 timer/storage/broker；P2/P4 才实现 renew、expiry 与 recovery。P2-T3/P2-T4 作为无重叠 WritePaths 的并行分支，在 P3-T5 汇合；P6-T9 是当前 P0–P5 批次外的独立后置任务。P0 报告现按 A–F 核心、G 三层 fail-closed 和三项损坏输入分层：合法 header+torn tail 明确记录为 SessionManager 官方 repair 而非 fallback；无合法 header、header identity mismatch、完全不可解析 JSON 任一未验证，或 all-invalid fixture unexpected-success，均保持 `blocked-unknown` 并阻断 P1。P0 仍收束至 `/tmp` 的真实 public `SessionManager.open` import + typed `rpc.resume` 验证，native child 无法启动时严格以 `blocked-unknown` 结束。计划还统一 identity mapping、workspace public receipt provenance、durable `progress_stalled` 边界、P4 crash failure matrix/PID-birth fixture 边界、根 `test/` 路径和可复现的具体-assertion RED 门禁；持续保留敏感信息和 TUI raw-payload 边界。
