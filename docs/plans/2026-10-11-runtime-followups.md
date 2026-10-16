# Runtime 后续问题与体验改进执行计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 跟踪。执行方式由计划完成后的用户选择决定。调查任务先于修复任务；未满足数据来源分类门禁时，不得修改 production。

**执行状态（2026-10-11）：**用户选择 Inline，已产出静态调用链、覆盖边界和暂缓决策。初次 T0 未及时停止且路径分类不足；用户确认清理后已重建 schema v2 文档基线。当前仅收口调查文档，未完成生产 provenance、selector/epoch 完整合同或行为验证；五项 TODO 均未实施。checkbox 只表示其文字步骤实际完成，不表示问题已修复；缺少直接证据的步骤保持未勾选。最新用户决策为“文档化并推送，先不做实际代码改动”。

**再审状态（2026-10-13）：**用户已要求重新审核并补齐后续计划；本轮授权阅读、审查和计划修订，不自动实施。上段“最新用户决策”仅描述 2026-10-11 历史阶段。以下 T0–T11 作为历史调查账本保留，不重跑已完成步骤、不覆盖 schema v2 基线或历史 acceptance；尚未闭合的工作按文末增量入口另行形成实施合同。暂缓、关闭和未授权不等于永久不可实现。

**新批次入口：** `docs/plans/2026-10-13-remaining-runtime-execution.md`。用户后续已要求实际可见系统通知、隔离测试主 Host 派发 child 后 SIGKILL 的 heartbeat 验收，以及本仓受控入口 session 独占；不修改上游。本文的禁止新增 case/真实实验/通知等条款只描述历史调查，不覆盖新计划限定的 I4/H2 验收。任何真实用户进程、任务和权限设置仍不在授权范围；不得把新授权改写到历史验收中。

**目标：** 对 RPC session 协商失败、supervisor 回复消费视图、heartbeat 孤儿清理、纯派发回执唤醒和主会话空闲通知五项后续事项完成非敏感 provenance，形成可审查的产品/技术决策，并仅在生产事实与用户授权同时满足时实施最小改动。

**架构：** 先以唯一 public 入口、权威身份、事件/进程顺序和首个偏离为证据，分别完成五条独立调查；调查不能证明 production 可达时保持 fail-closed，不增加兼容分支。确认可修复且 owner 明确后，沿现有 dispatch、supervisor、child lifecycle 和 Host event 边界实施最小修改，不创建第二 authority、第二 sender、私有 IPC、轮询或自动恢复框架。

**技术栈：** Pi Coding Agent `1.0.4`；`pi-subagents` `0.75.0`；Node.js `>=22.19.0`；仓库现有 TypeScript、Node test、Pi 公开 Extension API、现有 subagent RPC/supervisor/workspace 合同；macOS 系统通知仅在明确授权后通过 `/usr/bin/osascript` 使用。

## 全局约束

- 计划执行前须先冻结当前工作区、HEAD、index 和本计划涉及路径；不得覆盖既有 dirty，不得执行 `reset`、`restore`、`stash`、force push 或 raw managed-worktree 操作。
- 本计划默认不提交、不 push；提交必须取得单独明确授权，并使用 `git-commit-convention` skill。
- Node 最低版本固定为 `>=22.19.0`；不因本计划要求 Node 26，也不安装或升级依赖。
- 历史调查阶段默认禁止 TDD 及所有 TDD 类 skill；不写 RED 测试、不新增 test case，只同步确有影响的既有断言/fixture，并运行获准的纯测试或静态检查。此限制不借用为未来功能缺少验证的理由；后续实施计划须单独声明实现后新增的展示/生命周期/投递合同验证范围，仍不使用 TDD。
- 不运行真实 Pi Host、真实 RPC/PTY、真实 provider/model 请求、真实业务 child、真实 MCP、初始化脚本、完整 integration、付费 canary 或危险 parent-SIGKILL 实验；合成 fixture、fake API、静态源码和非敏感 metadata 可用。
- 不读取、复制、hash 或输出真实 `pi/settings.json`、`pi/models.json`、`pi/auth.json`、凭据、完整 session 正文、authority 内容或用户目录宽扫描结果。需要诊断时只请求字段级非敏感投影。
- 外部工具不得通过 MCP 接入；不修改 `node_modules`、上游依赖或生成 vendor Host。若根因只存在于上游，形成明确 upstream boundary 记录并停止本仓 production 修复。
- 所有生产实现放在所属 `src/<feature>/` 或 `packages/<name>/src/`；`pi/extensions/` 只做 Host 绑定；不得从 production 反向 import `scripts/**` 或 `pi/extensions/**` 实现。
- 所有面向用户的截断、摘要和显示投影仅在 renderer 层；不得改写 raw message、tool result、event、session、`details`、`structuredContent` 或权限事实来改善 TUI。
- 不新增 model fallback、自动换模、自动 resume、自动结束 child、第二 completion sender、第二 supervisor authority、私有 broker、lease 或 scheduler。已有 `resume` 只按主管决策规则使用，不变成 runtime 自动重试。
- 发现异常必须先执行数据来源分类门禁：合法 public/typed 入口产生的有效 production 数据按生产缺陷处理；手工 projection、非法时间、缺字段 mock 和过期 fixture 只修测试；来源未证实时 fail closed、保留现场、补 provenance，不加预防性兼容。
- supervisor 的 `queued`、`consumed`、`delivered`、上游 pending 和本仓 durable gate 必须分别表述；不得把提交回执或 UI 快照冒充 child 已收到/消费。
- TUI-only 方案不得通过 `sendMessage`、`appendEntry` 或改写模型上下文实现；系统通知失败不得影响 agent 或 child 生命周期。
- 每项任务都必须保留真实命令 exit、日志路径和范围说明；命令输出不得用管道掩盖失败。日志只写任务专属 `/tmp/pi-runtime-followups-<task>-<nonce>/`，不纳入 Git，任务结束清理非必要临时文件；日志不得含凭据、session 正文或 authority 内容。资源竞争通过 `Resources` 声明，不把容量限制伪装成 DAG 依赖。
- T0 的本计划文件是执行前已知的计划输入，不因其在执行前为 untracked 而触发“未知 dirty”停止；其它新 dirty 路径仍必须停止。`statusPaths` 只保存仓库相对的非敏感路径或脱敏分类，敏感候选只保存 `sensitivePathPresent:true`，不保存原名。`generatedAt` 仅为观测时间，不作为可重放内容；可重放性由 HEAD、index、脱敏路径集合和版本字段定义。
- 执行前已存在的 `docs/plans/2026-10-11-playwright-sdk-migration.md`（如仍在 status 中）是受保护的无关 dirty 现场，只记录其存在，不读取正文、不修改、不纳入本计划 WritePaths；本计划文件与该现场均不触发未知 dirty 停止。

## DAG

```text
T0 执行前基线与证据门禁
 ├──> T1 RPC session provenance ───────> T6 RPC 修复资格/关闭
 ├──> T2 supervisor 视图 provenance ──> T7 supervisor 合同决策/关闭
 ├──> T3 heartbeat/orphan provenance ──> T8 lifecycle 边界/关闭
 ├──> T4 派发回执 triggerTurn 合同 ──> T9 选择性 triggerTurn 决策/关闭
 └──> T5 idle 通知生命周期合同 ───────> T10 空闲通知决策/关闭

T6、T7、T8、T9、T10 ──> T11 聚焦验收与账本收口
```

依赖理由：

- `T0 → T1/T2/T3/T4/T5`：所有调查必须引用同一工作区基线、同一版本事实和同一敏感信息边界，避免把不同现场混为一谈。
- `T1 → T6`：只有 RPC 的 public 入口、首个偏离和数据来源分类完成后，才能决定是否改 session/cwd/能力断言。
- `T2 → T7`：只有明确上游 pending、本仓 durable gate 和 child consumption 的产品合同后，才能判断是文案、观测、对账还是控制面缺陷。
- `T3 → T8`：只有确认 heartbeat、ACK、lease、runner 和后代进程的合法 production 顺序后，才能决定本仓是否有 owner；不能凭静态可能性添加清理 fallback。
- `T4 → T9`：triggerTurn 选择器必须先有精确 receipt 形态和保留消息语义，才能修改投递 options。
- `T5 → T10`：空闲通知必须先证明主会话登记表、settled 边沿和 status 查询覆盖，再决定是否进入后续实现计划；heartbeat 的完整覆盖不是该通知的硬依赖。
- `T4 → T9`：历史 T9 只消费 T4 已证明的 sender/字段 owner；当时未证明合法 options 接点或只能识别标题时暂缓实现。sender 在上游并不证明本仓所有 options 接点不可行，后续应增量核实，不写 TUI observer 代替 sender。
- `T5 → T10`：历史 T10 只消费 T5 已证明的登记 owner、session epoch 和 status projection；缺任一项则暂缓。缺少现成 registry 是后续设计输入，不是永久关闭条件，不实现半套通知。
- `T3/T4/T5/T8/T9/T10` 不直接修改共享 TODO 账本，统一由 T11 单一 writer 收口；资源互斥不替代 DAG 依赖。
- `T6–T10 → T11`：最终验收必须同时核对已实施项、明确关闭项、未实施项、日志和限制，避免把调查完成误报为修复完成。

## Waves

- **Wave 0：**`T0`。
- **Wave 1：**`T1`、`T2`、`T3`、`T4`、`T5` 可并行；它们分别写各自 provenance/decision 文件，不写共享 TODO 账本。
- **Wave 2：**`T6`、`T7`、`T8` 在各自前置证据满足后可并行；`T9` 必须等待 T4，`T10` 必须等待 T5；若 owner 不在本仓，二者只交付关闭决策，不修改 production。
- **Wave 3：**`T11` 作为唯一 TODO 账本 writer，执行聚焦验收与账本收口。

**关键路径：**`T0 → T1/T2/T3/T4/T5 → 对应 provenance 与资格/关闭决策 → T11`。RPC 和 supervisor 是优先人工审阅路径；heartbeat、triggerTurn、idle notification 不因建议排序而制造非必要代码依赖。

**共享资源：**`unit-runner` 容量为 1，统一覆盖 root/enhanced `tsc` 和获准 Node 单测；`static-evidence` 可与不写同一文件的调查并行；`rpc-owner-write`、`supervisor-owner-write`、`dispatch-owner-write`、`notification-owner-write` 分别为互斥资源；macOS `osascript` 资源默认禁用，只有 T10 获得用户明确授权后才启用。任何任务需要真实 Host、真实 RPC、模型或危险进程实验时必须停止并请求新的授权。

---

## T0：执行前基线与证据门禁

**Deps：**`none`

**WritePaths：**
- `docs/plans/records/2026-10-11-runtime-followups/baseline.json`

**Resources：**`static-evidence`；不占用 `unit-runner`

**Files：**
- Create：`docs/plans/records/2026-10-11-runtime-followups/baseline.json`
- Read：当前 `git status --short`、当前 HEAD/index、`docs/todos/2026-10-10-runtime-followups.md`、五项问题/决策记录和本计划

**接口契约：**
- Consumes：当前工作区 status、HEAD、index、Node/Pi/`pi-subagents` 版本和五项记录中的非敏感事实。
- Produces：JSON 基线，至少包含 `schema`、`generatedAt`（仅观测时间）、`head`、`indexEmpty`、脱敏后的 `statusPaths`、`nodeVersion`、`piVersion`、`subagentsVersion`、`sensitivePathsRead:false`；敏感候选只记录 `sensitivePathPresent:true`，不保存原名，不保存文件正文、凭据、session、authority 或用户目录内容。

**验收标准：**基线可重放当前范围；index 为空或现状被明确记录；本计划所有后续 WritePaths 可追溯；未产生 production 改动。

- [x] **步骤 1：**只读冻结 status、HEAD、index 和包根 metadata；对敏感路径只记录未读取布尔值。
- [x] **步骤 2：**用一次性 Python/Node 脚本生成上述 JSON，脚本只读取精确白名单，不使用 `find /`、`find ..` 或用户目录宽扫。
- [x] **步骤 3：**读取生成 JSON、执行 `git diff --check`，保存真实 exit；若出现未知 dirty 路径、非空 index 或版本与计划矛盾，停止并请求决定。

**停止条件：**需要读取真实配置/会话才能继续；发现本计划 WritePaths 已被其他任务修改；发现有凭据或 authority 内容进入候选输出。

---

## T1：RPC `rpc:v1/session` provenance 与最小修复决策

**Deps：**`T0`（消费同一基线和敏感字段门禁）

**WritePaths：**
- `docs/plans/records/2026-10-11-runtime-followups/rpc-provenance.json`
- `docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`

**Resources：**`static-evidence`；禁止真实 RPC/Host/provider/model

**Files：**
- Create：`docs/plans/records/2026-10-11-runtime-followups/rpc-provenance.json`
- Modify：`docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`，只写 provenance 摘要、来源分类和后续资格，不改变历史事实。
- Read：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts`、现有非敏感 M00 task-before 对照和 `test/joint-upgrade-rpc-wire.test.mjs`

**接口契约：**
- Consumes：用户提供的错误 code/stage/missing capability、可获得的字段级启动 metadata、T0 基线和现有静态调用链。
- Produces：`rpc-provenance.json`，包含 `sourceClass`（`production`/`test`/`unconfirmed`）、`evidenceMode`（`static`/`field-projection`）、`firstDivergence`、`entryPoint`、`identityFacts`、`eventOrder`、`versionFacts`、`ownerComponent`、`ownerPath`、`ownerScope`、`candidateDecision`、`sensitiveDataRead:false`；不保存 prompt、完整 session 或 credentials。

**验收标准：**明确错误是否来自合法 production 入口；区分 session context 未就绪、cwd/originRoot 不一致、旧 Host/资源世代或来源未证实；若不能证明 production 可达，结果必须是 `unconfirmed` 并保持 fail-closed。不得仅凭单标签 `rpc:v1/session` 断言单一失败条件。

- [x] **步骤 1：**用已有错误字段和精确源码链定位 `typed execute → admission → rpc.ping → assertSpawnCapabilities`，记录每个断言条件及所需非敏感事实。
- [x] **步骤 2：**对实际可得字段做来源分类，核对主 cwd、Git root、worktree 标志、Host/Pi 版本和 session identity；缺失字段不得用推测填充。
- [x] **步骤 3：**将首个偏离、候选根因、无法证明的部分和“不修改/最小修复”决策写入对应 bug 文档与 JSON；运行 JSON 语法检查，不运行真实 RPC。

**停止条件：**只能通过读取完整 session、authority、settings/auth/models 或启动真实 Host 才能区分候选；来源仍未证实却要求加 fallback；发现根因 owner 不在本仓公开代码边界。

---

## T2：supervisor reply/pending/steer 视图 provenance 与合同决策

**Deps：**`T0`

**WritePaths：**
- `docs/plans/records/2026-10-11-runtime-followups/supervisor-provenance.json`
- `docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`

**Resources：**`static-evidence`；禁止真实 supervisor/RPC/child

**Files：**
- Create：`docs/plans/records/2026-10-11-runtime-followups/supervisor-provenance.json`
- Modify：`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`，只写 provenance 摘要、状态映射和后续资格，不改变历史事实。
- Read：`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`、`supervisor-consumption.ts`、`supervisor-adapter.ts`、`test/subagent-supervisor-adapter.test.mjs`、`test/supervisor-consumption.test.mjs`、`test/supervisor-replay.test.mjs`、`test/joint-upgrade-contact-supervisor.integration.mjs`

**接口契约：**
- Consumes：实际 request/reply/steer 的非敏感 `runId/requestId/index/timestamp/deliveryStatus` 投影（若用户提供）、T0 基线和现有 public 调用链。
- Produces：记录上游 pending、本仓 durable pending、queued、consumed、delivered 和 gate 状态的对应关系；JSON 字段至少包含 `sourceClass`、`evidenceMode`、`firstDivergence`、`authority`、`ownerComponent`、`ownerPath`、`ownerScope`、`requestOrder`、`consumptionEvidence`、`contractDecision`。

**验收标准：**明确 `SUPERVISOR_REPLY_REQUIRED` 是正常 fail-closed 还是已被权威消费事实证明为生产缺陷；不把 `pending` 空、reply 提交成功、attention 延迟或 queued 回执当作消费证据。产品合同必须明确“提交”“投递”“消费确认”“允许 steer”四个状态。

- [x] **步骤 1：**按代码实际调用顺序画出 request 登记、reply 提交、`commitDelivery`、child session consumption、终局对账和 steer gate。
- [x] **步骤 2：**对存疑 NOT_PENDING 样本只核对精确 `replyTo` 与登记/调用时间，不读取完整 session；错 ID、时序 race、来源未证实分别分类。
- [x] **步骤 3：**写明是否只改错误文案/状态投影、是否需要 durable contract 修复，或保持控制面不变；用静态/JSON 检查保留真实 exit。

**停止条件：**需要绕过 supervisor gate、盲目 steer/resume/interrupt、创建第二 authority、增加 polling 或无法取得权威消费事实；产品合同仍无法在现有状态模型中表达。

---

## T3：heartbeat 与主进程意外退出后的孤儿清理 provenance

**Deps：**`T0`

**WritePaths：**
- `docs/bugs/2026-10-11-heartbeat-orphan-cleanup-provenance.md`

**Resources：**`static-evidence`；禁止 SIGKILL/危险进程实验

**Files：**
- Create：`docs/bugs/2026-10-11-heartbeat-orphan-cleanup-provenance.md`
- Read：`/tmp/pi-heartbeat-parent-death-orphan-cleanup-current.md`（静态报告，未做 parent-SIGKILL 实验）、公开本仓 child launch/lease/broker 代码和不含敏感正文的测试合同

**接口契约：**
- Consumes：主进程、broker、lease、ACK、runner、child 和独立 bash 后代的公开启动顺序与 owner 关系。
- Produces：一份 source classification 和清理覆盖矩阵，行键为 `managed/coding/generic/binding-failed/runner-child/bash-descendant`，列至少为 `birth/ack/renewal/parent-loss/termination/escalation/descendant-reaping/owner`；每行区分 `sourceClass=production|test|unconfirmed` 与 `evidenceMode=static|field-projection|isolated-runtime`，不能把 static 混作数据来源类别，静态报告默认不得升级为现场 production proof。

**验收标准：**分别证明已覆盖路径与缺口；说明 `45–65s` 静态估计的前提；不把 generic、绑定失败或独立 bash 后代的缺口写成已修复；明确本仓 owner、上游 owner 或来源未证实。不得通过真实 kill 实验补证。

- [x] **步骤 1：**对每类 child 逐条记录 public launch、身份绑定、ACK、lease/heartbeat、runner 终止和后代清理的事件顺序。
- [x] **步骤 2：**按数据来源门禁判断静态报告是 production 可达、测试制造还是未证实；缺少真实入口事实时保持 `unconfirmed`。
- [x] **步骤 3：**将矩阵和最小下一步写入 bug 文档；TODO 账本由 T11 统一更新，不在本任务写共享文件；不扩大 broker 或 child lifecycle。

**停止条件：**需要启动真实 child、发送 SIGKILL、修改 node_modules、构造第二 heartbeat authority 或以测试中的人工 process mock 宣称 production 可达。

---

## T4：纯派发回执 `triggerTurn` 精确合同与选择器

**Deps：**`T0`

**WritePaths：**
- `docs/decisions/2026-10-11-dispatch-receipt-trigger-turn.md`

**Resources：**`static-evidence`；不占用 unit-runner，禁止真实派发

**Files：**
- Create：`docs/decisions/2026-10-11-dispatch-receipt-trigger-turn.md`
- Read：现有 subagent dispatch tool、`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/notify.js`、`packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts`、`packages/pi-subagents-enhanced/src/tui/completion-notices.ts` 和已保存的 `/tmp/pi-workflow-dispatch-receipt-context-impact.md`

**接口契约：**
- Consumes：现有 subagent tool 返回值、真实 sender 的结构化字段和完成/失败/暂停/部分结果/批量通知的差异。
- Produces：精确 selector 决策合同；只有能从真实 sender 的稳定结构化字段证明“单条 dispatch complete、无新增业务结果”时才允许 `triggerTurn:false`。历史阶段若只有标题文本、接入 owner 未证明或字段不稳定，则暂缓 T9；sender 位于上游单独不足以证明无合法本仓 options 接入点。

**验收标准：**选择器不依赖易误匹配的宽标题正则、不按是否有 child 盲判、不影响真实 completion/failure/decision；文档列出最小正例、反例和字段缺失时的 fail-closed 行为。

- [x] **步骤 1：**逐字段对照 tool result 与 workflow receipt，确定 receipt 新增信息是否已在 tool result 返回中存在。
- [x] **步骤 2：**记录 `ownerComponent`、`ownerPath`、`ownerScope`、字段来源、缺失行为和正反例；若无法证明结构化字段互斥，明确关闭 T9；不修改 sendMessage、不执行真实派发。
- [ ] **步骤 3：**用 JSON fixture 语法/结构检查验证正反例文档，明确现有测试只能证明的范围。当前仅有 sender/observer 静态记录，尚无完整 selector 正反例验证证据。

**停止条件：**无法稳定区分纯派发回执与真实完成通知；需要删除消息、改成 TUI-only、改变持久化或依赖上游未提供的事件字段。

---

## T5：主会话空闲通知的登记与 settled 生命周期合同

**Deps：**`T0`

**WritePaths：**
- `docs/decisions/2026-10-10-idle-system-notification.md`

**Resources：**`static-evidence`；macOS `osascript` 默认禁用

**Files：**
- Modify：`docs/decisions/2026-10-10-idle-system-notification.md`
- Read：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-state.ts`、`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`packages/pi-subagents-enhanced/src/tui/completion-notices.ts`，以及 subagent 唯一派发入口、`agent_settled` handler、status 查询和 session replacement/reload 边界

**接口契约：**
- Consumes：用户已确认的触发条件、唯一 dispatch 入口登记事实、可用 status 查询和主会话 settled/新活动边沿。
- Produces：不依赖全局 active-runs 枚举的 owner/登记/逐 ID 查询可行性决策；必须记录 `ownerComponent`、`ownerPath`、`ownerScope`、登记时点、resume 新 ID 时点、replacement/reload 清理点和 session epoch。状态字段必须记录实际 projection；当前 `runtimeFromStatus` 优先读 `details.state`（或顶层 state），再回退顶层 `asyncSnapshot.runs` 的精确 runId 匹配，并仅将 running 状态或 `details.running` 算作 running。它是控制面身份 helper，不是空闲通知完整分类器，不可直接复用其布尔值。后续 idle 合同须证明 public status 的实际返回形态与冲突字段拒绝规则；缺字段不得推断为终态。明确 `running/queued/start-resume` 为活跃、`paused/终态` 为不活跃、未知/查询失败 fail-closed；不把 heartbeat 全覆盖当硬依赖。

**验收标准：**确认成功 dispatch/recovery ID 不会跨主会话错误复用；新用户输入/resume/new dispatch 使旧通知候选失效；通知只在 `agent_settled` 后一次判定；不会把 workspace、terminal proof、supervisor ACK 或消费回执加入额外条件；未发送系统通知、未申请权限。

- [x] **步骤 1：**读取唯一 dispatch owner 的登记和 replacement/reload 生命周期；若没有可证明的 owner、session epoch 或 resume 登记点，写关闭决策，不读取真实 session 正文。
- [ ] **步骤 2：**用合成状态表覆盖 `running/queued/paused/completed/failed/stopped/unknown/status-error`，确认判定和失效规则。当前只记录目标分类，未证明完整状态投影、epoch 失效和登记生命周期。
- [x] **步骤 3：**更新决策记录；TODO 账本由 T11 统一更新；只读静态检查，不调用 `osascript`。

**停止条件：**需要全局 active-runs API、实时事件无丢失计数、真实 macOS 权限、第二进程 authority 或无法证明登记生命周期。

---

## T6：RPC session/cwd/能力门禁的修复资格决策或明确关闭

**Deps：**`T1`（理由：消费 `rpc-provenance.json` 的来源分类、首个偏离和 owner 决策）

**WritePaths：**
- `docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`

**Resources：**`static-evidence`；禁止真实 Host/RPC/model/provider

**Files：**
- Modify：bug 文档记录 T1 证明的 `ownerComponent`、`ownerPath`、`ownerScope`、修复资格或关闭理由。
- Read：T1 provenance、`extension.ts` 和已有 RPC wire 纯测试；不在本任务预先声明 production WritePath。

**接口契约：**
- Consumes：T1 的 `sourceClass=production`、具体首个偏离和最小修复边界；若为 `test` 或 `unconfirmed`，不消费为 production patch。
- Produces：修复资格决策。只有 T1 同时证明 `sourceClass=production`、`ownerScope=repo`、具体 `ownerPath` 和最小补丁，才允许后续另行修订计划声明 production WritePath；否则明确关闭或保持 fail-closed。原有 session identity、cwd、version、spawn method 和能力门禁不得在本任务修改。

**验收标准：**文档明确修复资格或关闭，记录 owner 三元组和来源分类；不把静态/测试证据写成 production 修复，不新增 fallback/自动重试/跨 scope 放宽。若获得修复资格，后续 production 实施必须另行修订计划并同步既有 wire 断言；本任务不宣称 wire 通过。

- [x] **步骤 1：**读取 T1 provenance 并核对 `sourceClass`、`ownerComponent`、`ownerPath`、`ownerScope` 与最小补丁边界。
- [x] **步骤 2：**若任一字段缺失、来源为 `unconfirmed/test` 或 owner 在上游，写关闭记录；不修改 production。
- [x] **步骤 3：**执行 JSON/Markdown 结构检查并保存真实 exit；若未来另行修订计划，才重新声明 unit-runner 和既有 wire 测试。

**停止条件：**需要修改 `node_modules`、需要完整 session/authority、测试数据来源未分类、或修复要求放宽能力/身份门禁。

---

## T7：supervisor 状态合同的修复资格决策、文案边界或明确关闭

**Deps：**`T2`（理由：消费上游 pending、本仓 durable gate 和消费证据的合同决策）

**WritePaths：**
- `docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`

**Resources：**`static-evidence`；禁止真实 child/supervisor/RPC

**Files：**
- Modify：bug 文档记录 T2 的合同决策、`ownerComponent`、`ownerPath`、`ownerScope` 和修复/文案/关闭边界。
- Read：`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`、`supervisor-consumption.ts`、`supervisor-adapter.ts`、`test/subagent-runtime-membrane.test.mjs`、`test/subagent-supervisor-adapter.test.mjs`、`test/supervisor-consumption.test.mjs`、`test/supervisor-replay.test.mjs`、`test/joint-upgrade-contact-supervisor.integration.mjs`；不在本任务预先声明 production/test WritePath。

**接口契约：**
- Consumes：T2 的 `contractDecision` 和权威 consumption evidence。
- Produces：状态映射决策：`submitted` 仅表示本侧调用已接受，`queued/delivered` 来自本仓 receipt，`consumed` 来自可信 child consumption，`gate-open` 是 gate 对 durable 状态的派生结果而非新持久字段。未证实消费时 gate 继续拒绝 steer；若证实消费后仍拒绝，只有另行修订计划并确认 owner 后才能修正 durable transition，不添加第二 authority。

**验收标准：**文档明确四个状态的来源和派生关系；不以 upstream pending 为空解除 durable gate；不盲目 steer/resume；失败和终局清理保持 fail-closed。若 owner 未证实，只交付合同/关闭决策；不宣称既有测试覆盖真实 control plane。

- [x] **步骤 1：**根据 T2 确定一个首个偏离、状态映射和 owner 三元组；若只是产品合同未定，先记录关闭，不修改控制面。
- [x] **步骤 2：**若 `ownerScope=repo` 且事实证明是 production 缺陷，暂停并修订计划声明精确 production/test WritePaths；本任务不直接实现状态修复。
- [x] **步骤 3：**运行允许的 JSON/Markdown/源码结构检查；不运行真实 supervisor integration，不把既有 membrane/adapter 结果冒充本任务行为验证。

**停止条件：**证据只有 UI attention、queued 回执或模型输出；需要放宽 `SUPERVISOR_REPLY_REQUIRED`、创建第二 authority、轮询上游 pending 或覆盖 dirty 合同。

---

## T8：heartbeat 清理修复边界或上游关闭

**Deps：**`T3`（理由：消费清理覆盖矩阵和 owner/source classification）

**WritePaths：**
- `docs/bugs/2026-10-11-heartbeat-orphan-cleanup-provenance.md`

**Resources：**`static-evidence`；禁止危险进程实验；不修改 `node_modules`

**Files：**
- Modify：heartbeat provenance 文档，补充 owner、覆盖矩阵和最小修复边界。
- 不修改 TODO 账本；T11 统一更新“可执行/需上游/来源未证实”和验证限制。
- 不修改上游安装目录；若需要改 `pi-subagents`，只记录 upstream boundary，不在本任务实施。

**接口契约：**
- Consumes：T3 清理覆盖矩阵。
- Produces：明确本仓是否存在可公开修改的生命周期 owner；若不存在，输出“不在本仓修复”的关闭决策、所需上游 contract 和隔离验证条件；若存在，也只能形成后续单独修复授权所需的精确路径清单。

**验收标准：**不把静态估算变成生产保证；不新增 orphan fallback、kill escalation、第二 lease 或跨进程扫尾器；没有 owner 时不写 production。任何后续代码修复必须重新取得明确授权并以新计划/补充任务承载。

- [x] **步骤 1：**逐项审阅 T3 矩阵，确认是否有本仓 public owner 和合法 production provenance。
- [x] **步骤 2：**若 owner 在上游，写明上游接口缺口和本仓不修改理由；若 owner 在本仓但证据不足，保持 unconfirmed。
- [x] **步骤 3：**将 owner、覆盖矩阵和最小下一步保留在 bug 文档；TODO 账本由 T11 统一更新。运行 Markdown/JSON 结构检查，不执行 kill、child、runner 或 descendant 实验。

**停止条件：**有人要求用真实 SIGKILL、测试 process mock 或 node_modules patch 直接宣称清理已修复。

---

## T9：纯派发回执 `triggerTurn` owner 决策或明确关闭

**Deps：**`T4`（理由：消费 sender owner、字段来源和保留消息/持久化/事件的合同）

**WritePaths：**
- `docs/decisions/2026-10-11-dispatch-receipt-trigger-turn.md`

**Resources：**`static-evidence`；不得真实派发或启动模型

**Files：**
- Modify：决策文档记录 `ownerComponent`、`ownerPath`、`ownerScope`、字段来源、selector 正反例、缺失行为和关闭条件。
- Read：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts`、`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/notify.js` 及现有 completion notice observer。
- 若 sender/结构化字段 owner 不在本仓，T9 不创建 production WritePath；任何实现须另行修订计划。

**接口契约：**
- Consumes：T4 selector 合同。
- Produces：只有能从真实 sender 的稳定结构化字段证明“单条 dispatch complete、无新增业务结果”时才允许后续 `triggerTurn:false`；消息仍投递、持久化、TUI 可见、事件保留。历史阶段若只有标题文本、合法接点未证明或字段不稳定，则产出暂缓决策；不能仅因 sender 在上游断言所有本仓 options 接点不可用。

**验收标准：**必须记录 sender 的真实 owner 和字段来源；不得把 `completion-notices.ts` 的 `message_end`/UI observer 当 sender。无法证明结构化字段互斥时，以“调查完成、实现关闭”验收；不丢消息、不改 content、事件 payload 或 TUI 投影，不宣称既有 observer 测试覆盖 selector。

- [x] **步骤 1：**定位 sender 的真实 owner、结构化字段和上游/本仓边界；缺少 owner 或稳定字段时写关闭决策。
- [x] **步骤 2：**只有 owner 在本仓且 T4 证明字段互斥时，才在后续经计划修订的任务中实现 selector；本 T9 不越过未声明 WritePath。
- [x] **步骤 3：**执行 JSON/Markdown/源码结构检查，保存真实 exit；不运行真实派发，不把静态结果写成生产验证。

**停止条件：**选择器只能依赖宽标题、需要丢弃上下文消息、无法区分真实完成或需决策回执、或发现上游 sender 不允许此 options 语义。

---

## T10：主会话空闲通知 owner 决策或明确关闭

**Deps：**`T5`（理由：消费登记 owner、session epoch、settled 边沿、status projection 和失效规则）；用户必须在执行任何系统通知实现前再次明确授权。

**WritePaths：**
- `docs/decisions/2026-10-10-idle-system-notification.md`

**Resources：**`static-evidence`；`macOS-osascript` 默认禁用，需用户二次授权

**Files：**
- Modify：决策记录写明登记 owner、session epoch、状态字段路径、授权门禁和失败行为。
- Read：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-state.ts`、`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`packages/pi-subagents-enhanced/src/tui/completion-notices.ts`。
- 若 T5 无法证明登记与 replacement/reload 生命周期，T10 只交付关闭决策；任何 production 实现须另行修订计划并声明确切 WritePaths。

**接口契约：**
- Consumes：T5 的登记/查询合同。
- Produces：owner/生命周期可行性决策。若可行，记录 `agent_settled` 后按当前 session epoch 登记的 run IDs 逐一查询；先锁定 public status 返回形态和精确 runId 匹配规则，不假定所有投影只位于同一字段。只有明确的 `paused` 或终态允许候选通知；`running/queued/start/resume`、缺字段、冲突字段、owner 不匹配、unknown、status error 或新活动均不通知。历史阶段未证明 owner 时暂缓实现并保留 fail-closed；不以缺少现成 registry 代替后续设计决策。

**验收标准：**必须记录 `ownerComponent`、`ownerPath`、`ownerScope`、登记时点、resume 新 ID 时点、replacement/reload 清理点和 session epoch。当前没有这些事实时，以“调查完成、通知实现关闭”验收；不需要全局 active-runs 枚举、不用本地计数代替 status、不等待 consumption/workspace/terminal proof、不跨 session 复用 run ID；本任务不调用真实 `osascript`。

- [x] **步骤 1：**确认 T5 已证明的 owner、登记时点、resume/replacement/reload epoch 和 status 字段；缺任一项写关闭决策。
- [x] **步骤 2：**若 owner 在本仓且用户另行授权，先修订计划声明 feature-owned implementation 的确切路径；本 T10 不猜测路径、不实现半套逻辑。
- [x] **步骤 3：**只做决策文档与合成状态表的静态检查，不调用 `osascript`，不运行真实 status/child；不把既有 observer 测试宣称为 idle registry 覆盖。

**停止条件：**需要真实通知权限、全局 active API、常驻重发、第二 authority、真实 child status 或无法证明 session owner 生命周期。

---

## T11：聚焦验收、账本收口与交付边界

**Deps：**`T6`、`T7`、`T8`、`T9`、`T10`（每项必须明确“修复完成”“调查完成但不修复”或“保持暂缓”，不能以未执行代替结论）

**WritePaths：**
- `docs/todos/2026-10-10-runtime-followups.md`
- `docs/plans/records/2026-10-11-runtime-followups/acceptance.md`

**Resources：**`unit-runner` 容量 1；不运行真实 Host/provider/model/MCP/危险进程

**Files：**
- Modify：TODO 账本，更新五项状态、证据链接、未授权边界和下一步。
- Create：验收记录，保存任务结果、实际命令、exit、日志、hash、未验证清单和停止原因。
- Read：所有 task records、允许的代码 diff、工作区 status 和现有测试日志。

**接口契约：**
- Consumes：T0–T10 的记录、代码 diff、真实日志和用户授权事实。
- Produces：`acceptance.md`，至少包含任务状态矩阵、source classification、实际验证范围、未验证限制、资源释放、index/status、无凭据声明和是否允许后续实施的决策；不自动提交。

**验收标准：**交付状态统一称为“静态/合成合同验收”，不称真实 runtime 实验通过；不把调查报告写成 production 修复，不把 fake/静态检查写成真实 Host 验收，不把 queued/delivered/consumed 混写；五项 checkbox 只在对应交付物满足标准时勾选，暂缓/关闭项保留未实施说明；所有 worker、unit-runner、临时文件写入和进程状态可说明。

- [x] **步骤 1：**核对本轮已产出的静态记录、无 production diff 和授权范围；明确没有既有测试/真实运行证据支撑本轮行为验收，不以记录产出冒充完整 provenance。
- [x] **步骤 2：**按本轮“仅调查/资格决策、不改 production”的边界，只执行必要的 JSON/Markdown/源码结构检查；不重复 root/enhanced `tsc` 或既有纯测试，不运行危险/真实流程。
- [x] **步骤 3：**生成 acceptance 记录，更新账本状态，执行 `git diff --check`、精确路径审计和 index/status 检查。调查阶段未提交；当前文档 commit/push 来自用户后续明确授权，实际结果以 Git 回执为准。

**停止条件：**任一任务证据不足、测试数据来源未分类、出现敏感内容、出现未声明 dirty、需要放宽门禁或资源无法释放；保留现场并向用户报告。

## 计划执行前的决策门

- T0–T5 是只读/记录型调查，执行方式仍由用户在本计划完成后选择；调查不得自动触发 T6–T10。
- T6–T10 即使在本计划中列出，也必须分别满足对应 provenance、产品合同和用户授权；“选择 Subagent-Driven”不等于授权真实 Host、系统通知或危险进程实验。
- heartbeat 若确认 owner 在上游，T8 只能形成 upstream boundary；不得把上游工单、申请或发布流程当作已提交，任何工单都需要用户单独确认。
- 空闲通知的 macOS 权限和 `osascript` 运行必须取得二次明确授权；未授权时计划只能交付决策记录和静态状态表。
- 任何修复任务发现候选 WritePath 与本计划不同，必须暂停该任务、记录差异并由主会话 inline 修订计划；不得以“最小改动”为由越过路径门禁。
- 计划不包含 commit/push；后续如需提交，按当时用户明确授权重新审计 dirty、读取提交规范并单独执行。

## 计划完成判定

本计划只有在 T0–T11 的记录、决策、代码（如获授权）和验证范围均可追溯时才算完成。若某项被证明是来源未证实、上游 owner 或用户暂缓，必须写明“记录已产出、生产修复未实施”，不得用绿色测试、checkbox 或静态分析替代生产结论。当前仅文档整理阶段收口：T1/T2 缺生产样本，T4/T5 缺完整接入/生命周期合同，实际代码与真实流程继续暂缓。

## 再审后的增量入口（不是自动实施授权）

| 条目 | 不再重复的历史工作 | 尚需交付物 | 可推进与停止边界 |
| --- | --- | --- | --- |
| RPC session | 已记录的复合能力标签和静态调用链 | 精确失败样本的非敏感入口、身份、版本、时序和首个偏离 | 无样本保持未证实；只在证明本仓生产缺陷后声明精确修复路径，不新增 fallback |
| supervisor | 已记录 submitted/queued/delivered/consumed/gate-open 的区别 | 精确 request/reply/steer 顺序与权威消费事实 | 不以 UI、提交成功或 pending 空开 gate；与统一 footer 无硬依赖 |
| heartbeat | 已完成静态覆盖矩阵与 owner 边界 | 接受现有限制的明确处置，或有范围/权限的独立清理能力设计 | 不宣称所有后代已被清理；不自动运行 kill 实验或改上游安装物；不是 idle 前置 |
| 纯派发 triggerTurn | 已定位上游 sender，确认 TUI observer 不是 sender | 稳定结构化 receipt 正反例、相对 tool result 新信息、合法 options 接点和 fail-closed 合同 | 新增接入设计不要求先有生产事故；仍须证明不会抑制真实完成/错误/决策或混合批量通知，不改 content/持久化/事件 |
| idle 通知 | 产品条件已确认、缺全局枚举不是阻塞 | 唯一派发入口实际成功 ID 登记、resume 新 ID、session epoch、权威 status 分类、候选失效和一次通知合同 | 登记集合不是权威状态；与 footer 显示 registry 分离；真实 macOS 通知调用另行授权，失败不影响任务 |

- 后续只派发增量未闭合任务，不重新执行 T0–T11。新任务建立新基线，历史 `baseline.json` 和 `acceptance.md` 原样保留。
- 投递 options 与系统通知属于独立行为 feature，不是 footer renderer 任务；不能把 registry 共用为第二控制 authority，也不能用 footer 有限 history 推断所有 child 已空闲。
- 历史 T4/T9、T5/T10 中的“关闭”一律限于当时调查范围；新的接口/生命周期设计仍可在明确合同和实施授权后推进。所需 production WritePaths 未证明前不预授权猜测路径。
- `/tmp` 报告只是补充历史资料；新任务以 pinned 源码、入库 decision/bug 和字段级样本为依据。历史日志丢失不能由 prose 重建实验通过事实。
- 本轮不授权通知权限、真实 Host/RPC/provider/child、kill 实验或 commit/push。修订完成后由用户选择 Subagent-Driven / Inline 或继续 review。
