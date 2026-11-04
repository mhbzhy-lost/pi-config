# Pi 1.5.0 / pi-subagents 0.84.0 升级后的自建 runtime 退役机会

日期：2026-11-03。性质：源码级静态调查与可选瘦身建议；不是升级实施、退役授权或新的实施计划。

## 结论

**没有找到“升级后即可直接删除、且保持本仓现有权限、恢复、资源与展示合同”的完整现役 runtime 模块。存在值得评估的局部退役机会，主要集中在进度采集、状态轮询和历史 completion 注入接口；没有证据支持直接撤掉 Root Broker、managed workspace、integration queue 或 terminal proof 适配。**

需要分两层看：

- **当前可直接删除：** 按“不丢现有保证、所有消费者可替换”的严格口径，本轮没有确认的完整生产模块，也没有确认的版本专属 workaround 分支。更新版本常量、TypeBox import、ceiling 身份键均是升级适配，不算退役。普通 completion delivery/dedup 已由上游拥有，不是这次升级新获得的删减。
- **接入现有原生入口后可有条件退役：** 最有价值的是以 `jobsChanged → RPC status` 接管自建活动采集，缩减 footer 的 500ms 文件轮询，或替代 `async-progress` 的 events.jsonl watcher/parser。更大幅的显示层退役可以考虑 `external-runs → 原生 FleetView`，但会改变统一 footer、完整详情和状态表达，绝非等价的小修。`background-work` 自身只是等待协议，不会接管这些职责。

最小瘦身顺序宜是：先核清只供历史测试注入的旧 completion 支路；再评估进度采集；再评估 footer 刷新；最后才讨论是否接受原生 FleetView 的产品取舍。此顺序只表达成本与风险，不修改现有升级计划，不将可选接入列为升级必做。

## 调查边界与证据定位

本轮只读取规范、计划、已有研究、仓内源码/既有测试源码及已解包目标发布包，执行文件枚举、文本检索和 Git 状态查询。**没有运行测试、类型检查、安装、pack、Doctor、probe、Host、provider、subagent 或 MCP，没有联网，没有访问凭据、真实 session 或业务 ledger。** 唯一写入是本报告，未改依赖、配置、实现、既有四份未跟踪文档或计划，未暂存、提交。

基线 manifest 仍为 Pi `1.4.0`（`package.json:30-35`），增强包的 upstream 为 `0.80.0`（`packages/pi-subagents-enhanced/package.json:39-47`）。目标发布包是研究资料，不是候选安装；本轮不据此声称已升级或运行兼容通过。

以下缩写均指实际读取的文件，`路径:行号` 是静态定位：

| 缩写 | 绝对根目录 |
| --- | --- |
| `R/` | `/Users/leshi.zhy/pi-config/` |
| `E/` | `/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/` |
| `S/` | `/tmp/pi-subagents-upgrade-research-2026-11-03/084/package/`，pi-subagents 0.84.0 |
| `S80/` | `/tmp/pi-subagents-upgrade-research-2026-11-03/080/package/`，对照 0.80.0 |
| `P/` | `/tmp/pi-version-research/v1.5/package/`，Pi coding-agent 1.5.0 |
| `A/` | `/tmp/pi-version-research/packages-1.5/pi-ai/package/` |

已先读 `R/AGENTS.md`、`R/pi/AGENTS_SHARED.md`、`E/AGENTS.md`；随后读取升级计划与两份最终研究报告。本轮通过实际源码重新核对关键判断，不将此前报告的测试设想当成通过证据。目标主要路径均存在；没有下载缺失资料。

当前实际目录中没有题目泛称的独立 `src/completion/**`：completion 职责分布在 `E/src/tui/completion-notices.ts`、`E/src/workspace/completion-reminder.ts`、`E/src/subagent-dispatch/**` 和上游 notify 中。`host-runtime`、`workspace`、`tui` 也主要在增强包内；根层另有 `R/src/bash-async`、`R/src/background-activity`、`R/src/async-progress`、`R/src/task-scheduler`、`R/src/session-owner`。没有机械扩大到全仓其它业务功能。

分类口径：

- **可退役**：同输入、失败/恢复、权限与资源事实等价，权威归属明确，全部现役消费者存在受支持替代入口。本轮无满足此条件的完整现役模块。
- **可缩减／薄适配保留**：原生拥有底层能力，本仓仍有配置、typed 合同、身份或展示适配；可选迁移另列前提。
- **仍须保留**：目标能力不承担本仓实际合同，删除会失去必要保证。
- **证据不足**：未证明目标运行效果、所有调用方替换或等价性；不能由未找到某 API 推断上游没有任何相应能力。

## 实有职责与原生能力映射

| 职责 | 本仓入口、实现与实际消费者 | 目标原生入口与保证 | 差异与分类 |
| --- | --- | --- | --- |
| Host 装配、启动/排空/销毁次序 | `E/extensions/subagent-runtime.ts:306-344,674-729,737-878` 装配 broker、workspace、supervisor 与 TUI；`E/src/subagent-dispatch/extension.ts:2680-2797,2873-2918` 捕获上游 lifecycle/event handler、隐藏旧代清理直到 shutdown debt 排空；manifest 在 `E/package.json:19-23` 自动发现入口 | `pi-subagents` root，`S/src/extension/index.js:305,1162` 安装 notify 和恢复；Pi 提供扩展 lifecycle | 上游自己的 teardown 不知道本仓 coordinator proof sink、已接受请求与资源释放债。**保留装配与有序排空**；bundle/新 session 修复不证明次序等价。 |
| child capability ceiling | `E/src/subagent-dispatch/child-tool-policy.ts:14-33` 读取本仓 `childToolCeiling`，经公开 API 注册；caller/disposer 为 `E/extensions/subagent-runtime.ts:743-748,805-806,863-864` | `pi-subagents/capability-ceiling`；`S/src/runs/shared/capability-ceiling.js:24-58,73-145` 标准化、交集、token 注册、update/dispose；`S/src/runs/foreground/subagent-executor.js:1538,5072` 用 getSessionId 查找 | **薄适配保留**。本仓没有另一套 ceiling 执行器。配置必填 allowedTools、拒绝未知字段、缺配置不注册、空数组不等于缺省及生命周期仍由本仓拥有。当前 sessionFile 键须适配，不是删除机会。 |
| required child extensions / tools | `E/src/subagent-dispatch/extension.ts:2584-2600` 注册 root-session-owner、integration-queue、agents-shared；`E/child-extensions/integration-queue.ts:224-271` 参与完成门禁 | `pi-subagents/required-child-extensions`；`S/src/runs/shared/child-tool-plan.js:189-201` 合并 ceiling、拒绝 denyExtensions 与 required 冲突、拒绝缺失 lazy-skill read；0.82 修复 required 路径别名/未加载，见 `S/CHANGELOG.md:119` | **保留本仓义务定义/ACK 消费**。上游负责加载和工具上限，本仓规定哪些 child 扩展必须存在并执行受管资源协议。上游补齐加载检查不等于替代 integration guard。 |
| typed dispatch 与 run control | `E/src/subagent-dispatch/operation-tools.ts:1-25`、`extension.ts:915-945,1151-1152,1348-1349,2388-2402`；`execution-contract.ts:161-174` 授权 profile/cwd/隔离；Goal 经 `E/src/execution/index.ts:21-36` 消费 | 公开 event-bus RPC，`S/docs/extension-api.md:107-152`、`S/src/extension/rpc.js:340-343`；spawn/control 调用现有 executor，RPC steer 保证 nonRecoveringSteer | **底层执行已原生，typed/authority 保留**。目标没有接收本仓 writePaths/contractHash/workspace receipt 的等价入口。工具 schema/import 迁移不等于功能退役。 |
| supervisor ask/interview/progress 传输 | `E/src/subagent-dispatch/runtime-membrane.ts:174-184` 捕获原生 supervisor execute；`supervisor-adapter.ts:21-40` 转发；`extension.ts:2400-2402` 注册 typed 操作 | `S/src/intercom/native-supervisor-channel.js:25-35,132-188,218-227` 提供 contact_supervisor、文件 requests/replies、progress 不等待；`S80/src/intercom/native-supervisor-channel.js:218` 已存在客户端 | **传输早已原生，薄桥保留**。不是升级新增一套可替换的问答功能。本仓额外控制面见下一行。 |
| Root Broker / supervisor 权限、请求/消费证明 | `E/extensions/subagent-runtime.ts:606-679` 接私有 owner store 与 correlation；`root-broker-server.ts:1046-1048,1351-1352` 发 grant 并校验 caller；`supervisor-control-plane.ts:8-26,177-223,254-284` durable 请求/receipt、owner generation、unavailable 拒绝；`supervisor-consumption.ts:31-49,52-108` 核对真实 child session/toolCall 与已接受终态 | 原生 supervisor 在 `S/src/intercom/native-supervisor-channel.js:376,502-534` 做 run/session ownership、写 reply 与记录父侧 entry；原生 control inbox 在 `S/src/runs/background/control-channel.js:1-15,75-121,190-208`，公开 `/control-channel` 仅导出 requestAsyncStop（`S/src/api/control-channel.d.ts:1-2`） | **仍须保留**。传输持久化、写入成功不证明本仓 ownerGeneration、合同授权或 child 已消费。接入原生 inbox 不能删除现有 root authority 或 CAS/消费证明。 |
| completion delivery / dedup / restart replay | 生产入口 `E/extensions/subagent-runtime.ts:725-729` 已明确不转发 async-complete；测试证据定位 `R/test/subagent-runtime-membrane.test.mjs:370-380`；TUI notice 在 `E/src/tui/completion-notices.ts:7-48` | `S/src/extension/index.js:305` → `S/src/runs/background/notify.js:1-24`；`completion-dedupe.js:12-48`；`completion-replay.js:160-200`；`result-delivery-ownership.js:6-36` | **递送已由原生承担，不存在第二个现役递送模块可再删**。隐藏消息 toast 的 WeakSet 只是本代 TUI 去重，不是上游发送去重。旧 factory 测试支路单列。 |
| process terminal proof、proof debt 与 release | `E/src/subagent-dispatch/root-broker-server.ts:741-817` 只接受 observed 官方 proof、检查身份冲突、撤销 grant、转发 proof 并记录债；`E/extensions/subagent-runtime.ts:170-211,892-1005` 投影给 coordinator/PlanRunFacts | 原生 `S/src/runs/background/process-terminal.js:16-28,52-94,133-150` 生成/校验 runner/writer/lease proof；0.83修复最终 reply 后未写结果，`S/CHANGELOG.md:59` 对应条目 | **生成原生，归属和业务结算适配保留**。上游终态不是本仓 workspace 已集成/已释放；本仓也没有因“code 0”自行制造 observed 的可删除 workaround。 |
| explicit resume / workflow autoResume | `E/src/subagent-dispatch/extension.ts:1628-1666` prepare → wait 新 binding → register → activate；`E/extensions/subagent-runtime.ts:1013` 起处理 managedCodingResume；`E/src/workspace/service.ts:252-268` rebind 需要 intent authorizer | `S/src/workflows/workflow-auto-resume.js:9-10,48-97`；`workflow-resume.js:46-103`；`S/src/extension/index.js:615-626,956-960` → `S/src/runs/foreground/subagent-executor.js:7793-7799` | **保留显式恢复与资源重绑定**。自动恢复只复用 workflow launch/child 步骤，绕过本仓新 typed 派发入口；没有证明能满足 owner/proof/workspace/queue 恢复。保持计划中 autoResume=false，不因升级替换。 |
| workflow 生成、child 启动绑定 | `E/src/subagent-dispatch/workflow-spawn.ts:61-109,137-270` 生成一个受控 runs.run，收集 root/leaf 关联与启动失败；消费者为 dispatch extension | `S/src/workflows/scripted-workflow.js:783-784,1002-1010` + `S/workflow-script-worker.cjs:1182-1213,1286-1289` 拒绝 import()、锁定 prepareStackTrace；RPC spawn 公开接收 script | **业务编排保留；本地安全 workaround 未找到**。本仓生成 JSON 数据嵌入脚本，不实现同一 VM sandbox。不能借安全公告删除 workflow-spawn/typed 校验。 |
| managed workspace / queue / lease | `E/src/workspace/service.ts:176-196,252-281,410-420,443-499`；`integration-queue.ts:59-70,117-137,250-278`；入口还通过 `E/extensions/subagent-runtime.ts:80-211` 连独立 coordinator；child integration 与 Goal 消费 | 上游 worktree 机制在 `S/src/runs/shared/worktree.js:33-56,1255,1281`，包含进程内事务、创建、diff；本仓 spawn 刻意 `worktree:false`（workflow-spawn `:92,106`） | **仍须保留**。进程内 worktree 串行化不同于 repository/common-dir 级 daemon、私有 ledger、queue lease、generation、publish/release receipt。目标未发现这些本仓合同的公开替代入口，不将同名 worktree/queue 算等价。 |
| Host 物理同源、peer binding / bundle | `E/src/host-runtime/index.ts:6-22,25-54`；`peer-installation.ts:8-47`；消费者 `R/scripts/resolve-physical-pi.ts:2-5`、`E/scripts/setup-runtime-deps.ts:4,18` | `S/package.json:60-125` root/subpaths 变 bundle；`S/src/runs/background/runner-aliases.js:1-30,139-164`、`S/runner-peer-preload.mjs:1-29` 将 runner peer 指向 Host；`S80/src/runs/background/async-execution.js:494` 已用 preload | **仍须保留部署门禁**。runner 的 alias 不会改根 Node/CLI/另一个 loader 的实际解析；bundle 同 key 只证明同 realm 的共享机制，不证明所有进程/Host singleton 同源。没有本地生产 preload 实现可删。 |
| bash_async 执行、取消、followUp、会话代际 | `R/src/bash-async/index.ts:29-91` 复用原生 Bash；`controller.ts:21-108` 拥有 jobs、branchEpoch、取消/终态/投递状态；`R/pi/extensions/bash-cwd.ts` 为 Host 接线 | `pi-subagents/background-work`：`S/src/api/background-work.js:69-101,127-169` 仅 provider list/reconcile/wake 与 `{id,sessionId}`；Pi 1.5 exec 修复见 `P/CHANGELOG.md:46-47,89-90` 对应条目 | **执行与会话合同保留**。background-work 不启动、不取消、不存原输出、不发送完成消息。Pi exec 修复已在下层，不能替代异步接受回执；bash_async 本身也不是 exec 的 SIGKILL/UTF-8 补丁。 |
| 后台活动统一显示 owner / registry / details | `E/src/tui/background-activity.ts:20-91,286`；`footer-runtime.ts:801`；`R/src/background-activity/index.ts:10-13`；bash publisher `R/src/bash-async/index.ts:224-300`、scheduler source `R/src/task-scheduler/activity-source.ts:35-100` 消费同一协议 | background-work 是等待入口；另有公开 `pi-subagents/external-runs`：`S/src/api/external-runs.js:1-33,164-200`，Fleet 展示有限 cache，caller 仍拥有执行/取消/持久化/结果 | **当前保留；可做产品取舍后有条件退役显示层**。本仓 registry 是投影权威，不是第二份任务 ledger。原生没有此处的完整 detail component、stale/unavailable、HostScope epoch、scheduler 待触发语义。 |
| subagent 状态刷新/进度采集 | `E/src/tui/footer-runtime.ts:520-530,994-1017` 每500ms读已跟踪 run status；`browser-adapter.ts:15-37`；根 `R/src/async-progress/index.ts:21-129,164-245` 自己 tail/watch events；`R/pi/extensions/async-progress-watcher.ts:10-39` 消费 | 0.83 `subagent:jobs-changed`：`S/src/shared/types.js:22-23`、`async-job-tracker.js:64-68`；公开 RPC status/asyncSnapshot，`S/src/runs/shared/async-status-projection.js:90-105` 有 currentTool/turnCount/toolCount | **最明确的可缩减面**。可把重复采集交给原生状态观察；需保留会话/代际与 bounded snapshot 缺项处理，确认延迟和详情刷新取舍。详细条件见后文。 |
| 原生 conversation 复用与紧凑 renderer | `E/src/tui/native-conversation.ts:4-21,88-159,163-200` 复用 Pi message/tool 组件，自己做可信文件快照/缓存；`tool-renderers.ts:60-100`、`compact-rendering.ts` 表达本仓样式；footer `:532-563` 消费 | Pi 1.5 `P/dist/modes/interactive/components/tool-execution.js:124-169` 按帧处理参数更新；`theme/theme.js:781-800` CodeHighlighter；`A/dist/utils/streaming-json.js:1-34,54-105` 增量解析 | **不是同一 workaround，仍保留；整体改原生 UI 属有损产品替换**。native-conversation 缓存的是文件快照/整段渲染，不是重复实现流式 JSON 或语法高亮。 |
| session write / session-owner | `R/src/session-owner/extension.ts:73-137` 在切换前预留、校验并显式 cancel；Goal/authority/workspace 各自存业务状态 | Pi 1.5 `P/dist/core/session-manager.js:816-831` 在 _persist 失败时撤回内存 entry/byId/leafId | **保留，且未找到同 bug 本地补丁**。单条 session append 回滚不替代多 Host session 占用、owner generation、queue/ledger 的 CAS/持久化。 |

## 关键语义核对

### 1. Ceiling 已经薄到配置适配，不能删除 disposer 或 required tools

`child-tool-policy.ts` 只有33行，实际 enforcement 直接调用公开 `registerSubagentCapabilityCeiling`。上游 normalize 接受 allowedAgents-only、denyExtensions 等更宽配置；本仓明确要求 allowedTools 并拒绝未知字段（`:20-25`）。直接用上游 parser 替代本仓 config loader 会改变输入合同；只删数组规范化也仍须保留本仓必填/未知字段/错误语义，而且收益很小。

`allowedTools: []` 是禁止 caller-facing tools，未配置才是不注册，不能合并。上游还可能保留内部 structured_output，并对 required read/required extension 冲突失败（`S/docs/extension-api.md:430-449`，`S/src/runs/shared/child-tool-plan.js:189-201`）。这些是上游权限机制，不是批准删除本仓 integration/owner 扩展的依据。

明确升级适配是：`E/extensions/subagent-runtime.ts:743-748` 当前传 sessionFile 优先的 lifecycleSessionId，目标 `S/src/runs/foreground/subagent-executor.js:5072` 查 getSessionId；仅将 ceiling 的注册键对齐已有 rootSessionId。broker、completion 和 artifacts 的 lifecycle identity 不能全局改。disposer 仍需在 startup 失败和成功 drain 后执行；既有 `R/test/joint-upgrade-ceiling-runtime.test.mjs:34,52` 就在检查失败清理和 drain 失败不提前撤权。**本轮未运行这些检查。**

### 2. 原生 intercom / durable inbox 接管传输，不接管业务 authority

原生 question/progress 客户端已在0.80存在；当前 membrane 捕获原生 supervisor execute，再包 typed operation。0.84有请求文件、回复文件、父侧 entry 和持久 control inbox，这是确实的持久机制，不能说上游“只有内存消息”。

但本仓 control plane 的 `ownerGeneration / requestGeneration / requestDigest / processBirth / childSessionId / toolCallId` 与 reply consumption 是不同事实。`supervisor-consumption.ts:52-108` 只有在 Root Broker 已接受 terminal proof，且 canonical child session 的 contact_supervisor toolResult 与请求、回复 digest 一致时才认消费。`S/src/intercom/native-supervisor-channel.js:502-534` 写 reply/append entry 不承担这条链。因此删除本仓层会失去撤权、精确请求幂等和“发送≠消费”的业务证明，不能作为少量桥接后的等价退役。

`pi-subagents/intercom-bridge` 的公开模块实际只导出 target resolver（`S/src/api/intercom-bridge.js:1-2`）；不能因名称推断它是 Root Broker 的通用 RPC authority 替代。若“durable inbox”指独立 pi-intercom 包的更广契约，本轮目标材料没有提供该包的版本/消费接线证明，归为**证据不足**；不联网补包、不声称它不存在。

也应避免把仓内未启用库当成运行中的第二套通知系统：全仓源码消费者检索显示 `createSupervisorReplay`、`DurableEventOutbox` 的实例化在 `R/test/supervisor-replay.test.mjs:19-29`、`test/subagent-delivery-recovery.test.mjs:15,58`；`test/subagent-runtime-membrane.test.mjs:3025-3030` 还明确说明当前无 production 实例化。其定义在 `E/src/subagent-dispatch/supervisor-replay.ts:16-47`、`durable-event-outbox.ts:14-74`。它们可另作未接线代码清理候选，**不能报告成“升级退掉现役 durable inbox”**；更不能连带删除仍被 supervisor/authority 使用的 `DurableStorage`。

### 3. 普通 completion 已原生，余下是 UI、资源提示与历史注入点

生产入口在 `E/extensions/subagent-runtime.ts:725-729` 已清楚选择 native notify。上游 notify 的发送、result file 的消费、TTL 去重、completion replay 由上游拥有；本仓没有必要新增自己的补发器。0.82的重开 session 回放与0.84保留期变化，仍不会把 notification 变成 workspace release proof。

`E/src/tui/completion-notices.ts:18-36` 只针对 TUI 中隐藏的 `subagent-notify` 发短状态提示；WeakSet 防止同对象显示两次。`E/src/workspace/completion-reminder.ts:35-79` 根据同 lifecycle session 的 owned receipt 提醒未处理 workspace。这两个消费者分别需要显示与资源事实，上游消息去重不能替代。

可进一步删减的是 **`completionNotifierFactory` 历史注入支路**：`E/src/subagent-dispatch/extension.ts:2652,2661,2757,2810,2832-2836,2871` 仍允许自建 notifier，`runtime-membrane.ts:15-17,156-163` 能因此 suppress 原生消息。生产入口不传它；实际调用方在历史回归 fixture（尤其 `R/test/subagent-completion-notification.integration.mjs:490-503`）。将旧失败接线留在测试局部替身、移除生产可选接口，可减少一条误屏蔽原生通知的路径。**这属于已完成原生迁移的遗留接口清理，不是0.84才取代；必须同步迁移既有fixture，不能当场直接删到测试失效，也不能顺手删 workspaceCompletionReminder 的独立接线与生命周期追踪。**

### 4. 自动恢复不是本仓恢复等价物

目标 autoResume 默认 true，只在 recovering 且 hasUI 时规划；最多扫描近期50项、24小时内、同session的可复用停止 workflow，有 claim/refusal 与尝试上限（`S/src/workflows/workflow-auto-resume.js:9-10,48-97`、`workflow-resume.js:46-103`）。它有自己的 ownership/ceiling/lease 检查，不能说是无授权恢复。

差异在授权域：`S/src/extension/index.js:625` 直接调 `executeWorkflowResume`，没有重新经过本仓 `hostAuthorizedDispatch`；本仓还需要 sourceProof、workspace lease、integration resume intent、当前 owner、rebind 与新 child ACK。静态既不能证明自动恢复成功绕过门禁，也不能证明这些事实自动成立。若为了删除 typed resume 而接受“只恢复脚本进度、受管 workspace/queue 另行人工处理”，那是改变产品恢复合同，非少量无损桥接。当前建议维持原计划关闭新增自动行为。

### 5. Sandbox 修复与本仓 workflow 不是同一实现

0.84实际在 worker realm 中锁定 `Error.prepareStackTrace`，执行前 AST 拒绝 ImportExpression（上表源码）；对应官方安全公告：[GHSA-6v8j-6w28-2w8r](https://github.com/nicobailon/pi-subagents/security/advisories/GHSA-6v8j-6w28-2w8r)。本仓 workflow-spawn 的 JSON.stringify 是向 JavaScript 嵌入数据，并非 shell escaping 或 VM 加固。

限定搜索 `src`、`pi/extensions`、增强包源码/入口与脚本中的 `prepareStackTrace`、`ImportExpression`、preload/alias 及相关代码，未找到本仓复制的此漏洞补丁。这个“未找到”只表示本轮没有可删对象，不断言所有历史版本从未有过补丁。安全升级本身有效，但不能据其 changelog 把业务 workflow 编排列为退役。

### 6. 共享 bundle key 不等于 Host singleton 同源

S 的 root/subpath default 指向 bundle，子进程仍有 unbundled 文件；required/capability registry 使用 `Symbol.for`/globalThis。原有研究定位的 `S/bundle/chunk-QXASAHIA.js:4-7`、`chunk-CTPAE36Y.js:37-38` 与各公开 subpath 是同 bundle 依赖关系，本轮又核对 unbundled capability registry 和 manifest；**不将静态共键外推到其它 realm/进程**。

runner aliases/preload 是目标包本身的机制，0.80已有 preload 调用。本仓 Host 工具做的是四 peer 精确版本/realpath、部署绑定和实际 constructor/function identity probe；原生 runner alias 只影响它启动的 runner，不能替代这些消费者。Probe 代码存在不等于本轮执行通过。没有“删掉本地 preload”这样的实际生产 diff；更新门禁中的1.4.0为1.5.0也不是退役。

## 可选的最小瘦身清单与必要前提

以下均未实施、未验证；只有“接线和行为取舍获授权且必要验证成立”后，才可把对应子职责升格为可退役。

| 优先级与候选 | 真正可减少的自建逻辑 | 公开替代路径、仍需保留的桥 | 丢失/变化的保证与必要决策 | 验证缺口与净收益判断 |
| --- | --- | --- | --- | --- |
| 1. 清理旧 completion factory 支路 | 上述可注入 notifier、因此启用的 suppression 和 notifier 专属清理；不删 workspace reminder | 无需新原生机制，生产已用 root native notify；历史坏接线放测试局部 | 不应改变现役产品行为；需决定是否保留这组内部测试注入合同 | 迁移现有 membrane/notification fixture 并验证 native发送/raw边界/有序销毁；预期小幅净删减，非本次升级独有收益 |
| 2. `async-progress` 改消费公开 status | `R/src/async-progress/index.ts:21-129` 的 events JSONL parser、offset/tail、fs.watch 与每run定时器 | jobsChanged + started/complete/childStatus/processTerminal → coalesced RPC status → activity/usage 展示；TUI lifecycle与显示函数保留 | 原生 snapshot 给 currentTool、turnCount、toolCount，不承诺逐个 tool_execution_end 的 duration 摘要；需接受“当前活动概览”代替原摘要。若不接受，原采集不能退 | 现有 watcher测试覆盖原输入，不证明新status路径。要核对字段缺失/omitted、reload初始快照、事件在途与刷新延迟；可望删一整段采集代码，但净行数未做实现估算 |
| 3. footer 状态轮询改事件刷新 | `E/src/tui/footer-runtime.ts:445,520-530,602-603,1008-1009` 中专门为发现status变化的定时职责 | 启动先订阅，再status初读；事件合并并保留in-flight后续刷新；用asyncSnapshot的run id，必要时targeted status；现有browser/source/presenter保留 | 事件只有 `{version:1}`，不能当带session的started事件喂给旧门禁。macOS原生读状态可每5秒，相较本仓500ms发现可能慢；不会每帧提供session全文变化。需接受延迟或保留独立详情刷新 | 同一timer还触发viewport refresh；必须先拆清。`readBrowserRunStatus` 还有 `session-browser.ts:165` 读取邻接leaf的消费者，不能直接删整个reader。净收益是轮询/部分I/O减少，不是删除整个TUI；无损等价尚未证 |
| 4. 用原生 FleetView 替代统一后台详情 | 有可能删除根 presenter/detail-controller/layout，部分 package browser/viewport/native-conversation 和三个ActivitySource/publisher桥 | `pi-subagents/external-runs` 接bash/scheduler显示记录，subagent用原生Fleet；需要调整当前headless membrane对registerCommand的屏蔽（`:186-193`）及公开入口可达性 | 失去当前Alt+O统一footer、完整bash原始输出详情、scheduler受控get、stale/unavailable/待触发语义；外部record仅100缓存/20 snapshot、preview4096、label160，状态限queued/running/completed/failed/stopped。不能把scheduler成功投递映射成业务完成。需明确UI范围和状态设计 | 这是产品替代而非当前等价退役；桥接可能变多。没有逐调用方迁移实现，**不承诺净删几千行或整个footer可删**。cwd/model/context等footer职责也独立，须保留或另有原生呈现 |

候选2、3的原生合同在 `S/docs/extension-api.md:154-171`：jobsChanged 只在有UI的 interactive/RPC 会话发，不回放事件；需启动/reconnect初读，建议合并burst并保留in-flight触发；在macOS状态检查可为5秒。`S/src/runs/shared/async-status-projection.js:9-13,90-105` 的projection有数量/字节/深度上限，不能把省略的run当已结束。以上只是本轮可选研究建议，不激活 `jobsChanged`、Fleet 或其它新功能。

**background-work 不单列为退役项目。** 它的unknown-field校验只接受item的id/sessionId（`S/src/api/background-work.js:69-83`），不会容纳ActivityRow详情、终态或命令结果。给bash_async桥接该provider只会让bg_wait能等它，是能力新增，不能删controller、publisher或registry；当前typed membrane也不暴露原生bg_wait工具。若目的只是瘦身，净收益尚未成立。`external-runs` 和 `background-work` 在 `S80/package.json:66-77` 已有导出，不能宣传成0.84新增。

还发现 `E/src/subagent-dispatch/legacy-executor-compat.ts:49-74` 的 `readLegacyExecutorProof` 只有 `R/test/root-subagent-broker-protocol.test.mjs:21,118-125` 消费，是单函数历史清理候选；同文件的 `readLegacyExecutorGrant` 仍被 `root-broker-protocol.ts:512,565` 读取持久grant，`executionProofForLegacySettlement` 仍被 `root-broker-registry.ts:3` 消费。**不允许因文件名legacy就整文件删除，也不能为删兼容层去读真实grant/session。** 同理 `pi-subagents-0.75.ts` 是历史文件名，当前仍承载Host admission/transcript适配，改名不产生逻辑退役。

## 明确保留的权威与资源链

1. **Host-authorized dispatch、Root Broker、required child extensions**：原生已经管launch/control，本仓管谁有资格、哪个合同、哪个受管资源和什么capability。保持同一入口检查而非用原生status文案代替。
2. **workspace ledger/coordinator/queue/lease/发布释放receipt**：原生worktree功能不是本仓跨root共享repository资源协议。`R/src/goal-runtime/scheduler.ts:69-79` 明确要求terminal已证、integration完成、workspace released、无recovery/blocker；改成原生completed会改变终态定义。
3. **terminal proof身份绑定、冲突/投递债与recovery intent**：下层原生负责process facts，上层负责把这些事实应用到正确资源。0.84的30/90天run清理（`S/CHANGELOG.md:19`）更不应被视作长期durable ledger替代。
4. **supervisor owner门禁与消费观察**：原生progress queued/reply write成功不是consumed；保持两类事实分离。若用户将来决定不再需要某类证明，是另一次产品合同变更，不是版本升级自动授权。
5. **Host物理同源/peer版本门禁与session-owner**：bundle、runner alias、session append回滚都不覆盖它们的输入和失败边界。
6. **现有展示中的raw边界、可信路径、epoch与availability**：只要保留当前UI合同，就须保留这些桥。可以换renderer，不得以精简UI为由改raw message/tool result/event/session details。

## Pi 1.5 修复是否命中真实本地 workaround

本轮定向查找 `prepareStackTrace/ImportExpression`、`JITI_ALIAS/preload`、`StreamingJsonParser/parsePartialJson/parseStreamingJson`、SessionManager原型/append替换、highlight缓存及实际TUI消费链，没有找到可据本次修复直接删除的本地生产补丁。不是仅凭 changelog 下结论：

- **流式JSON/按帧渲染**：目标确有新parser与ToolExecutionComponent按帧更新；本地 `tool-renderers.ts` 调公开renderer/组件，`async-progress`读的是已经形成的events JSONL，输入对象不同。
- **高亮/Markdown缓存**：本地 `NativeChildConversationRenderer` 缓存以文件fingerprint、宽度、theme、cwd、expanded为键（`:119-159`），并做O_NOFOLLOW与快照；目标高亮缓存不替代可信文件读取或完整历史渲染。若移除本地缓存，需性能/行为证据，本轮没有。
- **session写失败**：目标 `_appendEntry` 撤回内存状态；本地session-owner只保护切换/占用，业务DurableStorage是另一持久对象。未找到对应本地append回滚patch，故无可退役对象。
- **Pi exec的SIGKILL、输出cap、UTF-8修复**：本地bash_async已经调用原生Bash backend，持有异步任务、取消与投递epoch；没有另一份同问题补丁可机械删除。
- **registerToolRenderer/triggerTurn**：它们是更早版本已有能力，本次不能重新计算为1.5退役收益。TypeBox import来源/validator迁移也不构成功能删除。

这些结论是限定源码检索与消费链阅读，不是穷尽所有历史实现的证明；如后续定位到具体旧补丁，应单独补同输入/失败与全部consumer证据。

## 既有检查能说明什么、还缺什么

本轮以下全部 **not-run**。只定位既有源码入口，不新增测试、不执行fixture，也不把此前研究/计划中的拟运行步骤列为通过。

| 面向 | 现有检查定位 | 能复用检查的合同 / 本轮无法证明的内容 |
| --- | --- | --- |
| ceiling与required | `R/test/joint-upgrade-host-ceiling.test.mjs`、`joint-upgrade-ceiling-runtime.test.mjs:34,52`、`joint-upgrade-contact-supervisor.integration.mjs` | opt-in/空列表/失败清理/drain、child可用性；目标持久session身份与required ACK须在目标闭包复核。contact包含MCP场景，禁止整文件无过滤运行。 |
| supervisor与proof | `R/test/supervisor-consumption.test.mjs`、`supervisor-operation-tools.test.mjs`、`root-subagent-broker.test.mjs:554`、`managed-workspace-terminal-proof-handoff.integration.mjs` | 可检查request/correlation/receipt与official proof衔接；不能由纯mock或终态文本证明真实child消费。 |
| completion旧支路 | `R/test/subagent-runtime-membrane.test.mjs:370,397,559,1072,1114,1141,1199,2374,2402,2424`；`subagent-completion-notification.integration.mjs:490` | 现有生产无factory与旧接线吞通知对照；删除接口前应保留原生通知/raw/失败清理的有效回归，不照搬“已退役注入点必须存在”的断言。 |
| workspace/queue/resume | `R/test/managed-workspace-recovery-rebind.integration.mjs`、`managed-workspace-integration-queue.integration.mjs`、`managed-workspace-multi-root-session.integration.mjs`、`managed-workspace-resume-intent.integration.mjs:206` | 仓库/owner/lease/恢复和无进展保留；上游autoResume的interactive hasUI分支不由print fixture覆盖。 |
| progress与footer | `R/test/async-progress-watcher.test.mjs`、`custom-footer-subagents.test.mjs`、`background-activity-runtime.integration.mjs`、`background-activity-visual.integration.mjs`、`subagent-native-conversation.test.mjs` | 原watcher、原500ms路径、raw/可信文件、选中项/draft/epoch；未有本轮证据证明jobsChanged漏事件、reconnect、omitted和详情刷新可替换。是否复用现有fixture表达须后续评估，不能未经授权新增测试。 |
| bash/scheduler活动 | `R/test/bash-async.test.mjs`、`bash-async-runtime.integration.mjs`、`bash-async-activity.test.mjs`、`background-activity-registry.test.mjs` | 当前controller回执/取消与UI注册；不证明原生background-work/external-runs桥接可用或等价。 |
| Host | `R/test/joint-upgrade-host-probe.test.mjs`、`joint-upgrade-loader.test.mjs`、`joint-upgrade-peer-installation.test.mjs`、`doctor-pi-peer-runtime.test.mjs:88` | 同源constructor/function与runner；目标bundle真正加载后才能认通过。源码静态共key不足。 |

必要的后续验证应围绕**拟删除职责**，而不是跑一遍版本号检查：同一合法输入下新旧观察、失败、session switch/reload、旧回调、缺失/错误快照、消息原文、proof/owner及资源释放事实；对于UI替换，还要明确用户接受的延迟、有限snapshot与详情损失。当前授权禁止运行这些验证，因此不把任何候选升格为“已证明可删”。

## 静态调查记录与风险

实际动作：read读取规范/报告/源码，`rg --files`定位相关模块与既有检查，`rg -n`/grep定位生产和测试消费者，`git status --short`与`git diff --cached --name-only`检查工作区/index。未执行任何待测项目代码；工具文本检索无命中只作为限定范围负证据。曾按泛称查找`src/scheduler`，现场实际为`src/task-scheduler`，已按实际路径补查，没有据缺路径推断能力不存在。

进入任务时仅有四份既有未跟踪文档：两份研究报告、升级计划、首审记录；本轮不改它们。交付增加本报告，Git index未暂存。测试新增/修改数0、测试运行数0、生产变更数0。

主要剩余风险：

- 目标只读发布包未在候选Host加载，bundle realm、实际child provider绑定、schema行为、required ACK均未执行验证。
- jobsChanged晚于底层文件变化、有限snapshot和无session字段，可能使简单替换漏历史或降低实时性；footer timer还承担详情刷新。
- 直接改用Fleet会删除产品体验与状态区分，桥接量可能抵消删减；必须先明确取舍而非承诺净行数。
- 历史factory/legacy proof reader只见测试消费者，不等于已获删除历史fixture/内部合同授权；未接线durable库也不能连带删除活跃共享存储。
- 上游autoResume/retention与本仓owner/queue/proof事实不是同一权威；没有运行证明安全性，保持现有边界。

对用户问题的回答是：**有局部、可选的瘦身机会，最集中在重复观察与显示；核心资源和权限runtime目前没有被新版本整体取代。先利用已经原生拥有的机制减少重复采集，才有机会在不重建另一套适配层的前提下获得真实净删减。**
