# F6v 最终验证记录（统一后台活动 owner 接线）

**taskId:** F6v（dispatch-dbf0bf96）
**date:** 2026-10-14
**executor:** executor（unit-runner 独占窗口，父层授权 offline npm 约束）
**status:** verified（F6 代码/集成/runtime/typecheck/verify 全过；package 测试 6 例 blocked-environment，非缺陷）

## 范围与前置

- 验证对象：F6 六文件现场（`packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`、`packages/pi-subagents-enhanced/extensions/custom-footer.ts`、`pi/extensions/background-activity.ts`、`src/background-activity/index.ts`、`test/background-activity-runtime.integration.mjs`、`packages/pi-subagents-enhanced/scripts/verify-package.ts`）与 F1/F2b/F3/F4b/F5b 接口的一致性。
- 本任务零代码修改：F6 主代码与 F6-package 校验器补丁此前已落盘；本轮为只读验证 + 本记录写入。测试与校验器未改动。

## 静态核对（criterion-1，全部现场 grep/read 证据）

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 唯一 setFooter owner | 通过 | `ctx.ui.setFooter` 实际调用仅 `footer-runtime.ts` installFooter（:722 standalone / :725 presenter 包装，tui 门禁 + installedFooterMarker 幂等）；root presenter/layout/entry 仅注释提及，无调用 |
| 唯一 Alt+O | 通过 | `pi.registerShortcut` 全仓唯一调用 `packages/pi-subagents-enhanced/extensions/custom-footer.ts:21`，handler 委托 `runtime.openBrowser` → 当代 view（统一详情或 standalone browser） |
| root bare public import | 通过 | `src/background-activity/index.ts` 与 `presenter.ts` 仅经 `pi-subagents-enhanced/tui/background-activity` bare specifier 消费协议；grep 无 root→package src 深引 |
| package 无根反依赖 | 通过 | grep package `extensions/src/child-extensions/scripts` 无任何指向 repo root `src/`、`pi/` 的 import（仅 package 内部相对引用） |
| pi.events 握手 | 通过 | owner 先监听 owner-request/source-register/source-unregister/presenter-register/presenter-unregister 五通道再 emit owner-ready（footer-runtime.ts startOwnerEpoch）；root/bash/scheduler 三个 publisher 均先 listen owner-ready 再 emit owner-request；scope 三要素（manager/sessionId/hostKey）匹配 + token 世代 fence |
| RPC mode no UI | 通过 | 四处 `mode !== "tui"` 门禁：owner startOwnerEpoch/installFooter、root entry、bash publisher、scheduler publisher；集成测试 RPC 用例断言零 footer/overlay/editor/握手 |
| verify-package 同步 | 通过 | `expectedExports` 含 `"./tui/background-activity": "./src/tui/index.ts"` 与 manifest 逐字一致；`requiredTarballPaths` 含 `src/tui/index.ts`、`src/tui/background-activity.ts`、`src/tui/subagent-activity.ts`、`src/tui/footer-runtime.ts`；`test/pi-subagents-enhanced-package.test.mjs` 的 manifest/tarball 断言同步 |

## 运行验证（criterion-2；全部显式命令，未 pipe 掩盖 exit；npm 子进程统一 `npm_config_offline=true npm_config_registry=https://registry.npmjs.org/`）

| # | 命令 | 结果 | exit |
| --- | --- | --- | --- |
| 1 | `node --test test/background-activity-runtime.integration.mjs` | 13/13 pass | 0 |
| 2 | `node --test test/custom-footer-subagents.test.mjs test/subagent-activity-provider.test.mjs test/custom-footer-input.integration.test.mjs test/pi-subagents-enhanced-package.test.mjs` | 71/77 pass；6 fail（见下分类） | 1 |
| 3 | `node --test test/background-activity-registry.test.mjs test/background-activity-layout.test.mjs test/background-activity-details.test.mjs test/bash-async-activity.test.mjs test/task-scheduler-activity.test.mjs test/task-scheduler-package-isolation.test.mjs` | 98/98 pass | 0 |
| 4 | `npm run verify:subagents-enhanced` | 通过：manifest/exports/files 断言、受控 upstream 对照 1259 files、import closure 149 edges、tarball 1818 files/17.4MB | 0 |
| 5 | `npm run typecheck` | root typecheck + package typecheck 均通过 | 0 |
| 6 | `git diff --check` | 无空白错误 | 0 |

### 命令2 的 6 个失败分类（criterion-3）

- **类别：blocked-environment（fixture 准备阶段的离线缓存缺失），非 production 缺陷、非校验器缺陷、非测试缺陷。**
- 单一根因：`preparedPackageFixture()` 执行真实 `npm install --prefix <tmp fixture> --ignore-scripts --omit=peer --save-exact pi-subagents@0.75.0`。offline 模式（`only-if-cached`）下 npm 解析 pi-subagents 依赖树需要 `typescript` packument 与 `typescript-5.9.3.tgz`；仓库离线缓存 `var/tmp/npm-cache` 仅有 `typescript-7.0.2.tgz`，无该 packument（首次失败还暴露用户默认 `~/.npm` 缺 `@earendil-works/pi-agent-core`，经 `npm_config_cache` 指向仓库现有离线缓存后推进至 typescript，该缓存目录即 `verify-package.ts` 自身默认离线缓存）。
- 6 个失败用例（`test/pi-subagents-enhanced-package.test.mjs`）全部在 fixture 安装步骤抛 `npm error code ENOTCACHED`：`package setup and verify exercise the package-local upstream without patching`、`npm dry-run tarball contains the complete runtime closure and no repository-private files`、`package setup installs Pi core typings as development dependencies`、`the new compat facade loads from the prepared package`、`published upstream uses package exports and loads in plain Node`、`package verification rejects upstream drift, missing patch, and escaping extension entries`。
- 未修 fixture/测试、未放宽校验器、未删任何 upstream-drift/escape/canonical-export 门禁断言、未尝试联网（授权约束：缓存缺=blocked-environment）。
- 同文件非 fixture 用例（不依赖网络安装）全部通过：`both npm verification entry points default cache under the repository root`（fake npm 捕获 cache 路径）、`pi-subagents-enhanced exposes a publishable pinned package contract`（manifest/exports/bundleDependencies/peerDependencies 断言，即 F1/F6-package 静态同步的运行时确认）。
- 佐证：命令4 的 `verifyEnhancedPackage` 在同一 offline 窗口完整通过——校验器路径（pack 上游 tarball 对照 + tarball 闭包）不受该缓存缺失影响，因它只需 pi-subagents packument/tarball（已在缓存），无需解析 typescript 依赖树。

## 不变量现场证据（集成测试断言，真实 SDK + fake TUI）

- owner-first / source-first 双向握手均只由 package 安装 footer（1–2 次/epoch），root 仅发布 factory；唯一 Alt+O。
- 重复 ready / 同 registrationId 幂等：不重复 setFooter、不关 overlay、不重置选中项；source 重注册复用同 registrationId。
- 不同 registrationId 换视图：关旧 overlay、恢复 draft+editor、dispose 旧组件；匹配 unregister 恢复 standalone；过期 ID/旧 scope(token) 报文一律忽略；旧 registrationId 的 source-unregister 不删同 kind 新注册。
- reload/new/resume/fork：每次换新 token、旧 ctx 失效、owner-close 发出、三 source 重新握手。
- RPC：零 terminal UI、零握手，raw 消息与执行链路不变。
- late detail fence；shutdown token 先失效、source 只退订一次、任务零副作用（bash job 仍 active、无取消/无发送）。

## 边界与遗留

- 未运行真实业务 Host/provider/network/notify/kill/任务；未读 settings/auth/credential/真实 session 正文；未 stage/commit。
- 6 个 package fixture 用例待联网窗口或缓存补齐（`typescript` packument + `typescript-5.9.3.tgz` 入 `var/tmp/npm-cache`）后重跑确认；当前以 blocked-environment 记录，不冒充通过。
- 本记录不修改任何 F6 生产文件；F7（README/架构文档/视觉验收）不在本任务范围。

---

# F7 文档与视觉交接（2026-10-14 追加，不覆写上方 F6v 全文）

**taskId:** F7 文档部分（dispatch-30930469）　**status:** docs-verified / **visual pending（未运行真实 TUI 视觉，不得记为通过）**
**Resources:** static-evidence + 文档写路径；本任务不占 unit-runner（S1v 独占），未运行 `node --test`、`npm run typecheck`、`npm run verify:subagents-enhanced`——代码层证据全部沿用上方 F6v 原文，未重跑、未改写、未删除任何 assertion 或失败分类。
**上方 6 例 package fixture 失败的分类保持不变：** blocked-environment（离线缓存缺 `typescript` packument 与 `typescript-5.9.3.tgz`），不转绿、不删用例、不放宽校验器。

## 1. 本任务写入范围（4 个文档路径）

| 文件 | 动作 |
| --- | --- |
| `docs/architecture/background-activity-display.md` | 新建：注册/ownership/source 事实/raw-RPC 不变量/明确不支持项/几何与键位合同 |
| `packages/pi-subagents-enhanced/README.md` | 修订：公开出口表（5 项 exports，含 `./tui/background-activity` → `src/tui/index.ts`）、footer/Alt+O 入口与非保证项 |
| `README.md`（根） | 新增小节「统一后台活动区（TUI footer）」：唯一 owner、bare 入口、快捷键、明确不提供的能力 |
| 本文件 | 仅追加本节，上方 F6v 原文逐字保留 |

生产代码、测试、settings、`package.json` exports、`scripts/verify-package.ts` 一律未改（本任务 writePaths 只含上述 4 项）。

## 2. 文档—代码一致性核对（全部现场 read/grep，非转述）

| 文档声明 | 现场证据 |
| --- | --- |
| package 唯一 footer/Alt+O owner | `ctx.ui.setFooter` 实调用仅在 `src/tui/footer-runtime.ts` `installFooter`（standalone 分支 + presenter 薄壳分支），`installedFooterMarker` 身份幂等；本仓受管扩展代码内唯一 Alt+O `pi.registerShortcut` 在 `extensions/custom-footer.ts:21`（`var/upstream` 上游副本与 SDK examples 不计入）（`Key.alt("o")`，description `Open subagent browser`），handler 委托 `runtime.openBrowser` → 当代 mounted view |
| root entry 只发布 factory | `pi/extensions/background-activity.ts` 无 `setFooter`/`registerShortcut`/overlay 构造，只 emit presenter-register/unregister |
| 自动发现 | 文件位于受控 `PI_CODING_AGENT_DIR=<repo>/pi`（`scripts/pi-shell.zsh:4`）的 `pi/extensions/`，由 SDK 用户扩展目录发现加载；`--no-extensions` 下不加载 → package standalone footer 仍可用 |
| standalone fallback | `standaloneFooterFactory`/`standaloneActivityView`/`bindings.fallback`；factory 抛错或 `isMountedActivityView` 不合形状 → 回落 standalone，不双安装 |
| same-Host scope / token / registrationId | `HostScope{sessionManager,sessionId,token,hostKey}`；`isSameHostScopeIdentity` 三要素、`isSameHostScope` 含 token 世代；`createBackgroundActivityRegistrationId()` = `randomUUID()`，重复 ready 复用同 ID；token 为每次 `session_start` 新对象、不写事件 |
| callbacks dispose | owner 保存 `epoch.busUnsubscribes`，publisher 保存 `unsubscribeReady`；`teardownOwner` 顺序＝token 先失效 → 逐个退订 → presenter view dispose → source dispose → `registry.dispose()` → emit `owner-close`；registry dispose 带 handle fence，旧 dispose 不删新注册 |
| RPC 无 terminal UI | 本显示链路 `mode !== "tui"` 门禁逐调用点现场 8 处：footer-runtime `session_start`/`enterBrowser`/`installFooter`/`startOwnerEpoch`、root entry、bash publisher、scheduler publisher、`presenter.ts` `openDetails()`（上方 F6v 原表按 F6 文件口径列 4 项，两处口径不矛盾：本行把 footer-runtime 的 4 个调用点与 presenter 短路逐一点开计数）；RPC 保留既有 status/投递/执行行为 |
| 三类型图标 | `ACTIVITY_KIND_GLYPHS`：`subagent ●`、`bash_async ⌘`、`scheduler ⏱`（未知 kind 渲染 `◇`）；`RECENT_GLYPH ◯` 只是汇总行图标、不可选中；类型顺序 `subagent → bash_async → scheduler` |
| 状态词表 | subagent（`subagentStateLabel`）运行中/已完成/待处置/受限/已暂停/已停止/运行失败；bash active 固定 `running`，terminal 为 `outcome`，非 `attempted/accepted` 时显式附 `· <delivery>`；scheduler 等待触发/观察到投递中/上次投递成功/上次投递失败/已禁用 |
| current/history | subagent `activeChildren→main`、`recentChildren→recent`，recent run 预算 `RECENT_RUN_LIMIT = 20`（整组淘汰可少于 20）；bash `active→main`、`completed→recent`，终态快照上限 64（`shift()`），仅内存诊断快照非持久账本；scheduler 禁用且非投递中只进 `recent`（=只在详情显示），一次性任务完成后 disabled 记录仍是 scheduler 记录，不误称删除成功 |
| availability 三分 | `available` 且空 rows 才表已确认无任务；`stale` 保留原 rows/observedAt，`registry.snapshot()` 排除非 available 行（不计入 main/recent），presenter 经 `sourceSnapshot` 出独立状态行、详情壳标 `· 过期观察`；`unavailable` 空 rows；registry 异常只给固定类别 `errorLabel`（`source 查询失败`/`source 快照不符合协议`），不透传异常正文 |
| scheduler 投递≠业务成功 | `activity-source.ts` 状态词表注释与 `schedulerStateLabel` 实现：`success` 是 runner 投递结果、`running` 只是该次查询观察到的投递状态、`enabled` 表有计划存在非正在执行；本期不注入上游实例/hook，无实时 `runningTaskIds` |
| bash accepted 非消费 | `DELIVERED_ATTEMPTS = {attempted, accepted}`、详情行 `delivery: …（accepted 仅代表发送调用被接受，不代表模型已消费）`；launch 回执只代表接受任务 |
| 无 streaming | `createBashAsyncActivitySource` 的 `detail()` 一次性生成、不调 `requestRender`；active 详情只有 launch 元数据 + 「无输出流」，terminal 才读原 `content` blocks |
| subagent reported/unknown 不冒完成 | `subagentStateLabel`：`reported`/`needs-context`/未知终态/legacy `failed`/`rejected` → `待处置`；仅 presentation completed 或 legacy `complete`/`completed` → `已完成` |
| 无 realtime scheduler status / 无新 timer / 无 daemon / 无第二 authority / 无任务按钮 | source 只消费 adapter observer（复用既有 initial/create/delete/30s refresh，`FOOTER_POLL_MS = 30_000`，token 只在 adapter 闭包内）；详情壳输入表只有导航/滚动/展开/关闭，无 cancel/delete/run-now；文档已明确 unsupported 列表 |
| 不按 label/状态字符串猜身份 | row key 表（`subagent:<runId:childIndex>`、`bash_async:<jobId>`、`scheduler:<id>`）；`registry.sourceFor` 精确 key；key 消失按索引钳制相邻项不按标题复活；scheduler 归因注释明确禁用 `nextRunAt`/`runCount`/`lastStatus`/触发顺序 |
| fresh restore 限 / 同 Host reload plain roster | `rosterPartitions()` = manager 弱引用 × 逻辑 sessionId，容器经 `Symbol.for("pi-subagents-enhanced.footer-runtime.roster-partitions.v1")` 跨 SDK 模块重求值存活，只存 plain rows；new/fork/switch/resume 新 manager 天然空分区，同 ID 异 manager 不继承；不新增扫描器、不宣称补齐首屏恢复缺口（文档已保留该限制） |
| raw/RPC 不变 | 清理（`stripTerminalSequences` + 控制符、`truncateToWidth`/`visibleWidth`）只生成新串、不写回 raw；bus 只在 Host 内存传函数，不写 session entry、不发模型消息、不成为 RPC wire 协议 |

## 3. 链接与静态审计（本任务实际运行）

| # | 命令 | 结果 | exit |
| --- | --- | --- | --- |
| 1 | `git diff --check` | 无空白错误 | 0 |
| 2 | README/架构文档引用路径静态审计（脚本循环 3 文件、提取反引号路径逐项 `os.path.exists`） | 全部 `src/`、`packages/…`、`docs/…`、`test/…` 引用可解析；无 `[target]()` 形式 markdown 链接，故无断链 | 0 |

未运行（原因：S1v 独占 unit-runner，本任务合同禁止 test/tsc/npm）：`node --test …`、`npm run typecheck`、`npm run verify:subagents-enhanced`。因此本节只声明「文档与现场代码事实一致 + 链接可解析」，不声明任何新的测试通过。

## 4. 视觉 pending 清单（须用户现场观察，fake TUI 不替代）

前提：fake/集成测试只证协议与渲染合同，不是现场截图验收；本节全部项当前状态一律 **pending-user**，未观察前不得写 verified。

A. 现场准备（全部由用户手工执行，本任务不代为启动 Host 或真实任务）

1. 当前 Host 内执行 `/reload`（普通 TS/MJS 源码改动无需重装 package），确认无报错回到 TUI。
2. 若不使用真实业务任务：由用户显式授权一个独立 test-fixture 视觉 harness 任务（独立授权、独立 writePaths）来注入三 source 可见的显示输入；本任务未创建、未运行该 harness。

B. 逐项观察矩阵

| # | 观察点 | 期望（与代码合同一致） | 状态 |
| --- | --- | --- | --- |
| V1 | 三 source 同时在场 | 主视图左区逐条显示 `●`/`⌘`/`⏱` 三类条目，任一类不被整体遮蔽、不被 `+N` 折叠掉整类 | pending-user |
| V2 | 类型顺序与稳定次序 | subagent → bash_async → scheduler；同类型内不随 tick 跳动 | pending-user |
| V3 | 状态列与图标分离 | 图标只表类型；subagent 非完成态显示 `待处置`（不出现 `已完成`）、bash 显示 `running`/`outcome`/`· delivery` 附注、scheduler 显示 `等待触发` 等 | pending-user |
| V4 | `Alt+O` 跨 source 切换 | `←`/`→` 在三类条目间切换；footer 首行显示 `N/M <glyph> label · state`；切换不执行、不取消任何任务 | pending-user |
| V5 | 中文长命令换行 | 超长/含中文 label 挂起换行，续行与 label 内容列对齐，不中段截断身份 | pending-user |
| V6 | 窄宽 | 降级顺序 gap→选择列→padding，图标身份最后消失；仅图标也放得下时只显示图标，不越界不崩 | pending-user |
| V7 | 窄高度 | `terminalRows<=4` 时 `Alt+O` 不挂 overlay、不动 editor/draft、footer 入口与草稿保留；恢复高度后可重开 | pending-user |
| V8 | 主视图溢出 | 超出 `terminalRows-6` 预算时末行为 `还有 N 项 · Alt+O`，recent 折叠为单行 `◯ recent N` | pending-user |
| V9 | theme | 换 theme 后详情按新主题重取、可保持 scroll anchor；无残影色块 | pending-user |
| V10 | `Esc` 关闭 | `Esc` 只关闭详情、恢复进入前 draft 与 editor 状态，不把按键传播给恢复后的 editor（草稿不被追加字符） | pending-user |
| V11 | raw outputs | bash terminal 详情显示原生 content blocks 原文（含非文本块计数行）；subagent 详情走 trusted native/Fleet 回退；agent 实际收到的消息、tool result、session、结构化 `details` 未被精简改写 | pending-user |
| V12 | stale/unavailable | source 查询失败时有独立状态行（`过期观察`/`暂不可用` + 固定 errorLabel），旧行不计入 main/recent、不被读成完成或删除 | pending-user |
| V13 | reload/new/resume/fork 后 | 只一个 footer、只有一个 Alt+O 行为；旧代 listener 不残留（无重复 invalidate/闪烁）；同 session reload 保留本分区 roster | pending-user |
| V14 | RPC 模式 | `pi --mode rpc` 无 footer/overlay/握手痕迹，既有 status、消息投递、执行行为不变（用户可用自己的 RPC 客户端观察） | pending-user |

C. 视觉通过判定：V1–V14 全部由用户现场确认（或后续独立授权 harness 的真实 Host 截图/事件日志）后方可写 verified；否则保持 partial/blocked-environment，不以 fake TUI 补绿。

## 5. 本任务边界

未启动真实 Host/任务/provider/network；未发系统通知；未 kill 进程；未读 settings/models/auth/credential/session authority/state 正文；未使用 MCP；未修改生产代码或测试；未运行 test/tsc/npm；未 stage/commit/stash/reset；未创建或提交任何工单。


# 2026-10-16 Inline closeout 追加

旧F6v/F7是各自时点记录，不覆写。F1新合同由commit 1b94710取代旧metadata交错、padding与空槽设计；当前标题col4/续行同列/公共右状态列/词边界与stacked规则见runtime-closeout计划§2。

- footer/source/registry/详情综合回归：184/184，exit0。
- 真实TUI八场景：8/8，exit0；L2证据 `docs/plans/records/2026-10-15-runtime-closeout/visual-acceptance.md`。
- root+package typecheck、offline verify通过；verify现为1259 upstream files、151 import edges、1819 tarball files（随新增diagnostics闭包变化，非旧149的矛盾）。
- 旧V1–V14表的“未运行”仅历史快照。现L2映射已更新；用户字体/色彩/闪烁/IME/整体观感L3仍pending-user；raw不变只引用L1，不伪称读取了用户session。
- 六项package fixture仍因官方离线缓存缺失阻塞，未联网补齐；不是8项全绿。
