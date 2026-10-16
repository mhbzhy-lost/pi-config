# 统一后台活动区（TUI footer）隔离视觉验收就绪度调研（read-only research）

- 任务：`dispatch-c42871d2`（delegate；只调查、只写本报告；不实现、不运行真实 Host）
- 日期：2026-10-14
- 性质：**纯 read-only 调研**。本窗口未运行任何 test/npm/Host/网络/通知/kill/worktree 清理；未读 `pi/settings.json`、`pi/models.json`、`pi/auth.json`、任何真实 session/authority/state 正文；未修改 production/test；未 stage/commit/stash/reset；未用 MCP；未使用 tdd。
- 写路径：仅本文 `docs/research/2026-10-14-background-activity-visual-readiness.md`。
- 边界自报：本窗口执行过一条**无副作用空操作** `node -e '1'`（环境探测时误带，仅求值字面量 1，不加载任何模块、不启动 Host、不跑测试）；其余命令均为 `ls/grep/sed/wc/read/command -v/python3 静态计数与 import 探测`。除该空操作外无 node/npm 执行。
- 中途纳入父层 steering：真实用户新会话截图（`/var/folders/…/pi-clipboard-8df89397-….png`）的 footer 疑错位样例已纳入 §5，含设计/回归判定、精准复现输入与 cols 获取方式；无法从截图推定的 cols/真实 session/token 一律记 unknown。

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| 能否用受控临时 HOME/agentDir/sessionDir + fake source rows 启动**真实 TUI**（不启动 provider/model/真实任务） | **能**。interactive 模式唯一硬前提是 stdin+stdout 均为 TTY（需 PTY 驱动）；interactive 不要求 model/provider/凭据；设 `PI_CODING_AGENT_DIR` 即跳过首次安装交互；临时 cwd 无 `.pi/` 即无 trust 交互；`--offline`+fake/零 provider 即零网络。证据 §2.1 |
| 实际 launcher/interactive 入口与 session owner 要求 | 人工/受控启动应走 `scripts/pi-shell.zsh → scripts/pi-launcher.zsh`（prepare 决策 + 无条件追加 `-e pi/extensions/session-owner.ts` + 临时 registry）；既有 PTY 先例 `test/session-owner-runtime.integration.mjs` 已证明该链在临时根下可跑真实交互 TUI。证据 §2.2 |
| 三 source 本地受控 fixture 注入 | 全部有**公开入口**：subagent 经 `pi.events.emit("subagent:async-started"/"async-complete")`（公开 EventBus，channel 为 untyped string）+ 临时 asyncDir 的 `status.json`；bash_async 经 `src/bash-async/index.ts` 的 `createBashAsyncActivityPublisher(controller,{Text},bus)` + 形状等价 fixture controller；scheduler 经 `src/task-scheduler/index.ts` 的 `createSchedulerActivityPublisher(observer,bus)` + fixture observer（真实 adapter 的 `upstreamExtension` 注入口存在但 Host 入口未暴露）。证据 §2.3 |
| Alt+O/overlay/resize/theme/Esc/draft/raw 的非敏感证据 | `PI_TUI_WRITE_LOG`（pi-tui 原生支持，逐 write 落盘 raw ANSI）+ PTY master 捕获 + 已知 winsize = 机器证据；draft/Esc 用「先键入 fixture 草稿再断言 editor 区字符串不变」；raw 不变量用临时 sessionDir 内 JSONL 只含 fixture 文案证明。证据 §2.4 |
| V1–V14 状态 | 0 项 blocked；14 项全部「real-Host 可证（机器证据）」，其中 13 项的最终观感签核需用户现场（V14 为协议面，机器证据即足）；fake TUI 层 14 项均已有集成断言。证据 §4 |
| terminal 截图是否必要 | **机器验收不必要**（ANSI 流 + 已知几何 + 纯布局函数离线回放即可判定「错位/越界/列不对齐」）；**用户观感签核必要**（配色、闪烁、IME、换行美观度只能人眼）。PNG 截图本身推不出 cols。证据 §2.5、§5 |
| 用户截图样例（长中文 label + `(delegate)` 被拆、状态列最右、右元数据独占 2/3 行） | 三项均为**现行设计行为**（grapheme 贪心换行、状态列挂首行、换行条目整体下移全宽行），非回归；「ASCII 词内断行是否要改词感知换行」是产品决策候选，需独立授权任务，不在视觉 harness 内修。证据 §5 |

## 1. 范围、方法与现场版本证据

只读证据文件（关键项全文件已读）：

- `docs/architecture/background-activity-display.md`（显示层合同全文）
- `docs/plans/records/2026-10-13-footer-acceptance.md`（F6v 运行记录 + F7 视觉 pending 清单 V1–V14）
- `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`（1033 行，唯一 setFooter owner / bus 握手 / standalone fallback / Alt+O 委托）
- `packages/pi-subagents-enhanced/extensions/custom-footer.ts`（25 行薄入口，唯一 `pi.registerShortcut(Key.alt("o"))`）
- `pi/extensions/background-activity.ts`（134 行，根 presenter 发布入口，`ctx.mode !== "tui"` 门禁）
- `src/background-activity/{index,layout,presenter,detail-controller}.ts`（layout 739 行全读；presenter 前 140 行全读）
- `packages/pi-subagents-enhanced/src/tui/{subagent-activity,session-browser,browser-adapter}.ts` 关键函数
- `src/bash-async/index.ts`、`src/task-scheduler/{index,adapter}.ts`、`pi/extensions/{bash-cwd,task-scheduler,session-owner}.ts`
- 测试：`test/background-activity-runtime.integration.mjs`（758 行全读）、`test/helpers/{pi-runtime,pi-host}.mjs`（全读）、其余 background-activity/footer/bash/scheduler 测试静态计数
- 既有 PTY 先例：`test/session-owner-runtime.integration.mjs`（经 `docs/research/2026-10-14-session-owner-pty-readiness.md` 全读转引，该调研报告本身全读）、`docs/session-owner.md`（全读）
- 启动链：`scripts/pi-shell.zsh`、`scripts/pi-launcher.zsh`、`scripts/assert-session-tool-policy.ts`（全读）
- SDK（仅本仓 node_modules 文档与 dist 静态定位，未执行）：`docs/{tui,sdk,cli,environment-variables,slash-commands}.md`；`dist/main.js`、`dist/cli/args.js`、`dist/cli/startup-ui.js`、`dist/bundle/chunks/chunk-H33F2TZD.js`（`main()` 实现体）、`dist/modes/interactive/interactive-mode.js`、`dist/core/{event-bus,session-manager,extensions/types}.d.ts/.js`、`node_modules/@earendil-works/pi-tui/dist/terminal.js`

现场只读环境探测（`command -v` / `python3 -c import` 级）：

- `/usr/bin/expect`（5.45，经 session-owner PTY 调研 §1 记录）、`/usr/bin/script`、`python3`（`pty/fcntl/termios` 可 import）；**无 tmux、无 node-pty**（repo node_modules 无 pty 包）。
- 物理 SDK：`node_modules/@earendil-works/pi-coding-agent`（package.json version `1.0.4`，bin `dist/bundle/cli.js`）。
- 仓库 HEAD `main`，工作区既有 dirty（受保护现场，本任务未触碰）。

## 2. 核心问题回答

### 2.1 隔离启动真实 TUI 的可行性（不启动 provider/model/真实任务）

逐前提证据（全部为 dist 静态定位，未执行）：

1. **TTY 是唯一硬前提**：`resolveAppMode(parsed, stdinIsTTY, stdoutIsTTY)`：`--mode rpc/json` 或 `--print` 或 `!stdinIsTTY || !stdoutIsTTY` → 非 interactive；否则 interactive（`dist/cli/args.js` 的 `resolveAppMode` 函数体；`dist/main.js:518` 调用）。另 `main()` 内 `readPipedStdin()` 在 stdin 为管道时把 interactive 降级为 print（chunk-H33F2TZD `main()`）。**结论：必须 PTY（expect / python3 pty / script），管道或重定向拿不到真实 TUI。**
2. **interactive 不要求 model/provider/凭据**：`main()` 中「无 model 即 `formatNoModelsAvailableMessage()` + `process.exit(1)`」的门禁条件是 `appMode !== "interactive"`（chunk-H33F2TZD `main()`）；interactive 分支只把 `modelFallbackMessage` 作为 warning 显示（`interactive-mode.js:880-881`）。footer 对无 model 的投影是 `no-model`（`footer-runtime.ts` `createFooterComponent`）。**结论：零 provider 零凭据可进真实 TUI。**
3. **首次安装交互可跳过**：`shouldRunFirstTimeSetup()`（`dist/cli/startup-ui.js:98`；chunk 内实现）在 `process.env[PI_CODING_AGENT_DIR]` 存在时直接返回 false。**结论：设临时 agentDir 即无 theme/analytics 首启交互。**
4. **project trust 交互可避免**：`hasTrustRequiringProjectResources(sessionCwd)` 只对 cwd 下受 trust 门禁的项目资源生效；harness cwd 用空临时目录即无交互，另有 `-a/--approve` 兜底（chunk `main()`；`cli.md`）。
5. **session 身份可用且无需真实历史**：`SessionManager.newSession()` 恒生成 UUID `sessionId`（`dist/core/session-manager.js:691-716`），`getSessionId()/getSessionFile()` 公开（`:779-784`）；`--no-session`（in-memory）也有 UUID，但 `getSessionFile()` 为空 → subagent 详情的 trusted roots 只剩 `PI_CODING_AGENT_SESSION_DIR`（`footer-runtime.ts` `browserTrustedSessionRoots`）。**结论：视觉 harness 建议用临时 `--session-dir`/`PI_CODING_AGENT_SESSION_DIR` 的持久化空会话（与集成测试 `SessionManager.create(root, sessionDir)` 同形），既满足 owner 握手又保留详情 trusted root。**
6. **网络可清零**：`--offline`/`PI_OFFLINE=1` + `PI_SKIP_VERSION_CHECK=1`；interactive 模式无后台 catalog refresh（后台 refresh 仅 rpc 分支，`dist/main.js:765-772`）；fake provider 经 extension `registerProvider` 进程内 `streamSimple`（先例 `test/fixtures/deterministic-provider.mjs`，session-owner PTY 调研 §6.1 已证零出网）。**亦可完全不注册 provider（§2.1-2）。**
7. **raw mode 无 TTY 不炸、有 PTY 正常**：`ProcessTerminal.start()` 对 `setRawMode` 有存在性守卫（pi-tui `dist/terminal.js:114-115`）；尺寸 `get columns()/rows()` = `process.stdout.columns || Number(process.env.COLUMNS) || 80` / `… || Number(process.env.LINES) || 24`（同文件 sourcesContent）。**结论：几何既可由 PTY winsize 决定，也可在 winsize 为 0 时由 `COLUMNS/LINES` env 兜底固定；动态 resize 用 `ioctl(TIOCSWINSZ)` + 对自生子进程 `SIGWINCH`（SDK 自身启动时亦 best-effort 自发 SIGWINCH，`terminal.js` `refreshTerminalDimensions`）。**
8. **ANSI 机器证据原生支持**：`PI_TUI_WRITE_LOG=<dir|file>` 时 `ProcessTerminal.write()` 逐次 `appendFileSync` 落盘 raw ANSI（pi-tui `dist/terminal.js:88-100` 与 `write()`；`docs/tui.md` 明示用于渲染诊断）。**这是不截图取得真实 TUI 字节级证据的官方通道。**
9. **启动即退的烟雾通道（可选）**：`PI_STARTUP_BENCHMARK=1` 且 interactive 时 `interactiveMode.init()` → 150ms → `stop()` 后退出（`dist/main.js:759-796`）。可用于「真实 TUI 能 init 且 footer 安装」的最小烟雾，但**不产生交互证据**，V 项仍须常驻 PTY 会话。

### 2.2 实际 launcher / interactive 入口与 session owner 要求

- 受控启动链（`scripts/pi-shell.zsh` → `scripts/pi-launcher.zsh`）：`assert-session-tool-policy.ts` 参数门禁 → Node≥22.19 检查 → `resolve-physical-pi.ts` 解析 `PI_REAL_BIN` → `pi-session-owner.ts prepare`（0700 decision_dir，`blocked|bypass|pass|pin-session`）→ `exec node <PI_REAL_BIN> -e <root>/pi/extensions/session-owner.ts <args…>`（与 launcher 同 PID）。`pi()` 默认追加 `--tui-mode fullscreen`。
- `docs/session-owner.md`：直接执行 Pi 二进制/SDK/RPC/JSON/print **不登记 owner，属明确 unsupported 边界**；`--no-extensions` 下 launcher 仍无条件追加 session-owner entry。
- 既有真实 PTY 先例（**visual harness 应复用的基建**）：`test/session-owner-runtime.integration.mjs` 的 `ptyFixture`（`/usr/bin/expect` spawn launcher；env **白名单**：`HOME/PI_CODING_AGENT_DIR/PI_CODING_AGENT_SESSION_DIR/PI_SESSION_OWNER_REGISTRY/PI_CODING_WORKSPACE_DIR/PI_CODING_GOAL_DIR/TMPDIR/PI_SKIP_VERSION_CHECK/PI_TELEMETRY/TERM/PI_HOST_NODE/PI_REAL_BIN/LAUNCHER/PROVIDER`，不含 ZDOTDIR/XDG/用户 shell 导出）+ `--offline --provider fake --model fake/deterministic -e <deterministic-provider> --no-skills --no-prompt-templates --no-themes --no-context-files` + marker 就绪屏障 + EOF(`\004`) 优雅退出 + 绿灯零 SIGKILL（详见 `docs/research/2026-10-14-session-owner-pty-readiness.md` §2–§3、§9）。
- **对 visual harness 的入口选择**：走 launcher（owner 登记、产品真实路径）+ 显式 `-e` 清单；`--no-extensions` 关闭自动发现（含 `pi/extensions/*` 与 settings packages 的 package footer 入口）后按需显式挂载，避免真实 settings 的 packages/enabledModels 影响（也不读 settings 本体）。注意 launcher 的 `assert-session-tool-policy.ts` 只拦「维护子命令形」参数组合，视觉参数集（`--tui-mode/--session-dir/-e/--use-theme/--offline` 等带值flag）在其白名单内。
- session owner 对视觉项的约束：临时 `PI_SESSION_OWNER_REGISTRY` 必设（否则写用户运行时 registry）；`/resume`/`/new`/`/fork`（V13）在临时根内是受控事务，fixture session JSONL 只能由本窗口真实 Pi 在临时 sessionDir 自造（先例 `freeSession` 模式）。

### 2.3 三类 source 的本地受控 fixture 注入（公开入口清单）

| kind | 公开注入入口 | 形状/门禁 | 备注 |
| --- | --- | --- | --- |
| subagent | fixture extension 内 `pi.events.emit("subagent:async-started", {id, asyncDir, cwd, agent|agents, sessionId, title?})` 与 `"subagent:async-complete"`；`pi.events` 是公开 `EventBus`（`emit(channel: string, data: unknown)`，`dist/core/event-bus.d.ts:1-4`） | footer 侧门禁：`event.sessionId` 必须等于事件到达时实测 `manager.getSessionFile()` 或 `getSessionId()`（`footer-runtime.ts` `isCurrentSessionEvent`）；`trackStarted` 要求 `id/asyncDir/cwd/agent(s)` 非空（`session-browser.ts:206-246`） | 富字段（label/model/thinking/tokens/sessionFile/transcriptPath）由**临时 asyncDir 下的 `status.json`** 经 500ms reconcile 注入（`readBrowserRunStatus` `browser-adapter.ts:13-30`；`reconcileRun` `session-browser.ts:249-315`）；asyncDir 本身是 trusted root，可放 fixture child session JSONL 供详情渲染（非敏感自造内容） |
| bash_async | `src/bash-async/index.ts` 公开 `createBashAsyncActivitySource(controller, {Text})` / `createBashAsyncActivityPublisher(controller, {Text}, bus)`（`:211`、`:265`）；fixture controller 只需 `snapshot()/subscribe()`，**故意不给 cancel/abort 面**（集成测试同约定，`test/background-activity-runtime.integration.mjs` `createBashControllerFixture`） | publisher `onSessionStart({mode, sessionManager, sessionId})` 有 `mode==="tui"` 与 sessionId 门禁（`pi/extensions/bash-cwd.ts:32-46` 为真实接线同形） | 真实 controller 路径=真实后台命令=真实任务，本合同排除 |
| scheduler | `src/task-scheduler/index.ts` 公开 `createSchedulerActivitySource(observer)` / `createSchedulerActivityPublisher(observer, bus)`；fixture observer 提供 `snapshot()/subscribe()/detail(id)`，可自报 `availability: available|stale|unavailable`（V12 直接可用） | 同 publisher 门禁 | 真实 adapter `registerTaskSchedulerAdapter(pi, {upstreamExtension,…})` 有 upstream 注入口（`src/task-scheduler/adapter.ts:349`），但 Host 入口 `pi/extensions/task-scheduler.ts:20` 未暴露该 seam，且默认 upstream 为 `pi/npm/…/@amaster.ai/pi-task-scheduler`（`adapter.ts:5`）→ 真实入口在临时根下只会看到空/不可用 scheduler 源；要三源同场必须走 fixture publisher 或 `--no-extensions` 下不挂真实 task-scheduler entry |

- **协议层报文**（source-register/presenter-register 等）亦可在 fixture extension 内按公开 channel 常量（`pi-subagents-enhanced/tui/background-activity` 的 `BACKGROUND_ACTIVITY_CHANNELS`）直接 emit——集成测试即以此作为总线参与者；载荷须过 owner 的 scope（manager/sessionId/hostKey + token）校验。
- **加载清单草案**（`--no-extensions` + 显式）：`-e packages/pi-subagents-enhanced/extensions/custom-footer.ts -e pi/extensions/background-activity.ts -e <fixture-sources.ts>`；需要真实 bash/scheduler 接线时再追加对应 entry（并接受同 kind 后注册替换语义）。package footer 入口在临时 agentDir 下**不会**被 settings packages 自动加载（临时根无 settings），必须显式 `-e`——这与「真实用户 Host 经 settings local path source 加载」（`packages/pi-subagents-enhanced/README.md`「来源选择」）不同，报告如实标注该差异。

### 2.4 Alt+O / overlay / resize / theme / Esc / draft / raw 的非敏感证据取得

| 观察点 | 机器证据通道（非敏感） | 真实 Host 可证性 |
| --- | --- | --- |
| Alt+O 进入/关闭、跨类型 `←/→` | PTY 发送 `\x1bo`（legacy alt；kitty 未启用时）或 kitty 序列；断言 `PI_TUI_WRITE_LOG`/master 流出现详情壳帧：`N/M <glyph> label · state`、`‹ › 切换任务 …Esc/Alt+O 关闭` 固定导航行（≤3 行）；`PI_TUI_ESC_TIMEOUT=100` 防 PTY 拆包误判 | 可证；快捷键真实链路＝`interactive-mode.js:1707-1760`（`setupExtensionShortcuts`，handler ctx `sessionManager: this.sessionManager`，与 `session_start` ctx 同对象：`agent-session.js:2917` 把 `this.sessionManager` 交给 ExtensionRunner；`interactive-mode.js:352` getter）→ `custom-footer.ts` handler → `runtime.openBrowser` 守卫 `shortcutCtx.sessionManager === ctx.sessionManager`（`footer-runtime.ts` `openBrowser`）。自定义 editor 激活时快捷键经 `interactive-mode.js:2268-2269` 转发，故详情内 Alt+O 亦可达 |
| overlay 几何（margin.bottom=4、全宽、rows 实时） | 已知 winsize 下断言 ANSI 帧行数与 overlay 起止；`rows<=4` 时发 Alt+O 断言**无** overlay 帧且 editor/draft 区不变（`presenter.ts` `TOO_SMALL_TERMINAL_ROWS` 路径） | 可证 |
| resize（V6/V7/V8） | python3 pty：`fcntl.ioctl(slave, TIOCSWINSZ, pack('HHHH', rows, cols,0,0))` + 对自生子进程 `SIGWINCH`；断言帧随 cols/rows 变化且每行可见宽 ≤ cols | 可证；无 tmux/node-pty 不影响（stdlib pty 足够） |
| theme（V9） | 两次启动 `--use-theme <name>`，或运行中改写临时 agentDir themes 目录主题文件（theme watcher：`interactive-mode.js` `onThemeChange`/`stopThemeWatcher`）；断言 ANSI 色彩序列变化与详情重取 | 机器可证色彩字节变化；**配色美观/残影感知需用户** |
| Esc 草稿恢复（V10） | 先经 PTY 键入 fixture 草稿串 → Alt+O → Esc → 断言 editor 区仍含完整草稿串且**无追加字符**、overlay 帧消失 | 可证 |
| raw 不变量（V11） | 临时 sessionDir 的 JSONL 只含 fixture prompt/回复（自造内容）；footer/详情不写 session；ANSI 中 bash terminal 详情文本与 fixture `content` 原文逐字一致；非文本块计数行存在 | 可证；「agent 实际收到内容未被改写」另由 fake TUI 集成断言持有 |
| 握手/owner 不变量 | 真实 Host 的 bus 为进程内存、不落盘 → 机器证据归 fake TUI 集成层（13/13，F6v）；真实 Host 只取渲染结果证据，不伪造总线证据 | 分层持有，见 §3 三层模型 |

### 2.5 terminal 截图是否必要；如何避免真实配置与凭据

- **机器验收不需要截图**：判定「错位/越界/列不对齐/行数超预算」只需 (a) 已知 winsize（driver 设定，构造即知）；(b) `PI_TUI_WRITE_LOG` raw ANSI；(c) 纯布局函数离线回放：`renderActivityLayout({width: cols, terminalRows, meta, rows, sourceStatuses, selection})` 是导出纯函数（`src/background-activity/layout.ts:530+`），给定同输入可算出期望行数组，与 ANSI 去色后 footer 区逐行 diff → **设计/回归的机器判定不依赖人眼，也不依赖重跑 Host**。
- **截图（或用户现场）必要的部分**：配色观感、闪烁/残影感知、IME 候选窗位置、换行美观度（§5 的用户投诉正属此类）——这些是感知判断，合同内记 `needs-user-visual`，不以 fake/ANSI 冒充。
- **PNG 截图推不出 cols**：像素宽→列数需字体度量，合同记 unknown；cols 取得方式见 §5.3。
- **避免真实配置/凭据**：env 白名单（§2.2 先例）+ 临时 `HOME/PI_CODING_AGENT_DIR/PI_CODING_AGENT_SESSION_DIR/PI_SESSION_OWNER_REGISTRY/PI_CODING_WORKSPACE_DIR/PI_CODING_GOAL_DIR/TMPDIR`；`--offline`；零 provider 或 in-process fake provider（`apiKey:"not-used"` 不出进程）；不读用户 settings/models/auth；`PI_TUI_WRITE_LOG` 指临时根内；quit 走 EOF，临时根 `rm -rf` 自清。

## 3. 隔离 TUI 视觉验收合同（草案，供后续授权窗口执行）

### 3.1 三层证据模型（不冒充视觉通过）

| 层 | 载体 | 证明力 | 现状 |
| --- | --- | --- | --- |
| L1 fake TUI（已证） | `test/background-activity-runtime.integration.mjs`（真实 SDK + 记录型 ui + fake provider）等 | 协议/握手/生命周期/渲染合同 | F6v 已跑：13/13、98/98、71/77（6 例 blocked-environment） |
| L2 真实 Host 可证（待授权运行） | expect/python-pty + 临时根 + `PI_TUI_WRITE_LOG` + 已知 winsize + 纯布局函数离线回放 | 真实 pi-tui 渲染字节、真实键位链路、真实几何 | 本窗口只设计未运行 |
| L3 用户观感签核（必须） | 用户本人终端/截图确认 | 感知类（配色、闪烁、美观、IME） | pending-user，不因 L1/L2 转绿 |

### 3.2 环境白名单与启动草案（命令草案，未执行）

```bash
# 0) 预检（read-only 级）：expect/node 版本/物理 SDK --version（先例三预检）
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/bg-visual.XXXXXXXX")
mkdir -p "$ROOT"/{home,agent,sessions,registry,tmp,cwd,workspaces,goals,ansi}
env -i PATH="$PATH" \
  HOME="$ROOT/home" \
  PI_CODING_AGENT_DIR="$ROOT/agent" \
  PI_CODING_AGENT_SESSION_DIR="$ROOT/sessions" \
  PI_SESSION_OWNER_REGISTRY="$ROOT/registry" \
  PI_CODING_WORKSPACE_DIR="$ROOT/workspaces" \
  PI_CODING_GOAL_DIR="$ROOT/goals" \
  TMPDIR="$ROOT/tmp" \
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  PI_TUI_WRITE_LOG="$ROOT/ansi" \
  PI_TUI_ESC_TIMEOUT=100 \
  TERM=xterm-256color \
  <pty-driver> "$REPO/scripts/pi-launcher.zsh" \
    --tui-mode fullscreen --offline --no-session-dir-typo \
    --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files \
    --session-dir "$ROOT/sessions" \
    -e "$REPO/packages/pi-subagents-enhanced/extensions/custom-footer.ts" \
    -e "$REPO/pi/extensions/background-activity.ts" \
    -e "$REPO/<fixture-sources>.ts"
# 零 provider 变体：不加 --provider/--model（interactive 不要求 model）；
# 右元数据变体：fixture extension 内 registerProvider("fake")+--provider fake --model fake/deterministic（先例同形）
```

- pty-driver 首选 **python3 stdlib**（`pty.openpty` + `TIOCSWINSZ` + master 读写 + 对子进程 `SIGWINCH`）；键位流复用 expect 先例仅用于非几何项。几何断言一律以 driver 设定 winsize 为准。
- 就绪屏障：master/ANSI 流出现 fixture label 与 `●/⌘/` 三类 glyph（=V1 同时是屏障）；超时即 fail-closed 停。
- 退出/清理：stdin EOF(`\004`) 优雅 quit（先例绿灯零 SIGKILL）；finally 仅对**本窗口自生 wrapper 子进程**做 SIGKILL 兜底（需与 session-owner 先例同形的 scoped 授权语言）；临时根 `rm -rf`；不做任何 worktree 操作；registry record 随 quit 释放。
- 停止条件（命中即停，不放宽、不重试换语义）：三预检失败；launcher `blocked` 决策；就绪屏障超时；quit+兜底后仍有孤儿进程；出现清单外 kill 需求；任何需要读用户 settings/models/auth/真实 session 正文才能继续的情形；几何断言与纯布局回放不一致 → 记候选缺陷并保留现场（ANSI 日志+winsize+输入快照），**不在 harness 内改实现**。

### 3.3 resources 与并发

- **visible-host = 1（必需）**：真实 PTY/交互 TUI 进程树与终端字节流，unit-runner（进程内 node --test）无法替代；先例与授权形状见 `docs/research/2026-10-14-session-owner-pty-readiness.md` §8。
- **unit-runner**：承担 L1（`node --test …` 既有命令，见 §3.4）。
- 资源：`/usr/bin/expect` 5.45、`python3`(pty/fcntl/termios)、`/bin/zsh`、Node≥22.19、仓内物理 SDK；并发 launcher ≤2（V13 双窗口对照可选，默认 1）。无 tmux/node-pty 不构成阻塞。

### 3.4 命令草案与静态测试计数（本窗口未运行任何测试）

L1 既有回归入口（与 F6v 同命令）：

```bash
node --test test/background-activity-runtime.integration.mjs
node --test test/background-activity-registry.test.mjs test/background-activity-layout.test.mjs test/background-activity-details.test.mjs test/bash-async-activity.test.mjs test/task-scheduler-activity.test.mjs test/task-scheduler-package-isolation.test.mjs
node --test test/subagent-activity-provider.test.mjs test/custom-footer-subagents.test.mjs test/custom-footer-input.integration.test.mjs test/pi-subagents-enhanced-package.test.mjs
npm run typecheck && npm run verify:subagents-enhanced && git diff --check
```

静态计数（本窗口 grep 计数，非运行结果；与 F6v 运行计数逐条吻合）：

| 组 | 文件（top-level `test(` 数） | 合计 | F6v 运行记录 |
| --- | --- | --- | --- |
| 显示单元 | registry 16 + layout 19 + details 28 + bash-async-activity 19 + scheduler-activity 15 + scheduler-package-isolation 1 | 98 | 98/98 pass |
| package/footer | subagent-activity-provider 20 + custom-footer-subagents 45 + custom-footer-input.integration 4 + pi-subagents-enhanced-package 8 | 77 | 71/77（6 例 blocked-environment：离线缓存缺 typescript packument/5.9.3 tgz） |
| runtime 集成 | background-activity-runtime.integration 13 | 13 | 13/13 pass |
| 相邻（不计入上三组） | custom-footer-layout 6、custom-footer-fullscreen.integration 1、task-scheduler-adapter 33、bash-async 17、bash-async-runtime.integration 13、task-scheduler-runtime.integration 2 | 72 | — |

- `npm test` glob 为 `test/**/*.test.mjs`：`*.integration.mjs`（不以 `.test.mjs` 结尾者）不在主 glob；`npm run test:all-integration`（`scripts/run-integration-gate.ts`）自动枚举全部 `test/*.integration.mjs`（含 background-activity-runtime），排除表当前为空。

## 4. V1–V14 逐项映射（真实入口 / fixture 注入 / 证据分层 / 状态 / 清理边界）

状态口径：`ready-harness`=L2 机器证据可在隔离 harness 取得；`user-signoff`=最终观感需用户现场；`fake-proven`=L1 已有断言。0 项 blocked。

| # | 观察点 | 真实入口 | fixture 注入 | fake-proven | real-Host 可证（L2 证据） | user-signoff | 清理边界 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | 三 source 同场 | launcher + `-e` 清单（custom-footer/background-activity/fixture-sources） | 三 fixture publisher 同 epoch 注册 | 是（`rendered()` 含 `⏱/每日巡检/●`，integration L390-392） | ANSI 流同帧含 `●/⌘/`+三 label；纯布局回放同输入一致 | 同屏无遮蔽感知 | 临时根内注册，quit 即 teardown |
| V2 | 顺序与稳定 | 同上 | 固定 rows 顺序 | 是（layout 顺序测试） | 连续 N 帧（reconcile 500ms×k）行序不变 | 无跳动感知 | 同上 |
| V3 | 状态列/图标分离 | 同上 | 状态词表全枚举（`运行中/待处置/running/outcome·delivery/等待触发…`） | 是（state label 单测） | ANSI 文本逐词匹配；图标列宽=visibleWidth | 可读性 | 同上 |
| V4 | Alt+O 跨 source | 真实快捷键链（§2.4） | 三 source 各 ≥2 行供 `←/→` | 是（`altO()`/overlayInput 断言） | PTY `\x1bo`→overlay 帧；`\x1b[D/\x1b[C` 切换 `N/M` 与 `›` 位置；无任务副作用（fixture controller 无 cancel 面可抛错自证） | 键感 | overlay 随 Esc/Alt+O 关闭恢复 |
| V5 | 中文长命令换行 | 同上 | label 含 CJK+ASCII 混合长串（**含 §5 截图同形串**） | 是（wrap 单测） | ANSI footer 区逐行 == `renderActivityLayout(rows, cols)` 期望串（**精确字符串相等**） | 断行美观（用户投诉点，见 §5） | 无 |
| V6 | 窄宽 | python pty winsize cols∈{20,30,40,60} | 同 V5 | 是（窄宽单测） | 每帧每行可见宽 ≤ cols；降级序 gap→sel→pad；图标最后消失 | 观感 | resize 回原尺寸可复原 |
| V7 | 窄高 rows≤4 | winsize rows=4 | 有行 fixture | 是（too-small 单测/集成） | rows=4 发 Alt+O：无 overlay 帧、editor/draft 区不变；rows 恢复后可开 | 观感 | 同上 |
| V8 | 主视图溢出 | winsize rows 小 + rows 多 | main 行 > 预算 | 是（溢出单测） | 末行 `还有 N 项 · Alt+O`、`◯ recent N` 单行 | 观感 | 无 |
| V9 | theme | `--use-theme` 双跑 / 临时 themes 文件改写（watcher） | 无 | 部分（theme 重取单测） | ANSI 色彩序列变化 + 详情重取帧 | 配色/残影感知 | 主题写回仅临时 agentDir settings |
| V10 | Esc 草稿 | 真实 editor 链 | PTY 键入 fixture 草稿 | 是（draft 恢复断言） | 草稿串完整、无追加字符、overlay 消失 | 观感 | draft 仅内存 |
| V11 | raw outputs | 同上 | bash fixture terminal `content` 原文+非文本块；subagent fixture child JSONL（asyncDir trusted root 内） | 是（details 单测 raw 透传） | ANSI 详情文本与 fixture 原文逐字一致；临时 sessionDir JSONL 只含 fixture 文案 | 观感 | 临时 sessionDir 随根销毁 |
| V12 | stale/unavailable | 同上 | fixture observer `availability=stale/unavailable` | 是（availability 单测） | 独立状态行 `过期观察…/暂不可用`；main/recent 计数不含旧行 | 观感 | 无 |
| V13 | reload/new/resume/fork | PTY 发 `/reload`、`/new`、`/resume`(临时 fixture session)、`/fork` | 临时 sessionDir 自造 fixture JSONL（先例 freeSession 同形） | 是（epoch/token 集成断言） | 每 epoch 单 footer（ANSI 无重复安装痕迹/无双 glyph 块）；reload 后同分区 roster 仍在帧内 | 无闪烁感知 | session owner 临时 registry；quit 释放 record |
| V14 | RPC 模式 | `--mode rpc`（管道即可，无需 PTY）+ JSONL client（SDK `examples/rpc-client.ts` 同形） | 三 fixture publisher（rpc 门禁应拒绝发布） | 是（RPC 零 UI 断言） | stdout 仅协议记录、零 footer/overlay 字节 | 不需要（协议面） | 进程退出即清 |

## 5. 真实用户截图样例分析（父层 steering 纳入）

样例：`/var/folders/27/…/pi-clipboard-8df89397-7147-4f20-a090-8ed12c7e51e9.png`（本窗口只读该 PNG，未读其对应真实 session/settings/token）。

### 5.1 截图可见事实（逐行）

1. `~/brightness-control`（左）/ `1.4%/900k`（右）——第 1 行 cwd+context，右对齐到终端宽。
2. 空左区 / `(codex-pool) gpt-6.1-sol`（右）。
3. 空左区 / `thinking: low`（右）。
4. `› ● 在  /Users/leshi.zhy/brightness-control 只读诊断用户刚报告的 b (del`＋行末右对齐 `运行中`。
5. 续行 `egate)`，缩进对齐 label 内容列。

### 5.2 设计 vs 回归判定（代码级，三项均为现行设计）

| 观察特征 | 判定 | 代码证据 |
| --- | --- | --- |
| `(delegate)` 被拆成 `(del` / `egate)`（词内断行） | **设计行为**（非回归）：换行是字素级贪心，不做词边界优先 | `layout.ts:215` `wrapByVisibleWidth`：`GRAPHEME_SEGMENTER` 逐字素累加、超宽即断；注释明示「CJK 无空格也适用」；无 word-boundary 逻辑 |
| 状态列 `运行中` 位于换行首行最右 | **设计行为**：状态列独立于 label，挂首行（放得下时），续行只对齐 label 列、不带状态 | `layout.ts` `composeEntrySegments`（`:333-360`）：`stateFits` 时首行 = chrome+label 首段+状态列；续行 segments 无状态 |
| 右元数据（provider·model / thinking）独占第 2/3 行、左区空 | **设计行为**：槽位行内联要求条目**单行**且首行宽 ≤ 左预算；需换行的条目整体下移全宽行，右元数据仍占槽位行右半 | `layout.ts` `renderActivityLayout`（`:530+`）：`composed.continuations.length === 0 && firstLinePlainWidth <= leftBudget` 才内联；否则 `joinLeftRight("", right, width)` + 入 pending 全宽阶段；架构文档 §7 行 4 同载「含因右元数据预算不足或 label 需换行而整体下移者」 |
| 续行缩进 = label 内容列（pad1+sel2+glyph1+gap1=5 列） | 与设计一致 | `layout.ts` 续行空格对齐 + 常量 `:75-79` |

- **不算错位的谓词（合同固化）**：词内断行、换行条目下移全宽行、右元数据独占槽位行右半、状态挂首行——均为设计；**算候选错位/回归的谓词**：任一行可见宽 > cols；续行缩进 ≠ label 内容列；状态与 label 重叠或挤掉 label 身份列；glyph/行序违反 `ACTIVITY_KIND_ORDER`；footer 物理行 > `terminalRows-6`；选中行缺 `›`；右元数据未右对齐到 cols。
- **产品决策候选（不在本合同内修）**：ASCII 词感知换行（避免 `(del/egate)` 式断词）。若要做，属独立授权的行为变更任务；视觉 harness 只记录现状基线，不预设其缺陷。
- 与 0f34527a 只读诊断的关系：本节只做「显示合同判定」，不重复其根因调查；若其结论与本节谓词冲突，以双方共同可复算的纯布局回放（§5.4）为准仲裁。
- 行网格级审计（续行缩进/跨行左沿/state 列语义/旧 footer 差异/最小统一对齐方案/不可裁决用户语义）见 **§5.5**；「缩进也有问题」的用户感知在该节按「代码对齐保证 vs 感知候选」双层记录，两者可同时成立。

### 5.3 精准复现输入与 cols 获取（纳入视觉合同）

复现该帧所需的**完整输入向量**：`{cols, rows, theme, meta:{cwd, home, contextLabel, providerModelLabel, thinkingLabel}, rows[]:{key,kind,label,stateLabel,placement}, selection}`。截图可读者：cwd=`/Users/leshi.zhy/brightness-control`、home=`/Users/leshi.zhy`（`~` 缩写）、contextLabel=`1.4%/900k`、providerModelLabel=`(codex-pool) gpt-6.1-sol`、thinkingLabel=`thinking: low`、单行 subagent（selected，state=`运行中`）、label=`<title> (delegate)`（`subagent-activity.ts:51-54`：label = `${title} (${agent})`）。

**unknown（不得推定）**：cols/rows（PNG 像素≠列数，缺字体度量）；theme 名（观感似 dark，未证）；title 原文（截图只给换行后投影，`的 b` 与 `bug` 等不可分辨）；model id 是否被截断；该窗口的 session id/token（禁止且无需）。

cols/复现输入取得方式（合同步骤）：
1. **harness 运行**：cols/rows 由 driver 构造即知（`TIOCSWINSZ`），无需推定。
2. **用户真实窗口**：请用户在同一终端执行 `stty size`（或 `tput cols`/`tput lines`）回传；title 原文由用户提供或在其授权窗口内从该 session 的 title registry/roster 读取（本窗口不读真实 session 正文）。
3. **离线仲裁回放**：取得 `{cols, rows, meta, rows[], selection}` 后，直接调用纯函数 `renderActivityLayout`（`src/background-activity/layout.ts`）算期望行数组，与截图逐行比对——**不启动 Host 即可判定该帧是否偏离现行布局合同**；此步骤留给后续授权窗口或用户侧执行。

### 5.4 该样例对 V 项的映射

- 命中 V5（中文长 label 换行）与 V3（状态列位置）的**设计基线**；将其作为 V5 的固定回归样例输入（同形串入 fixture label 集）。
- 该帧本身属「真实用户 Host + 真实 session」证据，隔离 harness 只能复现同输入向量下的等价帧；**用户窗口观感签核不可由 harness 替代**。

### 5.5 行网格精确审计（父层 steering 追加：缩进与整网格，不止换行）

口径：本节只描述**现行代码保证的网格**与**用户感知候选**两层，二者可同时成立；不称用户误解、不归因字体缺失、不把任何硬编码缩进（含 5 列）称作「已证正确」。截图实列数 **unknown**；若后续授权窗口以 `cols=78` 做纯函数回放，该值仅为回放假设，**不是真实终端测量**。

#### 5.5.1 主视图各行类的左右沿合同（现行代码）

| 行类 | 左沿（文本起始列，1-indexed） | 右沿 | 证据 |
| --- | --- | --- | --- |
| cwd / context 行、meta 槽行（`joinLeftRight`） | 左文本 col 1（无 pad）；meta-only 行左区全空 | 右文本止于 col W | `layout.ts:469-481` |
| activity 首行（全宽阶段） | chrome：pad=col1、选择列=cols2-3（`› ` 或两空格）、glyph=col4、gap=col5 → **label=col6** | state 段 = chunk0 后 +1 空格；**仅当 chunk0 填满 wrapWidth 时止于 col W**，否则停在行中 | `layout.ts:333-360`（`composeEntrySegments`）、`:530+` |
| activity 续行 | cols1-5 为空格（`" ".repeat(chromeWidth)`，● 时 chromeWidth=5）→ **文本 col6 = 首行 label 列** | ≤ W | `layout.ts:352-356` |
| activity 首行（槽位内联阶段） | 同 chrome/label 列；**仅单行条目可内联**（`continuations.length===0 && firstLinePlainWidth<=leftBudget`） | state 同上行类；同行右半挂右元数据止于 col W | `layout.ts:560-585` |
| 信息行（`◯ recent N` / stale / unavailable） | 与条目同 chrome 网格但选择列恒空 → 文本 col6；超宽截断单行 | ≤ labelColumns | `layout.ts:396-412` |
| 溢出提示行（`还有 N 项 · Alt+O`） | pad1 → **文本 col2**（与条目 label 列、cwd 列均不同） | 截断于 W-1 | `layout.ts:414-424` |

**state 列不是跨行固定右列**：每行 state 的 x = 该行 chunk0 宽 +1 空格；长 label 行因 chunk0 饱和 wrapWidth 而「看起来贴右沿」（截图即此情形），短 label 行 state 停在行中。多行混合时 state 不形成竖直列——这是现行合同的真实网格属性（架构文档只承诺「独立状态列」段，未承诺跨行右对齐）。

**续行前导空格保留**：`wrapByVisibleWidth` 只 trim 行尾空格（`replace(/ +$/,"")`），**不 trimStart 续行 chunk**（`layout.ts:215-241`）；若断点落在空格前，续行可见缩进 = chromeWidth + k（k≥1）。本截图 k=0，但该机制存在，属网格级潜在不一致点（旧 selector 的 `wrapSelectorItem` 对 content 做 `trimStart()`，`footer-runtime.ts:252`）。

**selected/unselected 同网格**：选择列恒 2 列（`› ` 或两空格，`buildChromeSegments` `layout.ts:283-293`），选中只换标记不换列宽 → 选中切换不扰动网格。

#### 5.5.2 截图帧可见空格示意（W unknown；`·`=空列，`[sp]`=一个可见空格，中部省略）

```
col   1         11        21        31        41        51        61   …   W
L1    ~/brightness-control············································1.4%/900k
L2    ·································································(codex-pool) gpt-6.1-sol
L3    ·································································thinking: low
L4    [sp]›[sp]●[sp]在[sp][sp]/Users/…刚报告的 b (del[sp]运行中
      ^pad ^sel2  ^glyph ^gap ^label=col6                      ^state=chunk0+1sp（饱和→贴 W）
L5    [sp][sp][sp][sp][sp]egate)
      ^——— chromeWidth=5 缩进 → 文本 col6（== 首行 label 列）
```

代码保证面：L5 文本列 == L4 label 列 == col6（显示列口径）。感知候选面见 5.5.4。

#### 5.5.3 与旧 standalone footer 网格的差异（行为变化，非「旧错新对」）

| 网格属性 | 旧 standalone（仍为 fallback 路径） | 新统一 layout | 证据 |
| --- | --- | --- | --- |
| 换行算法 | **词感知**（`split(/\s+/)` 贪心拼词；仅单词超宽才硬切）→ 不会拆 `(delegate)` | **字素贪心**（逐 grapheme 累加超宽即断）→ 可拆 `(del/egate)` | `footer-runtime.ts:248-281` vs `layout.ts:215-241` |
| 续行缩进 | `prefixLength`（item 以 `› `/两空格起头时 4，否则 2）；`layoutFooter` 多行 left 的续行 **col1** | 恒 `chromeWidth`（● 时 5）→ col6 | `footer-runtime.ts:280`、`footer-layout.ts:10-13` vs `layout.ts:352-356` |
| 额外 selector 条目 | 每条独立成行、col1 起带自身 prefix | 统一 entry 网格逐条全宽块 | `footer-runtime.ts:423-431` vs `layout.ts:596-604` |
| 右元数据 | 三行固定 `layoutFooter(left,right)`，left 可多行且续行 col1 | 槽位行右半 + 换行条目下移全宽行 | `footer-layout.ts:4-20` vs `layout.ts:560-585` |

结论：用户「缩进也有问题」的感知若以**统一前 footer 的肌肉记忆/并窗对照**为基线，则对应真实的行为变化（缩进 2/4/col1 → 5；词感知 → 字素贪心）；若以**统一合同**为基线，则截图帧的续行缩进与 label 列一致、属设计。两判定并行记录，不互斥。

#### 5.5.4 代码对齐 vs 用户感知（可同时成立，不互斥）

- 代码保证：续行文本列 == 首行 label 列（显示列）；selected/unselected 同网格；信息行同网格；每行不越 W（`fitEntryColumns` 降级序 gap→sel→pad）。
- 感知候选（本窗口不裁决）：(a) 续行 col6 与 cwd 行 col1、溢出行 col2 的**跨行类左沿不一致**；(b) meta-only 槽行左区全空与全宽 activity 行的上下关系；(c) state 跨行不形成竖直列；(d) 断点前导空格使个别续行 +k 列；(e)  ambiguous-width 字形（`● › ◯ ⌘ ⏱`）与 CJK 双宽在用户终端的实际渲染列宽若与 `visibleWidth` 假设不同，感知网格整体平移——此为**环境测量未知**（需 TERM_PROGRAM/字体信息），不是用户错误，也不得反过来说用户感知无效。
- 明确禁止的糊弄手段（合同写入）：不以隐藏 state、不截 label（`…` 截身份）、不把 meta 行删除来「对齐」；任何对齐改动必须保持 label 身份列与 state 可见。

#### 5.5.5 主视图 / overlay 各自边界

- 主视图：物理行预算 `max(0, terminalRows-6)`；上述网格仅作用于 footer 区；chat 区不归本合同。
- overlay（详情壳）：独立网格——overlay 静态 `margin.bottom=4`、正文 `bodyRows=terminalRows-4`、正文行 col1 起（transcript 投影，不复用 entry chrome）；详情 footer ≤3 行且 col1 起（`N/M <glyph> label · state` 等）。**错位指控必须声明区域**（主视图 footer / overlay 正文 / overlay footer），跨区域套用同一网格谓词无效。

#### 5.5.6 最小统一对齐方案（设计提案，需独立授权；harness 只记现状基线）

1. **state 真右列**：全宽阶段首行 = chrome + chunk0 + 补空格至 `W-1-stateWidth` + state，使 state 跨行竖直右对齐；槽位行同改；不截 label、不隐藏 state。
2. **续行 trimStart**：`wrapByVisibleWidth` 输出 chunk 去前导空格（或断点空格归并到行尾 trim），续行缩进恒 == chromeWidth。
3. **左沿两级化并文档化**：文本左沿只允许 {col2（cwd/meta/溢出行，pad1）, col6（entry/信息行 label 列）} 两级；cwd/meta 左文本加 pad1，溢出行保持 pad1。
4. **meta 槽多行化**：右元数据超右预算时不再 `truncateToWidth(…)`，改为槽内右对齐续行或下移全宽 meta 行（保身份不截断）。
5. **换行策略产品决策**：字素贪心 vs 词感知+字素兜底（CJK 无空格场景保留字素兜底）——独立决策项，视觉 harness 不预设。

#### 5.5.7 无法裁决的用户语义（明确列出，留待用户/主管代询）

- U1 续行期望对齐沿：label 列(col6) / cwd 沿(col1) / glyph 列(col4) / 旧 footer 沿(col1|3|5)。
- U2 meta-only 槽行左空是否被感知为错位。
- U3 投诉基线是统一前 footer 还是统一合同（决定是否按「行为变化」立项）。
- U4 state 期望语义：随行 after-label vs 跨行竖直右列。
- U5 用户终端对 ambiguous-width 字形与 CJK 的实际列宽（需终端/字体信息）。
- U6 截图 label 中「在  /Users」双空格属 title 数据还是渲染产物（需 title 原文）。

## 6. 三层区分总结（不冒充视觉通过）

- **fake TUI 已证**：握手/幂等/epoch/RPC 零 UI/late fence/draft 恢复等协议与渲染合同（F6v：13/13、98/98、71/77；6 例 blocked-environment 保持原分类，不转绿）。
- **真实 Host 可证**：V1–V14 的字节/几何/键位/生命周期面（L2，命令草案 §3.2；需 visible-host 授权窗口）。
- **用户观感必须确认**：配色、闪烁/残影、断行美观（含 §5 投诉面）、IME、以及「真实用户窗口同帧」签核；合同内永久记 `pending-user`，L1/L2 通过不自动升级。

## 7. 证据索引（file:line）

- 模式/TTY：`node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js`（`resolveAppMode` 函数体）、`dist/main.js:518,759-796,765-772`、`dist/bundle/chunks/chunk-H33F2TZD.js`（`main()`：piped-stdin 降级、无 model 仅非 interactive 退出、`shouldRunFirstTimeSetup` 调用）。
- 首启/信任/会话：`dist/cli/startup-ui.js:98`；`dist/core/session-manager.js:644-660,691-716,779-784`。
- ANSI 日志/尺寸/raw mode：`node_modules/@earendil-works/pi-tui/dist/terminal.js:88-100,114-115`（含 `columns/rows` 的 COLUMNS/LINES 兜底与 `refreshTerminalDimensions` 自 SIGWINCH）。
- 真实 ui 面/快捷键：`dist/modes/interactive/interactive-mode.js:352,880-881,1707-1760,2048-2099,2268-2269`；`dist/core/agent-session.js:2917`；`dist/core/extensions/types.d.ts:213-253,1198-1201,1371`；`dist/core/event-bus.d.ts:1-4`。
- footer/owner：`packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`（`teardown`:596、`enterBrowser` 门禁:630、owner 段:686+、`installFooter`（F6v 记 :722/:725）、`openBrowser`、`session_start`、`isCurrentSessionEvent`、`browserTrustedSessionRoots`:327-333）；`extensions/custom-footer.ts:14-24`。
- 布局：`src/background-activity/layout.ts:62-79,215-241,333-360,469-481,530+`；presenter：`src/background-activity/presenter.ts:56-140`。
- source/label：`packages/pi-subagents-enhanced/src/tui/subagent-activity.ts:45-82`；`session-browser.ts:206-315`；`browser-adapter.ts:13-52`。
- 接线/公开入口：`pi/extensions/background-activity.ts:74-134`；`pi/extensions/bash-cwd.ts:25-46`；`pi/extensions/task-scheduler.ts:17-42`；`src/bash-async/index.ts:211,265`；`src/task-scheduler/{index.ts,adapter.ts:5,349,474,534}`。
- 集成/先例：`test/background-activity-runtime.integration.mjs:1-320,384-463`；`test/session-owner-runtime.integration.mjs:65-130,453-634`（经 `docs/research/2026-10-14-session-owner-pty-readiness.md` §2-§3、§5-§9 转引）；`docs/session-owner.md`（启动矩阵/unsupported 边界）；`scripts/pi-launcher.zsh:1-59`；`scripts/pi-shell.zsh:9-16`；`scripts/assert-session-tool-policy.ts:1-11`；`scripts/run-integration-gate.ts:14-33`。
- SDK 文档：`docs/tui.md`（PI_TUI_WRITE_LOG/overlay/theme）、`docs/cli.md`（modes/`--no-session`/`--session-dir`/`-ne`/`-e`/`--offline`/`--use-theme`/`--tui-mode`）、`docs/environment-variables.md`（PI_CODING_AGENT_DIR/SESSION_DIR、PI_OFFLINE、PI_TUI_ESC_TIMEOUT）、`docs/slash-commands.md:49`（/reload）、`docs/sdk.md`。

## 8. 本任务边界复核

未启动真实 Host/任务/provider/网络/通知；未 kill 任何进程（含自进程树）；未读 settings/models/auth/credential/真实 session/authority/state 正文（`pi/` 仅列目录名）；未修改 production/test/文档（除本写路径）；未 stage/commit/stash/reset；未使用 MCP/tdd；未清理 worktree；越界需求（如读取用户真实 session 取 title 原文、运行 L2）一律留给授权窗口或经主管代询。
