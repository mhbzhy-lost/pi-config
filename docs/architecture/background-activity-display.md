# 统一后台活动区（TUI footer）显示架构

**范围：** 左下角「一切后台活动任务」显示区、统一只读详情壳、唯一 footer/Alt+O owner、跨入口 bus 握手与生命周期。
**状态：** 代码/集成/typecheck/verify 已实证；2026-10-16 Inline 完成真实 TUI 八场景 L2 机器验收（8/8），L3 观感仍待用户确认。最新证据见 `docs/plans/records/2026-10-15-runtime-closeout/visual-acceptance.md`，旧 F6v 历史不覆写。
**不承诺：** 本层不是任务权威、不是调度器、不是恢复引擎；下列「明确不支持/不保证」是合同的一部分。

本文只描述现场代码事实（文件+函数名为证据锚点），不引入任何行为承诺超出实现的能力。

---

## 1. 公开入口与依赖方向

| 入口 | 位置 | 只承担 |
| --- | --- | --- |
| package 公开 TUI 出口 | `packages/pi-subagents-enhanced/package.json` 的 `exports["./tui/background-activity"]` → `packages/pi-subagents-enhanced/src/tui/index.ts` | 公共显示协议/registry（`packages/pi-subagents-enhanced/src/tui/background-activity.ts`）+ subagent provider 工厂（`packages/pi-subagents-enhanced/src/tui/subagent-activity.ts`） |
| package footer 薄 Host 入口 | `packages/pi-subagents-enhanced/extensions/custom-footer.ts` | 注入 SDK/TUI 依赖 + 唯一 Alt+O 注册；不含领域状态 |
| package footer runtime（唯一 owner） | `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts` | 唯一 `ctx.ui.setFooter` 安装、owner/bus 握手、registry 持有、subagent 自有 source、standalone fallback、Alt+O 委托 |
| 根显示 feature 公开入口 | `src/background-activity/index.ts` | re-export package 协议 + `layout.ts` + `detail-controller.ts` + `presenter.ts`；不重复实现 registry |
| 根 presenter 发布入口 | `pi/extensions/background-activity.ts` | 只在 Host 内存 bus 发布 presenter factory；不调 `setFooter`、不注册快捷键 |
| bash_async source/publisher | `src/bash-async/index.ts`（`createBashAsyncActivitySource`/`createBashAsyncActivityPublisher`），Host 接线 `pi/extensions/bash-cwd.ts` | 只读观察 controller；不碰执行/取消/发送 |
| scheduler source/publisher | `src/task-scheduler/index.ts` 导出 `src/task-scheduler/activity-source.ts`（`createSchedulerActivitySource`/`createSchedulerActivityPublisher`），Host 接线 `pi/extensions/task-scheduler.ts` | 只读消费 adapter observer；不持有世代 token |

依赖方向（现场 grep 事实）：

- 根与独立消费者一律用 bare specifier `pi-subagents-enhanced/tui/background-activity`，不深引 package `src/`。
- package 不反向依赖仓库根源码（`packages/pi-subagents-enhanced/{extensions,src,child-extensions,scripts}` 内无指向根 `src/`、`pi/` 的 import），因此 package 可独立部署。
- 根 `src/background-activity/*` 不深引 package 内部（browser/renderer/session-viewport），只经上述 bare 出口消费协议。

## 2. 唯一 footer owner 与 Alt+O

- 本仓受管扩展代码内实际 `ctx.ui.setFooter` 调用点只在 `footer-runtime.ts` 的 `installFooter`：standalone 分支与 presenter 薄壳包装分支各一处；`installedFooterMarker` 按视图身份幂等，同视图不重复安装。
- 本仓受管扩展代码内唯一 `pi.registerShortcut` 用于 Alt+O 的调用点在 `extensions/custom-footer.ts`（`Key.alt("o")`，description `Open subagent browser`；`var/upstream` 上游副本与 SDK examples 不计入）。因 SDK 无 shortcut unregister，handler 按当代闭包委托 `runtime.openBrowser(shortcutCtx)`：先校验快捷键上下文 `sessionManager` 与当前 ctx 相同，再在挂载了统一 presenter 时调 `view.openDetails()`，否则保持迁移前的 standalone browser 行为。
- 根 presenter 只返回 `MountedActivityView{createFooter, openDetails, dispose}`；`src/background-activity/presenter.ts`、`layout.ts`、根 entry 都不调用 `setFooter`/`registerShortcut`。因此不存在「扩展加载顺序 last-wins」协调。
- presenter 包装壳只做两件事：捕获当代 SDK theme/markdown theme 供 package 自有 trusted native 详情渲染、转发生命周期钩子；不改写视图渲染语义。

### standalone fallback

`startOwnerEpoch` 前 runtime 先备好 `standaloneFooterFactory`。以下情形回落 package 自有 subagent footer（迁移前行为，不加载根源码）：

- 根 presenter 未发布（例如 SDK 目录发现未加载 `pi/extensions/background-activity.ts`：`--no-extensions` 时自动发现与 settings packages 均不加载，只有显式 `-e` 源生效；此时若以显式 `-e` 加载 package footer 入口，footer 仍独立可用）；
- factory 抛错或返回值不合 `MountedActivityView` 形状（`isMountedActivityView` 校验失败 → `bindings.fallback()`）；
- fallback 本身也不可用时保持当代 standalone footer，不双安装、不向 bus 报错。

正常根 presenter 撤销（`presenter-unregister` 匹配 registrationId）也按既有 UI 状态恢复 standalone，不叠加第二个 footer。

## 3. 根入口的自动发现

`pi/extensions/background-activity.ts` 位于受控 `PI_CODING_AGENT_DIR`（本仓 `scripts/pi-shell.zsh` 固定为 `<repo>/pi`）的 `pi/extensions/` 用户扩展自动发现目录，由 SDK 目录发现加载，无需任何 settings 写入。禁用该 root 入口的受支持边界是 `--no-extensions`（仅 CLI `-e` 显式源加载）；不得以修改 settings 或删除文件达成禁用。

## 4. bus 握手与身份（Host 内存，非 wire 协议）

channel 常量与 payload 形状定义在 `packages/pi-subagents-enhanced/src/tui/background-activity.ts`（`BACKGROUND_ACTIVITY_CHANNELS`）：

| channel | payload | 语义 |
| --- | --- | --- |
| `background-activity:owner-ready` | `{scope, ownerRegistrationId}` | owner 宣布当代身份 |
| `background-activity:owner-request` | `{sessionManager, sessionId, hostKey}` | publisher 请求匹配 owner 重发 ready |
| `background-activity:source-register` | `{scope, registrationId, source}` | source 接入（owner 核对 token/hostKey/manager/sessionId） |
| `background-activity:source-unregister` | `{scope, registrationId, kind}` | exact 撤销：只删同 scope 同 registrationId |
| `background-activity:presenter-register` | `{scope, registrationId, factory}` | 同 registrationId 幂等 |
| `background-activity:presenter-unregister` | `{scope, registrationId}` | 只恢复 standalone，不销毁 owner 整体 |
| `background-activity:owner-close` | `{scope}` | 清当代订阅/视图；不取消真实任务 |

身份三要素 + 世代：

- `HostScope = {sessionManager, sessionId, token, hostKey}`；`hostKey` 取当前 `sessionManager` 对象，`sessionId` 为 manager 逻辑 UUID（`managerSessionIdentity().sessionId`）。
- `token` 是每次 `session_start` 新建的对象（闭包世代），**不是** process-global Symbol，也**不写入事件**。`isSameHostScopeIdentity` 只比 manager/sessionId/hostKey；`isSameHostScope` 额外比 token。
- `registrationId` 由 publisher 在当代 source/factory 创建时经 `createBackgroundActivityRegistrationId()`（`randomUUID()`）生成，重复 ready 复用同 ID；owner 侧同 ID + 同 source/同 factory 幂等，不重复 `setFooter`、不关 overlay、不重置选中项。
- 上游 `subagent:async-started`、`subagent:async-complete`、`subagent:foreground-complete` 三种 payload **都没有 generation 字段**（F0 全量字段核对：`docs/plans/records/2026-10-13-background-activity-ownership.md` §2.4；当代 footer 实际只订阅前两个通道）。因此本层绝不实现「按 `event.generation` 过滤」，旧代失效只由本地闭包 token + SDK 自动退订双层保证。

握手顺序（与加载顺序无关）：

- owner：`session_start`（tui）内先 `busOn` 监听 owner-request/source-register/source-unregister/presenter-register/presenter-unregister 五通道，**再** `busEmit` owner-ready。
- publisher（bash/scheduler/root entry）：先 `on(owner-ready)`，**再** `emit(owner-request)`；只回答 manager/sessionId/hostKey 三要素同时匹配的 ready。
- 缺 manager 逻辑 sessionId → owner fail closed 不握手（仅 standalone）；publisher 缺 sessionId → 不发布 source，且不向 bash/scheduler 执行链路报告失败。
- 新 epoch 的 `session_start` 先 `teardown()`：按「同 scope（含 owner token）+ 旧 registrationId」exact 撤销旧注册再退订本地订阅，避免双注册/双 presenter。

回调退订与 dispose 顺序：

- `pi.events.on` 返回的 unsubscribe 一律保存（owner 存 `epoch.busUnsubscribes`，publisher 存 `unsubscribeReady`，root entry 另存 `unsubscribeClose`）。
- `teardownOwner`：先把 `ownerEpoch` 置空并 `epoch.closed = true`（token 失效，此后 late register/unregister/detail/poll 一律不匹配）→ 逐个退订 bus → dispose presenter view（关 overlay、恢复 draft/editor）→ 逐个 dispose source 注册 → dispose 自有 subagent 注册 → `registry.dispose()` → 最后 emit `owner-close`。全程只清展示层，不取消任务、不重置 controller、不发消息。
- registry 内部：`register` 返回的 dispose 先比对当前 handle 身份（旧 dispose 不删新注册）；订阅回调按 handle fence，被同 kind 替换或已注销注册的 late invalidate 无效果；`dispose()` 幂等，关闭后 late register/invalidate 无效果。

## 5. 三个 source 的事实边界

### 5.1 类型图标与顺序（纯显示，不是事实判定）

`src/background-activity/layout.ts`：`ACTIVITY_KIND_GLYPHS = {subagent:"●", bash_async:"⌘", scheduler:"⏱"}`，未知 kind 渲染 `◇`；`RECENT_GLYPH = "◯"` 只是 recent 汇总行图标，不是任务类型、不可选中。图标只表类型，成功/失败一律由独立 `stateLabel` 文字表。行顺序固定 `ACTIVITY_KIND_ORDER = subagent → bash_async → scheduler`，同类型内保持 source 给定顺序（稳定排序，不按 label 去重）。

### 5.2 row key 与身份（禁止按文案猜身份）

| kind | key 形状 | 生成处 |
| --- | --- | --- |
| subagent | `subagent:<browser canonical key>`（`runId:childIndex`） | `subagentActivityRowKey` |
| bash_async | `bash_async:<jobId>` | `src/bash-async/index.ts` `activityKey` |
| scheduler | `scheduler:<上游任务 id>` | `src/task-scheduler/activity-source.ts` `schedulerActivityKey` |

`registry.sourceFor(key)` 只做精确 key 匹配；detail 侧从 key 反解 id，前缀不符或空 id 一律拒绝，不按标题/label 复活条目。scheduler 归因明确不用 `nextRunAt`/`runCount`/`lastStatus`/触发时间/消息到达顺序猜 task id（`src/task-scheduler/adapter.ts` 固定路由上下文注释）。

### 5.3 状态词表（现场实现值）

- **subagent**（`subagentStateLabel`）：`运行中`（presentation running 或 lifecycle active 分类）、`已完成`（仅结构化完成证据：presentation completed，或 legacy `complete`/`completed` 终态）、`待处置`（`reported`、`needs-context`、legacy `failed`/`rejected` 及任何无法解释的终态）、`受限`（`limited`、legacy `timed-out`）、`已暂停`、`已停止`（`stopped`/`detached`）、`运行失败`（`runtime-failed`）。**unknown/reported 不得显示为已完成**；legacy failed/rejected 无结构化完成元数据时既不推断为故障也不推断为完成。
- **bash_async**：active 行 `stateLabel` 固定 `running`；terminal 行为 `outcome`，且当 `completionDelivery` 不属于 `attempted`/`accepted` 时显式附注为 `<outcome> · <delivery>`（`suppressed-stale`/`suppressed-shutdown`/`suppressed-unsafe-context`/`delivery-error` 因此可见，不推断删除/完成）。outcome 取值沿用 typed 合同：`succeeded`/`failed`/`timed-out`/`aborted`/`spawn-error`/`execution-error`。
- **scheduler**：`等待触发`（无 `lastStatus`，即等待首次触发）、`观察到投递中`（`lastStatus=running`）、`上次投递成功`（`success`）、`上次投递失败`（`error`）、`已禁用`（`enabled=false` 且未观察到投递中）。

语义升级禁止项：`enabled` 表示有计划存在，不表示模型正在执行；`lastStatus=success` 是 runner 投递结果，不证明业务任务成功；它也不是实时 `runningTaskIds`（本期不注入上游 scheduler 实例/hook）。

### 5.4 投递/消费回执（bash_async）

- 启动回执 `bash-async-launch` 只代表**接受任务**，不代表命令成功；`acceptedAt` 只作元数据显示。
- `completionDelivery` 是**回执投递事实**：`accepted` 仅代表 `sendMessage` 调用未抛异常，不代表 Host 已消费、已持久化或最终唤醒成功；公开接口没有消费 ACK，本层不伪造。
- 详情文案显式标注这一点（`delivery: …（回执投递事实；accepted 仅代表发送调用被接受，不代表模型已消费）`）。

### 5.5 无 streaming

bash_async 详情**一次性生成**，`detail()` 不调用 `requestRender`，无新增流式 API：active 详情只有 launch 元数据 + 「无输出流」说明，绝不显示虚构 stdout；terminal 详情才读原 `content` blocks（或 `error` 正文），非文本块以固定计数行说明，不改写 raw 输出。

### 5.6 history 与 current

- subagent：`snapshot.activeChildren → placement "main"`，`snapshot.recentChildren → "recent"`；recent run 预算沿用 browser `RECENT_RUN_LIMIT = 20`（按 root/leaf 连通分量整组淘汰，允许预算少于 20）。
- bash_async：controller `snapshot()` 的 `active → main`、`completed → recent`；终态内存快照最多 64 条（`completed.length > 64` 时 `shift()`），是内存诊断快照，不是持久账本。
- scheduler：`enabled` 或观察到投递中的记录 → `main`；禁用且非投递中 → `recent`（等同「只在详情中显示」）；一次性任务完成后 disabled 记录仍属 scheduler 记录，不误称「删除成功」。
- 主视图 recent 不逐条渲染，只折叠为单行 `◯ recent N`（N 按统一列表 key 去重）；**详情导航覆盖 main+recent 全量**（不受主视图折叠影响），并追加 stale 观察分组。

### 5.7 availability（可用性不占任务身份）

`ActivitySnapshot.availability ∈ available | stale | unavailable`：

- `available` 且 rows 为空 = 当前已确认无任务（主视图不虚构运行任务）。
- `stale` = 查询失败但有上次观察值：source 自报 stale + 原 rows/observedAt。`registry.snapshot()` **排除**非 available 行，因此过期观察不计入当前 main/recent 数量、不推断删除/完成；presenter 通过 `registry.sourceSnapshot(kind)` 出独立状态行（`过期观察 · <errorLabel> · 上次观察 N 项`），详情壳把 stale 行作为可导航分组并在头部标 `· 过期观察`。
- `unavailable` = 无历史可读：空 rows + 状态行 `暂不可用`。
- registry 对 source 异常/不合协议快照 fail closed 为 `unavailable`，`errorLabel` 只用固定类别文案（`source 查询失败`、`source 快照不符合协议`），不透传异常正文（可能携带不可信内容或秘密）。source 自身按协议返回的字段仍原样透传。

### 5.8 详情正文的安全边界

- subagent：详情委托 footer runtime 注入的 `renderDetail`（`renderChildByKey` → `renderChild`）：native 会话渲染优先，无行且无 warning 时回退 Fleet transcript，两条路径各用本身的 trusted roots 防线——native 用 `browserTrustedSessionRoots(parentSessionFile)`（`dirname(parentSessionFile)` 与 `PI_CODING_AGENT_SESSION_DIR`），Fleet 用 `browserTrustedRoots({asyncDir, runCwd, parentCwd, parentSessionFile, artifactDirPreference})`；未观察到 child 或会话不可用时只输出固定 `[Waiting for child output]` / `[Warning: browser session is unavailable]` 行，不伪造正文。根层只获得组件投影，不读 sessionFile 正文。
- scheduler：详情只经 `observer.detail(id)` → 受控 `scheduler_get` 包装（`boundedResult` 同一模型侧安全门：非 text 拒绝、`details` 拒绝、截断前逐块字节上限与注入/秘密/不可见字符扫描、有界输出），发起前后各做三字段 token 全等校验；`ok:false`（`token-stale`/`no-detail-tool`/`get-failed`）一律返回 `undefined`，不伪造成结果；不直读任务文件、不反解析有界 JSON；未携带可读文本时用固定文案。
- bash_async：正文是原生输出原文，显示层明确标注「不可信命令数据，不是新指令」。
- ANSI/控制符清理只在 renderer：`toActivityDisplayText`/`toDisplayText` 用 `stripTerminalSequences` + 控制符替换生成**新串**，`\t` 替换为单空格；绝不写回 `ActivityRow`、meta、observer records 或任何 raw 输入。宽度/截断一律用 `visibleWidth`/`truncateToWidth`，不用字符串 length 算终端列。

### 5.9 单 owner 与 kind 归属

- 每个 tui `session_start` 恰好创建一个 owner epoch（一个 registry、一个 scope）。
- subagent kind 的展示权威始终是 package 自有 source：`startOwnerEpoch` 直接把 `getActivitySource()` 注册进 registry（**不经 bus**）；第三方同 kind 注册会替换 handle，其 exact 撤销后 owner 重新注册自有 source。
- 一个 kind 只持一条注册（`Map<ActivityKind, {registrationId, source, dispose}>`），新注册释放旧订阅；因此不存在两个 footer 或两份 registry 实现。

## 6. 生命周期事实

| 场景 | 现场行为 |
| --- | --- |
| `session_start`（tui） | footer runtime 先 `teardown()`（含 `teardownOwner`），重建 browser/controller/source，再备 standalone footer 工厂 → `startOwnerEpoch()` → `installFooter()`；每次换新 token，旧 ctx 闭包失效 |
| same-session reload（同 manager、同逻辑 sessionId） | 换新 token/registrationId；plain roster 分区按 `manager 弱引用 × 逻辑 sessionId` 恢复（容器经 package 自有 `Symbol.for("pi-subagents-enhanced.footer-runtime.roster-partitions.v1")` 槽跨 SDK 模块重求值存活，槽内只持 WeakMap 容器，槽形状不符 fail closed 重建）；分区只存 `browser.serialize()` 的 plain 行，不存 ctx/callback/组件闭包 |
| new / fork / switch / resume | 新 `SessionManager` 对象 → 天然取空分区；同 sessionId 异 manager 也不继承他人 roster。旧 owner epoch token 失效、bus 退订、`owner-close` 发出，三 source 重新握手 |
| `session_shutdown`（quit/reload/new/resume/fork） | 同上 teardown 顺序；`subagent` 事件订阅、500ms reconcile 轮询、activity listener 全部按代际失效 |
| 事件门禁 | `subagent:async-started`/`async-complete` handler 先比 `owner !== ctx || epoch !== sessionEpoch`（旧闭包 fence），再 `isCurrentSessionEvent(event.sessionId)`（sessionFile/UUID 双形态，缺字段或异身份一律拒绝且不写 roster），最后才 `invalidateFooter/refresh`；不新增第二轮询、不改 poll 频率 |
| RPC / print / json | 本显示链路上 `mode !== "tui"` 门禁现场共 8 处：`footer-runtime.ts` 的 `session_start`、`enterBrowser`、`installFooter`、`startOwnerEpoch`；`pi/extensions/background-activity.ts` 的 root entry；`src/bash-async/index.ts` 与 `src/task-scheduler/activity-source.ts` 的 publisher `onSessionStart`；`src/background-activity/presenter.ts` 的 `openDetails()`。RPC 不安装 footer、不挂 overlay、不换 editor、不做 bus 握手；既有 RPC `pi-scheduler` status（`ui.setStatus` 可用时）、消息投递与执行链路不变 |
| shutdown 期间的展示动作 | late register / late detail / late poll / late invalidate 全部被 token/handle fence 拒绝；bash job 仍 active、无取消、无额外发送 |

## 7. 布局与几何（显示层）

`layout.ts` 常量：`MAIN_VIEW_RESERVED_BOTTOM_ROWS = 6`、`DETAIL_RESERVED_BOTTOM_ROWS = 4`（overlay 静态 `margin.bottom`）、`DETAIL_FOOTER_MAX_ROWS = 3`、`TOO_SMALL_TERMINAL_ROWS = 4`。

主视图行序（`renderActivityLayout`，物理行预算 `max(0, terminalRows-6)`）：

1. `cwd`（左，`$HOME` 缩写为 `~`）/ context 用量（右），放不下则分行；
2. `(provider) model`（左）/ `thinking: <level>`（右），放不下分别换行；
3. 连续活动区按 subagent→bash_async→scheduler 渲染，标题不人为中段截断；
4. 紧预算优先每个非空kind的首个完整block，其余整block让位并计overflow，不留旧空槽；
5. stale/unavailable source 独立状态行；
6. `◯ recent N` 汇总行；
7. 溢出提示行 `还有 N 项 · Alt+O`（N = 预算外 activity 条目数，不含汇总行/状态行；预留最后一行给提示）。

列结构按 closeout F1 修订：col1单cell选择标记、col2起公共glyph列、一个gap，当前标题从col4开始；续行只补相同前缀。全帧main rows共享最长状态列宽并右对齐，标题与状态至少2列间隔；不足时采用stacked状态行。ASCII词边界优先，超宽CJK/路径按公开宽度工具兜底；width<=0空、极窄glyph-only，不承诺一列显示完整身份。元数据和活动区不再左右交错，不保留空activity槽。所有换行只生成显示副本。

详情模式：overlay 静态 `margin.bottom = 4`、`maxHeight 100%`、`row/col = 0`、宽 `100%`，不使用每帧动态 options，resize 由每次 `render` 实时读 `terminal.rows` 计算；正文 `bodyRows = max(0, terminalRows-4)`，再扣实际输出的头部行（`terminalRows-4` 已为下方详情 footer 预留，正文不重复扣除同一 footer）。`terminalRows <= 4`（`tooSmall`）时**不挂载** overlay、不触碰 editor/draft，壳标记 `too-small`，footer 入口与草稿保留，恢复尺寸后可重开。footer 高于 3 行、负高度、崩溃均按钳制处理；不偷偷删 source 记录。

## 8. 只读详情交互（无业务副作用）

`src/background-activity/detail-controller.ts`（统一详情壳）输入合同：

| 键 | 行为 |
| --- | --- |
| `Alt+O` | 关闭详情（repeat 不重复关闭）；未挂载时由薄 entry 的快捷键进入 |
| `Esc` | 只关闭且恒 consume，不向恢复后的 editor 传播 |
| `←` / `→` | 跨类型切换条目（按 key 顺序导航，不改任务） |
| `↑`/`↓`/`k`/`j` | 正文按行滚动（到底/到顶自动 `autoFollow`） |
| `PgUp`/`PgDn`/`Home`/`End` | 按页/首/末滚动 |
| SGR wheel（`\x1b[<64;..M` / `65`） | 按行滚动 |
| `x` | 切换工具/详情展开（repeat 不重复切换；同 key 新 request 重取详情） |
| 其他键 | 吞掉；key release 一律忽略 |

- 详情请求严格 fence：`scope.token` + selection key + source 对象 + request sequence 四元组；晚回/过期请求的组件只 `dispose` 一次并丢弃，不覆盖当前选择。
- registry 失效（source 数据变化或同 kind source 对象替换）→ 刷新条目、按当前 source 重取详情（即使 key 不变）；主题身份变化 → 先 provider `invalidate()` 再重取，保留可保持的 scroll anchor。
- stable key 消失 → 按上次索引钳制选择相邻项或空状态，不按标题复活。
- 打开详情时 presenter 保存并替换 editor（`ReadOnlyActivityEditor`：渲染空行、不处理输入），关闭/回滚路径恢复 editor + draft（各自 try/catch 隔离）；保存或替换失败时保持关闭并用固定文案 `后台活动详情打开失败` notify 一次，不透传异常正文。
- 详情内**没有** cancel/delete/run-now 等任务按钮，不改变任何命令授权；切换、打开、关闭详情都不执行或取消任务。
- 正文空态固定文案：`加载中…`、`详情读取失败`、`该任务暂无详情`、`当前无后台活动`；详情 footer 最多 3 行：`N/M ● label · state`、`行 a-b/total · 跟随底部|手动滚动 · x 展开|收起`、`‹ › 切换任务 · ↑↓ jk 滚动 · PgUp/PgDn/Home/End 翻页 · Esc/Alt+O 关闭`。

## 9. raw 与 RPC 不变量

- agent 实际收到的消息、tool result、event payload、session 内容与结构化 `details` 保持原样；本层的所有精简/折叠/摘要/截断/换行只发生在 TUI renderer。
- registry/布局不写回 source，不把 terminalReceipt 压缩存回 source，不创建假的「scheduler 错误任务」行。
- 运行协议只在 Host 内存 bus 传递函数：不写 session entry、不发模型消息、不成为 RPC wire 协议。
- RPC 模式下不构造 terminal UI（无 footer/overlay/editor 替换/握手），既有 status、消息投递与执行行为逐字不变。
- 本层不读 settings/models/auth/credential/session authority/state 正文，不写持久 log，不新建 daemon、跨进程调度器、durable exactly-once 承诺或第二任务/投递权威。

## 10. 明确不支持 / 不保证

- 人为同进程共享 bus 的多 Host：SDK 默认接线不产生该形态，明确 unsupported；协议只能以注册时核对的 scope 为界，不声称能识别无 identity 字段的任意 bus 发送者；发现第二个不同 manager 的 owner 与同 bus 接线冲突时拒绝该组合并报告，仅此。child runner 是独立进程，其事件经结果文件/watcher 转化，不走进程间 bus。
- 实时 scheduler 状态：不新增 timer/轮询（沿用 adapter 既有 initial/create/delete 后刷新 + 唯一 30s `FOOTER_POLL_MS`），不提供实时 `runningTaskIds`，不注入上游 scheduler 实例/hook，不新建第二 observer/authority。
- 全量恢复：不新增扫描器、不补 fresh-Host 恢复缺口；上游恢复中的 subagent 不一定重发 `started`，首屏恢复完整性存在已知缺口。本层只保证「现有权威 browser 已观察到的任务不丢失」，并保留 plain roster 的 same-Host reload 语义。
- 业务副作用：不提供任务创建/取消/删除/立即执行入口，不做消息重放或补投，不改变 bash cancel、compaction、tree、session switch 原语义。
- 身份推断：不按 label/标题/agent 名去重或复活条目，不按用户消息文本或状态字符串猜 task/session 身份，不猜未返回的 sessionId。
- 全局恢复保证：不承诺「任何异常后 footer 自动恢复」；teardown/回滚路径只保证展示层幂等与草稿/editor 恢复，不保证业务状态。

## 11. 验证与文档链接

代码层实证（真实 SDK + fake TUI + 合法 fixture，非视觉证据）见 `docs/plans/records/2026-10-13-footer-acceptance.md`；实现计划与逐单元合同见 `docs/plans/2026-10-13-background-activity-footer.md`（footer 子计划）与 `docs/plans/2026-10-13-remaining-runtime-execution.md`（统一执行计划 F1–F7）；单 Host 事件/闭包合同冻结见 `docs/plans/records/2026-10-13-background-activity-ownership.md`；scheduler 观察合同见 `docs/architecture/task-scheduler-adapter-contract.md` 与 `docs/plans/records/2026-10-13-scheduler-observer-contract.md`；bash_async 语义见 `docs/architecture/bash-async.md`。

以下命令是既有回归入口，其通过/阻塞结果全部以上方 F6v 记录为准；**F7 文档任务本身未运行它们**（unit-runner 由 S1v 独占）。注意以 `.integration.mjs` 结尾的文件（如 `test/background-activity-runtime.integration.mjs`）不被 `npm test` 的 `test/**/*.test.mjs` glob 覆盖，必须显式指定：

```bash
node --test test/background-activity-registry.test.mjs test/background-activity-layout.test.mjs test/background-activity-details.test.mjs test/bash-async-activity.test.mjs test/task-scheduler-activity.test.mjs test/task-scheduler-package-isolation.test.mjs
node --test test/subagent-activity-provider.test.mjs test/custom-footer-subagents.test.mjs test/custom-footer-input.integration.test.mjs test/pi-subagents-enhanced-package.test.mjs
node --test test/background-activity-runtime.integration.mjs
npm run typecheck
npm run verify:subagents-enhanced
git diff --check
```

真实 TUI 视觉验收（三 source 现场可见、`Alt+O` 跨类型、中文长命令/窄宽高、theme、`Esc` 草稿恢复、raw outputs）尚未运行，清单与 pending 状态见 `docs/plans/records/2026-10-13-footer-acceptance.md` 的 F7 节；未现场观察前不得记为 verified。
