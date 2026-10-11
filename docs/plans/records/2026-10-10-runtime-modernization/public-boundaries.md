# M11：Pi 1.0.4 公开边界保留账本与 delivered 阻塞契约

> 归属：`docs/plans/2026-10-10-pi104-runtime-modernization.md` M11（dispatch-c8df67eb）。
> 性质：只读静态取证账本；本任务仅创建本文件，不修改协议、源码、计划或安装包。
> 引用缩写：**H** = `node_modules/@earendil-works/pi-coding-agent@1.0.4`（只读 declarations/docs）；**P** = `packages/pi-subagents-enhanced/node_modules/pi-subagents@0.75.0`（只读 declarations/实现）；**R** = 仓库根；**E** = `packages/pi-subagents-enhanced`。

## 0. 证据边界与硬约束

- 本账本全部结论来自**静态证据**：已安装 1.0.4 包的 declarations/官方 docs、pi-subagents 0.75.0 的 declarations/实现、本仓当前工作区源码。未运行 Host/CLI/RPC/TUI/PTY/provider/model/child/测试/typecheck；未读取真实 settings/auth/models/会话/workspace authority 数据；未读取秘密与凭据。
- **不修改 node_modules**：H 与 P 均为只读取证，不打补丁、不覆盖、不重装。
- **不加轮询、不加私有 IPC、不加第二 sender/owner/broker**：delivered 一节按"上游公开转发"为唯一路径记录，缺失即如实标为阻塞，不以本地轮询 events.jsonl、私有通道或重复发送冒充。
- 不提交 upstream issue/PR：是否推动上游属用户另行决策，本账本只记录契约与阻塞。
- 本文件不是实施建议书：凡无已证等价或未获授权的事项，一律记录"保持现状"，不新增超出计划的实现任务。

## 1. 生命周期审计"缺包路径"复核（纠正记录）

生命周期审计(`/tmp/pi104-runtime-modernization-lifecycle.md`,run `97d0baee-0785-44ca-adc1-0f6d9499c201`)曾声明"当前工作区没有 `node_modules/@earendil-works/pi-coding-agent`,因此不能从已安装 1.0.4 直接复核 ExtensionAPI 完整声明"。M00 基线与本任务现场复核证明该路径在 M00 时点与本任务时点均在位（审计运行时点是否缺失、还是解析失败，无法回溯判定，不作断言），该审计的部分“证据缺口”已被现场证据闭合：

| 审计原陈述 | 现场复核（本任务静态读取） |
| --- | --- |
| "当前工作区没有 `node_modules/@earendil-works/pi-coding-agent`" | 存在且为 1.0.4：`H/package.json`（`"version": "1.0.4"`）；exports map 为 `[".", "./rpc-entry", "./client", "./experimental/plugin"]` |
| 无法复核 ExtensionAPI 完整声明 | `H/dist/core/extensions/types.d.ts` 可读：`:501` `ToolRenderers`、`:506` `ToolRendererResolver`、`:1221` `registerToolRenderer(resolver: ToolRendererResolver): void`、`:1152-1169` 各 `pi.on(event, handler)` 签名返回 `() => void`、`:1586` `trackEventBusSubscription` |
| 根 `docs/extensions.md`/`docs/sdk.md` 不存在 | 仓库根 `docs/extensions.md`、`docs/sdk.md` 确实不存在；但**已安装包内** `H/docs/extensions.md`（约 19.6KB）、`H/docs/sdk.md`、`H/docs/settings.md`、`H/docs/tui.md`、`H/docs/skills.md`、`H/docs/packages.md` 均存在。审计对"仓库根缺文件"的陈述成立，对"官方文档不可用"的推断不成立 |
| systemPromptOptions 1.0.4 完整 Host 类型是证据缺口 | 已缓解：`H/dist/index.d.ts` 根导出含 `BeforeAgentStartEventResult`、`BuildSystemPromptOptions`、`NormalizedBuildSystemPromptOptions`（extensions 导出行）；0.75 侧 `P/src/extension/index.js:673-683` 实证 `event.systemPromptOptions.sections` 写法。sections 的 merge/持久语义仍属静态推断，见 §5.1 |

其余纠正沿用 M00 baseline（`docs/plans/records/2026-10-10-runtime-modernization/baseline.json` 的 `publicApiEvidence`）：根导出含 `create*ToolDefinition`、`withFileMutationQueue`、`SettingsManager`；安装包 `README.md` 与 `docs/extensions.md` 已完整读取。

## 2. 当前已接线的公开生命周期接口（现状记录）

M11 契约要求"记录当前已有 unsubscribe/required/RPC/extensionBindings，未发现重复机械代码则不强造重构任务"。以下为静态核实的现状；四类接口均已在位，本任务**不新增** disposable/codec 框架，不自动删除跨 reload debt。

### 2.1 unsubscribe（`pi.on` / `pi.events.on` 返回值）

- 公开签名：`H/dist/core/extensions/types.d.ts:1152-1169+`，`on(event, handler): () => void`；`:81` input 监听、`:1586` `trackEventBusSubscription` 同样以 unsubscribe 函数为合同。
- 本仓消费现状：
  - `E/extensions/subagent-runtime.ts:385` `const unsubscribeConsumption = pi.events.on("subagent:process-terminal", observeConsumption)`，`:401` 在 dispose 数组中调用；
  - `E/src/tui/completion-notices.ts:16-18` `offStart/offShutdown/offMessage` 三个 unsubscribe，`:44-52` `dispose()` 幂等注销；
  - `E/src/subagent-dispatch/extension.ts:1808` `deferredEventSubscriptions` 收集带 generation 的订阅项，`:1871` 入列、`:1880` 批量取消、`:1998` 在 dispose 条目中统一 `entry.cancelled = true; entry.unsubscribe?.()`、`:2028` 重载恢复时同样清理。
- 结论：进程内普通 listener 已有显式 unsubscribe 通道，且 completion-notices 已是"session 作用域去重 + dispose"的现成模板（供将来 delivered 转发消费复用，见 §4.5）。

### 2.2 required child extensions

- 公开 API：`P/src/api/required-child-extensions.d.ts:1` re-export 自 `P/src/shared/required-child-extensions.d.ts:1-34`：`snapshotRequiredChildExtensions` / `registerRequiredChildExtensions`（返回 `RequiredChildExtensionRegistration { dispose(): void }`）/ `resolveRequiredChildExtensions` / `assertRequiredChildExtensionsAdmitted` / `hasMandatoryRequiredChildExtensions` / `writeRetainedRequiredChildExtensions` / `readRetainedRequiredChildExtensions`；`requireForAllRunners` 在 registration 顶层打标。
- 本仓消费现状：`E/src/subagent-dispatch/extension.ts:24` 从 `pi-subagents/required-child-extensions` 导入（符合 package `AGENTS.md` 的 compat 入口约束路径），`:1729-1735` 注册 required 快照（`requireForAllRunners` 为 registration 顶层 flag，注释明确防同 session 重复注册）；`E/src/subagent-dispatch/workflow-spawn.ts:56` 的字段 allowlist 含 `subagentOnlyExtensions`、`extensionBindings`。
- 结论：required 快照是 Host admission/persistence 事实，不是 runtime 授权（见 §3.5），当前使用方向正确，无需新 registry。

### 2.3 typed RPC（v1 envelope）

- 公开合同：`P/src/extension/rpc.d.ts:5-11` `SUBAGENT_RPC_PROTOCOL_VERSION = 1`、request/ready/reply 事件名、`SUBAGENT_RPC_METHODS = ["ping","status","manage","spawn","steer","interrupt","stop","resume","cost"]`；`:56-67` `SubagentRpcFleetStatus`；`:67-84` `RegisterSubagentRpcBridgeOptions` 与 `registerSubagentRpcBridge(options): { emitReady, dispose }`（`:80`）。
- 本仓消费现状：`E/src/subagent-dispatch/rpc-client.ts:19` `CONTROL_METHODS = ["steer","nonRecoveringSteer","interrupt","stop","resume"]`（受控子集），`:152` requestId 校验 `^[A-Za-z0-9._-]{1,160}$`，`:196` `pending` Map 防重入，`:217-219` 每请求 timeout Promise，reply 校验与诊断 sink 内建。
- 结论：本仓 typed client 的 requestId/timeout/reply validation 与 0.75 公开 wire contract 对齐，属必要自有 facade（上游 reply details 不承载本仓 rootSession/ownerGeneration/grant/terminal-proof 语义，见 §3.5）；同名方法不等于授权，不得以 public RPC 替代 root broker。

### 2.4 extensionBindings

- 公开合同：`P/src/api/preflight.d.ts:42` `extensionBindings?: ExtensionBindings`（preflight 字段）。
- 本仓消费现状：`E/src/subagent-dispatch/extension.ts:359` 为 worktree root 注入 `extensionBindings: { 'pi-config.root/1': { rootSessionId } }`；`E/src/subagent-dispatch/workflow-spawn.ts:56` allowlist 收口；child 侧 `E/src/subagent-dispatch/child-broker-binding.ts:9-10` 仅把 binding 当**locator**，仍需自身 birth + authority receipt + lease + grant 验证（见 §3.4）。
- 结论：`extensionBindings` 只传 JSON 绑定，不能替代 child-broker 身份验证；binding 可被错误声明不等于真实 grant。现状使用方向正确。

### 2.5 小结：无未消化的重复机械代码

对照生命周期审计候选 5/6/7/8：本仓已用 `pi.on` 返回的 unsubscribe（§2.1）、已用公开 required registration（§2.2）、RPC wire 已对齐 0.75 v1 合同（§2.3）、`extensionBindings` 已走 preflight 字段（§2.4）。**本任务未发现"重复机械代码必须收敛"的新证据**，因此按计划不创建新的 disposable/codec 框架，不自动删除 `globalThis` debt lane（该 lane 不是普通 listener debt，见 §3.8）。

## 3. 本仓不可替代权威边界（保留清单）

以下事实由本仓实际 owner 持有，**公共 event 订阅成功、`sendMessage` 成功、completion title、TUI 投影均不能替代**。每项附当前源码出处与保留理由。

### 3.1 shell early guard（启动前安全门）

- 出处：`R/scripts/pi-launcher.zsh:1-95`——`:5-16` 物理 Node/版本（>=22.19）检查、`assert-session-tool-policy.ts` 工具策略门、`resolve-physical-pi.ts` 物理二进制解析；`:20-27` 私有 decision dir（0600/0700 + 同 EUID 校验，`:33-68` `private_file/private_directory/private_text`）；`:92-94` 注入 `PI_SESSION_OWNER_ID`/registry；`:95` 最后才 `exec` 物理 CLI 并挂 session-owner extension。
- 运维边界：`R/docs/session-owner.md`——绕过 wrapper 的直接启动不登记 owner、不提供切换保护，是明确 unsupported 边界。
- 保留理由：Host `session_before_switch` 事件发生在进程已启动之后；exec 前的路径/身份/工具策略校验不可由任何 Host event 替代。保留，不迁事件化。

### 3.2 公开 `SessionManager.list/listAll`（launch classification 事实源）

- 出处：`H/dist/core/session-manager.d.ts:408` `static list(cwd, sessionDir?, onProgress?, signal?)`、`:413-414` `static listAll(...)`。
- 本仓消费：`R/src/session-owner/contract.ts:149-155` `loadPublicSessionManager` 只接受带 `SessionManager.list` 的模块，`:21` `listAll?` 签名，`:231,242` 消费 `listAll`。
- 保留理由：会话清单/归属判定使用公开 SessionManager，不 deep import private dist CLI args；这是公开接口的正确消费面，保留。

### 3.3 physical peers（同源物理部署绑定）

- 出处：`E/src/host-runtime/index.ts:5-22` `resolvePhysicalHost`——realpath + X_OK + `pi-coding-agent@1.0.4` 身份 + `pi-agent-core/pi-ai/pi-tui` 三 peer 逐一验 1.0.4 + `PI_REAL_BIN`/`PI_PACKAGE_DIR` 回读校验；`E/src/host-runtime/peer-installation.ts:6-48` `bindPhysicalHostPeers`——四个 Pi peer 只以 symlink 物理绑定到已验证 host root，含 uid 边界、备份回滚与绑定后 realpath 复验。
- 保留理由：跨进程身份一致性的物理前提；不切换 ambient/native resolver、不改默认 bundle、不删除 peer binding。双 process identity 未经 fresh probe 重新证明前保持现状。

### 3.4 RootBroker / AuthorityStore / lease / grant / processBirth

- 出处：`E/src/subagent-dispatch/child-broker-binding.ts:1-34`——locator 只寻找现有 authority（`AuthorityStore`，import 于 `:3`，出处 `E/src/subagent-dispatch/authority-store.ts`）；`:11-15` 校验 `PI_SUBAGENT_EXTENSION_BINDINGS['pi-config.root/1']`、workspace dir 绝对路径后 `captureProcessBirthIdentity(process.pid)`（`E/src/subagent-dispatch/process-birth-identity.ts`）；`:17-27` receipt 唯一性、lease 四元组（rootSessionId/runId/ownerGeneration/processBirth）+ 未过期校验、`readBrokerGrant`（`E/src/subagent-dispatch/root-broker-protocol.ts`）要求 `root.subscribe` capability；`:30-33` deadline 内未就绪即抛错（fail-closed）。
- child 侧持有：`E/child-extensions/root-session-owner.ts:22-53`（session_start 装配 / session_shutdown dispose）、`:53-130` `installRootSessionOwner`——`:66` `createClient({..., requiredCapability: "root.subscribe"})`、`:74-86` 终止原因只允许 `authority_lease_expired | explicit_stop | subscription_eof` 并 `SIGTERM` 自身、`:114-117` `GRANT_NOT_READY` 限时重试、`:104-118` lease.updated 单调收敛、`:121-122` 到期/EOF 终止。recovery push 只作 durable 观察，不唤醒模型（`:113-117` 注释）。
- 保留理由：进程 birth（非 PID 简化）、authority receipt、lease generation、grant capability 是跨进程、跨 reload 的身份与授权事实；`session_start`/`session_shutdown`/unsubscribe 只是生命周期通知，均不构成这些事实。不可替代，保留。

### 3.5 required 快照 ≠ runtime 授权（边界重复声明）

`P/src/shared/required-child-extensions.d.ts:1-34` 的 snapshot/register/resolve/admit/retained 只保证 required extension 的 admission 与持久化；`extensionBindings` 只传 JSON。它们不能替代 §3.4 的 birth/lease/grant 三重核验，也不能把 root ownership 并入通用 upstream subagent runtime。公共 `status/stop/resume` RPC（§2.3）仅是动作/观察 API。保留自有 validation/facade。

### 3.6 terminal proof

- 出处：`E/src/subagent-dispatch/terminal-proof-binding.ts:1-19+`——`TerminalProofBindingDeps`（`client.recordTerminalProof`、`proofOutbox.recordDebt/enqueue`、`readLedger`）、`classifyTerminalProofBinding` 按 binding 分类 proof 债务；配套 `E/src/subagent-dispatch/coordinator-proof-outbox.ts`（proof outbox）。
- 保留理由：终态证明是持久化账本事实；UI 回执、notify、spawn/status 观察都不是 terminal proof。不可替代，保留。

### 3.7 integration queue 与 supervisor correlation/consumption

- integration queue：`E/child-extensions/integration-queue.ts:1-80+`——`:1` 八个受控 action（enqueue/await_admission/report_conflict/publish/fail/inspect_integration_state/prepare_auto_integration/inspect_auto_integration）、`:14` `queue_lease_id` 必填、`:25` generation/attempts/terminal GuardRecord、`:68` 超时 fail-closed（由 preserve/proof 循环收敛）；durable 队列本体在 `E/src/workspace/integration-queue.ts`（workspace service 唯一 owner，见 package `AGENTS.md` Workspace 所有权边界）。无等价 Pi session event：用 session event 代 queue event 会丢跨进程恢复、FIFO、generation、proof debt、fail-closed preserve。不可替代，保留。
- supervisor correlation/consumption：`E/src/subagent-dispatch/supervisor-consumption.ts:95-101`——消费前逐字段校验 correlation（sessionFile/childSessionId/toolCallId/reason/agent/requestBodyDigest + 时间窗 `createdAt..observedAt`），`:100-101` 仅 `committed` 或 `idempotent && receipt.consumed === true` 计为 observed，否则 diagnosticSink 记 rejected；adapter 侧 `E/src/subagent-dispatch/supervisor-adapter.ts:21-28` `createSupervisorAdapter().bind()` 单次绑定受控 execute target。`sendMessage` 成功不是 child consumed 证明；upstream `spawn/status/steer` 无本仓 request correlation/consumption receipt 语义。不可替代，保留。

### 3.8 跨 reload debt（globalThis cleanup lane）

- 出处：`E/src/subagent-dispatch/extension.ts:1445,1485`（cleanupStore 可注入 globalThis）、`:1804,1824-1827`（title registry 与 cleanup store 默认挂 globalThis）、`:1808-1880,1998,2028`（deferredEventSubscriptions 的入列/取消/dispose/恢复清理）、`:1950`（`forceCompletionDisplay: true` completion 门）、`:1254-1256`（title 跨 runId resume 迁移：`titleFor`/`agentFor` 只读查询 + `remember`）。
- 性质：reload 会替换 ExtensionAPI 但 SessionManager/globalThis lane 稳定；未完成 debt 必须先偿还再允许新 generation。unsubscribe 只能清理本代 listener（§2.1），不能恢复 transitioning record、跨进程 owner、drain/proof 顺序。
- 保留理由：这是 durable debt 而非重复机械代码；保留，不自动删、不强造 disposable 框架。

## 4. delivered：最小上游公开化需求与当前阻塞

### 4.1 delivered 的精确定义

delivered = **child 会话已消费**该 steer（child 自身事件流出现 `message_end` 且 `role === "user"`、文本与 acceptedSteers 精确 FIFO 匹配）。它不等于 provider 远端已理解，更不等于 RPC steer 的 queued ack。数据源为上游 runner 状态：`P/src/runs/background/control-channel.d.ts:45` `SteerDeliveryStatus = "delivered" | "queued"`；`P/src/runs/background/subagent-runner.js:2644` 以 recovery marker（`:2533` `steeringMarkerPath`）判定 late；`P/src/runs/background/steering.js:86-89` 在状态工件写 `deliveredAt/lateDeliveredAt`。

### 4.2 events.jsonl delivered 行已有字段（上游已产生、主进程未转发）

写入点：`P/src/runs/background/subagent-runner.js:2540-2542` `emitSteeringEvent` 行 schema `{ type, ts: Date.now(), runId, requestId, ...(index !== undefined ? { index } : {}), ...extra }`；`:2648` delivered 行 extra `{ late, deliveryStatus: "delivered", message }`。即 delivered 行字段为：

```
type="subagent.steer.delivered", ts, runId, requestId, index, late, deliveryStatus="delivered", message
```

行内**不含** agent/title/intercomTarget/source：agent 可由 status artifact `steps[index].agent` 或本仓 title-registry（`E/src/subagent-dispatch/title-registry.ts:19` `createTitleRegistry`，`:104` `getTitleRegistry`；消费示例 `E/src/subagent-dispatch/extension.ts:1254-1256`）补齐；title 查询按 TUI 显示层只读消费（`E/src/tui/compact-rendering.ts` 现状保留）。

### 4.3 最小公开化需求（作为上游转发契约，不是本仓实现）

把上游 async-job-tracker（`P/src/extension/index.js:421` 装配，tail 各 job 的 `events.jsonl`）在解析到 `subagent.steer.delivered` 行时，向主 Host 公共 bus（`pi.events`）转发一条事件，最小 payload = 解析行原字段（`runId/requestId/index/ts/late/deliveryStatus/message`）+ `asyncDir`（来自 `job.asyncDir`，与 child-status/steering-notice 转发同源）+ `source`，并按 `state.currentSessionId` 做父会话归属门禁（与 steering-notice 的既有门禁同模式，见 `P/src/runs/background/async-job-tracker.js:309-310`）。零新增轮询——tracker 已在 tail，仅差转发一行。

### 4.4 当前阻塞（硬接口缺口，阻塞、未实现）

- **tracker 白名单丢弃 delivered 行**：`P/src/runs/background/async-job-tracker.js:264-331` `handleLine` 仅转发 `subagent.child-status`（`:277`）、`subagent.steering.notice` 且 state 限 `failed|partial|recovered`（`:305-309`）、`subagent.control`（`:325` 起）；`:325-326` `if (parsed.type !== "subagent.control") return;` 把 delivered 行**解析后静默丢弃**。`P/src/extension/steering-notices.js:9-15` 的消费侧同样只处理 failed/partial/recovered。
- **无现有公开订阅通道**：`P/src/extension/rpc.d.ts:11` 方法集无 subscribe；control-channel（`P/src/api/control-channel.d.ts`、`P/src/runs/background/control-channel.d.ts`）是纯文件投递 helper，无订阅 API。本仓 `rpc-client.ts:19` 的 CONTROL_METHODS 亦无订阅方法。
- **结论：主 Host 公共 bus 当前不存在 delivered 事件。repo-only 在不新增轮询/私有 IPC/新 authority 的前提下无法订阅 delivered——阻塞、未实现。** 本计划完成不要求本地虚构 delivered 可见性；queued 回执不得冒充 delivered；用户所见 "steering 1 delivered" 来自 runner status artifact 的 steering 计数，不是主会话事件。

### 4.5 TUI 侧消费形态（仅在上游转发落地后适用）

消费模板已就位：`E/src/tui/completion-notices.ts:16-18,44-52`（session 作用域 WeakMap 去重 + `dispose()`）+ `E/extensions/subagent-runtime.ts:385,401`（`pi.events.on` unsubscribe 进 dispose）。落地形态为：subscribe 转发事件 → `ctx.ui.notify(text, "info")`（TUI 瞬时 dim 状态行）→ 按 `runId+requestId(+index)` 去重与清理 → title 用显示层只读 lookup（`compact-rendering.ts` / `title-registry`）→ **不加模型消息**（不 `sendMessage`、不 `appendEntry`、不改 raw payload/display/details）。该形态在本计划内**不实施**，仅作为阻塞解除后的最小契约记录。

### 4.6 约束重申

- 不打 node_modules 补丁、不 fork 安装包；是否推动上游（升级/issue/PR）属用户另行决策。
- 不加轮询（含对 events.jsonl 的额外 tail）、不加私有 IPC、不加第二 sender/owner。
- 现有 `E/src/tui/completion-notices.ts` 的 completion notify 与 title 展示维持现状，不在本轮扩展为 delivered 通道。

## 5. 推迟项（无已证等价，保持现状）

| 推迟项 | 静态证据 | 处理结论 |
| --- | --- | --- |
| GLOBAL/SHARED structured sections | 本仓为字符串 append：`R/src/agents-global/index.ts:83-110`、`R/src/agents-shared/index.ts:96-124`（每次 input 快照 + `before_agent_start` 拼 `systemPrompt`）。上游 0.75 证明 sections 写法：`P/src/extension/index.js:673-683`（`systemPromptOptions.sections.advertised_subagents`，每轮重建、未设即 removal）；child 侧 `P/src/runs/shared/subagent-prompt-runtime.js:548-575` 依据继承策略返回 `{systemPrompt}` 重写 | **推迟**：required extension 与 child forced-system hook 的注册顺序、sections 送模/持久语义未经证据闭合；GLOBAL/SHARED 保留 base+append 注入与缺失门禁，不把安全规则降级为普通展示 section。child forced hook 顺序需补充证据后再议 |
| 原生 skill 外观（去 private patch） | `R/pi/extensions/compact-tools.ts:15,128-132` 与 `R/src/compact-tools/renderer.ts:5,90-95` 以 `Symbol.for("pi-config.compact-skill-renderer")` patch `SkillInvocationMessageComponent.prototype.updateDisplay`；H declarations（`H/dist/modes/interactive/components/skill-invocation-message.d.ts`）标注这些字段为 private；`registerMarkdownTransformer`（`H/dist/core/extensions/types.d.ts:1125-1135,1215-1219`）不进入 skill 专用组件 | **推迟**：无完全等价公开替代（原 patch 去背景/padding、改 label/展开并替换 MouseRegion）；保持已接受外观并保留 private coupling 记录。是否恢复原生外观属产品决策，另行确认后才删 patch |
| ScrollView / normalized mouse / 组件树互动 | `E/src/tui/session-viewport.ts:1-149` 当前自研 viewport（底部保留行/顶部补空/确认行语义）；`H/dist/components/scroll-view.d.ts` 的 ScrollView 依赖 layout/updateLayout，非 drop-in | **推迟**：本轮不重造 viewport、不改变 Option+O thinking 默认；normalized `handleMouse`/ScrollView 列为后续可选项，不宣称恢复全部点击 |
| Codex-only 代理收敛为全局 httpProxy | `R/pi/extensions/openai-codex-proxy.ts:6-42,78-105` 推断 Host undici 路径、覆写 provider stream、注入 fetch/env；`H/docs/settings.md` 有 `httpProxy` 设置 | **推迟**：作用域不同——全局代理会改变其他 Pi-managed HTTP 流量，强制 SSE/自定义 fetch 不等价"只设 URL"；bundle 内 httpProxy 消费链与 OAuth/WS 覆盖未验证。保留现有 Codex-only adapter |
| 通用 SettingsManager 替换 ensure 事务 | `H/dist/core/settings-manager.d.ts:194,196,227,228,290,317,320`（`create/fromStorage/flush/drainErrors/setHideThinkingBlock/setPackages/setExtensionPaths`）；grep 确认无 `setDefaultTools`、无任意 extension-owned 字段 setter；`FileSettingsStorage` 未从 package 根公开 | **推迟**：模板/本机字段 owner 合并策略仍由本仓维护（M02 已按计划实施）；SettingsManager 仅在有公开 setter 且不破坏单次 owner 合并时复用，本轮不做通用替换，不 deep import 内部存储 |

## 6. 静态证据与未验证范围

### 6.1 本任务已静态核实的证据（可直接复核）

1. H 1.0.4 在位：`H/package.json` version/exports；`H/dist/index.d.ts` 根导出（`registerToolRenderer` 类型、`SessionManager`、`SettingsManager`、`create*ToolDefinition`、`withFileMutationQueue`、`BeforeAgentStartEventResult` 等）。
2. 关键 declarations：`H/dist/core/extensions/types.d.ts:501,506,1221,1152-1169,1586`；`H/dist/core/session-manager.d.ts:408,413-414`；`H/dist/core/tools/bash.d.ts:69,80`；`H/dist/core/tools/file-mutation-queue.d.ts:6`；`H/dist/core/settings-manager.d.ts:194-320`（无 `setDefaultTools`）。
3. 官方 docs 在位：`H/docs/{extensions,sdk,settings,tui,skills,packages,...}.md`。
4. 上游 0.75.0：`P/src/extension/rpc.d.ts`、`P/src/shared/required-child-extensions.d.ts`、`P/src/api/preflight.d.ts:42`、`P/src/runs/background/async-job-tracker.js:264-331`、`P/src/runs/background/subagent-runner.js:2533,2540-2542,2644,2648`、`P/src/runs/background/steering.js:86-89`、`P/src/runs/background/control-channel.d.ts:45-54`、`P/src/extension/steering-notices.js`。
5. 本仓权威文件：§3 全部 `file:line` 引用（工作区当前状态；其中 `E/src/subagent-dispatch/runtime-membrane.ts`、`title-registry.ts`、`E/src/tui/compact-rendering.ts` 为既有 dirty 修复，引用以现场为准，membrane 的 title 装饰已收敛为只读 title registry 消费，见 `E/src/subagent-dispatch/runtime-membrane.ts:25-43` 注释与实现）。

### 6.2 未验证范围（本任务不做、不宣称）

- 未运行任何 Host/CLI/RPC/TUI/PTY/provider/model/child/测试/typecheck；全部行为语义（lease 到期终止、integration queue fail-closed 收敛、delivered 匹配、UI notify 呈现等）仅为源码级结论。
- 未读取真实 `pi/settings.json`、`pi/models.json`、auth、会话文件、workspace authority/root-broker 持久化数据；§3 的权威机制只引用实现，不引用其真实运行数据。
- `pi.events` 公共 bus 的运行时事件顺序、extension 装配顺序、reload 后 ExtensionAPI 替换的现场行为未验证。
- delivered 上游转发的可行性（tracker `CONTROL_EVENT_SCAN_WINDOW_BYTES` 对久远行的覆盖等）未实测；本账本仅记录"当前无公开通道"这一静态事实。
- 是否推动上游（0.75 白名单转发）为用户另行决策项；本计划内 delivered 保持**阻塞、未实现**。
