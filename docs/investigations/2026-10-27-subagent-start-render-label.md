结论：`subagent_start` 显示成 `subagent start` 源于本仓 start 专用 renderer 的硬编码，并非 Host 把下划线转为空格；成功后仍保留该标题，还与同一工具卡先渲染 call、后写入成功摘要且隐藏 result 的刷新顺序有关，已用实际 Pi 工具卡离线复现。

本报告仅诊断与设计，未修改 production、未新增测试、未启动真实 provider、未 stage/commit。依据当前工作区源码与本地依赖：`@earendil-works/pi-coding-agent@1.4.0`、`pi-subagents@0.80.0`（各自 `package.json:3`、`:4`）。现场已有大量未提交修改，以下行号针对当前工作区，不代表历史提交或用户当时进程已加载的版本。未读取用户会话或截图，因此能确认源码行为与可达路径，不能认定用户看到的具体屏幕位置及当时刷新次数。

**准确来源与普通工具对比**

首个生成该显示文本的位置是 `packages/pi-subagents-enhanced/src/tui/tool-renderers.ts:56`，函数 `spawnStartingSummary`：

```ts
return agent && title ? `subagent start\n${agent}: ${title}` : undefined;
```

这里根本没有对 `subagent_start` 做字符串替换：注册时注入的工具名在 `compact-rendering.ts:12` 映射为 operation `start`，`spawnStartingSummary` 据此走专用分支，然后完全独立地拼出固定文案。其前提是 args 中的 `agent` 和 `title` 均为非空字符串；缺少 title 时走普通工具名分支。title 在公开 schema 中可选，generic 执行会生成默认 title（`subagent-dispatch/extension.ts:1271`），这不会反向补写原调用 args。

下表中的实现路径均位于 `packages/pi-subagents-enhanced/src/`：

| 工具 | definition 中的 name / label | 实际 call 渲染 | result 渲染 |
| --- | --- | --- | --- |
| `subagent_start` | `subagent-dispatch/operation-tools.ts:207`：`subagent_start` / `Subagent Start` | 与 run 工具共用 `renderSubagentCall`，但命中 start 专用摘要；输入有 agent/title 时显示两行 `subagent start`、`agent: title`（`tui/tool-renderers.ts:49`、`:69`） | 专用 spawn summary 写 `context.state.subagentSpawnSummary`；成功且存在 state 时返回空 Text（`:85`、`:97`、`:98`） |
| `subagent_run_status` | `operation-tools.ts:227`：`subagent_run_status` / `Subagent Run Status` | 不命中 spawn，直接显示 `context.tool`，可附 ` · id`（`tool-renderers.ts:73`、`:78`） | `formatCompactSubagentToolResult` 投影为 `Status: ...`（`compact-rendering.ts:321`、`:367`） |
| `subagent_run_steer` | `operation-tools.ts:241`：`subagent_run_steer` / `Subagent Run Steer` | 同 status，保留完整下划线工具名 | 独立结果正文 `→ [steer] ...`，不替换 call 工具名（`compact-rendering.ts:175`） |
| `subagent_run_interrupt/resume/stop` | 同一 `operation-tools.ts` descriptor 表 | 同一普通 call 分支，保留下划线 | 按 operation 投影对应结果，非 spawn state 路径 |
| `managed_workspace_list/status/dispose/release` | `workspace/operation-tools.ts:60` 起的四个 descriptor，label 为 `Managed Workspace ...` | production 未注入 `renderWorkspaceCall/Result`，由 Host 已知工具 fallback 直接显示 name | Host 默认结果文本 |
| `supervisor_request_pending/status/reply` | `subagent-dispatch/supervisor-operation-tools.ts:118` 起；name 为 `supervisor_request_*`，label 为 `Subagent Supervisor ...` | 共用 `renderSupervisorCall`，直接取 `context.tool`；可附完整 request id（`tool-renderers.ts:111`、`:119`） | 共用 supervisor formatter；reply 的 `→ [reply] ...` 属于结果正文，不是 call 名称改写 |

所以“只有 start 特殊”应精确理解为：同一 subagent renderer 内，只有 start 命中启动摘要和摘要搬入 call 的分支；并不是只有 start 注册了 renderer。workspace 恰恰才是无自有 renderer 的同族工具，其默认显示仍保留下划线。`Subagent Start` 这个 definition.label 的大小写与 `subagent start` 也不同，实际工具卡路径没有读取该 label 来生成标题。

**从 typed definition 到主对话工具卡的完整路径**

1. 包入口由 `packages/pi-subagents-enhanced/package.json:21` 声明为 `extensions/subagent-runtime.ts`。入口在 `subagent-runtime.ts:216` 创建 `createSubagentToolRenderers()`，`:332` 调用 `installHeadlessTypedSubagentRuntime`，`:482` 传入 subagent、supervisor 的 call/result 回调；没有传入 workspace renderer。
2. `src/subagent-dispatch/operation-tools.ts:312` 的 factory 将 descriptor.name、label、schema 与 execute 组装成 definition；`:319` 返回模型工具，exposure 为 `model-only`。start 调 `executeStart`，run 工具固定注入 action 后调用控制闭包。显示名与执行协议名是两条独立路径，没有把注册名改成带空格版本。
3. `src/subagent-dispatch/extension.ts:2367` 的 `withToolRendererHint` 包装回调，把 `definition.name` 放到显示 context 的 `tool` 字段。`:2377` 组装 subagent 工具，`:2381` 组装 workspace 工具，`:2389` 组装 supervisor 工具；`:2401`、`:2402`、`:2521` 分别 `pi.registerTool`。旧 union 定义只是内部执行闭包宿主，不作为第二组模型工具注册。
4. Host `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:234` 的 `registerTool` 按 `tool.name` 保存完整 definition；`core/agent-session.js:2870` 的 `_refreshToolRegistry` 汇入 `_toolDefinitions`，`:1110` 的 `getToolDefinition(name)` 按原名取回。
5. `dist/modes/interactive/interactive-mode.js:1705` 的 `getRegisteredToolDefinition` 先经过 `extensionRunner.resolveToolRenderers`。`dist/core/extensions/runner.js:542` 按扩展注册顺序执行 resolver/next 链，最后取 definition 与内置 renderer。
6. 根扩展 `pi/extensions/compact-tools.ts:13` 确实注册了通用 compact resolver，但 `src/compact-tools/index.ts:94` 仅对自有工具命中；subagent/workspace/supervisor 不在 owned 表内，`:96` 返回 `next()`，没有 humanize。`dist/core/tools/renderers/index.js:35` 的 `withBuiltInRenderers` 仅补内置 read/bash/edit 等回调，也没有 subagent 特判。
7. `interactive-mode.js:2811` 在流式 assistant toolCall 中创建 `ToolExecutionComponent`，后续参数更新调用 `updateArgs`；`:2882` 在执行开始事件中按需创建同类组件并 `markExecutionStarted`；`:2903` 在执行结束事件中 `updateResult`，然后请求 TUI 绘制。工具名始终来自原始 `content.name` 或 `event.toolName`。
8. `dist/modes/interactive/components/tool-execution.js:74` 构造回调 context：含原始 args、共享 state、isError 等，原生没有 tool 名，所以本仓第 3 步的按名注入是必要接线。`:199` 的 `updateDisplay` 选择 pending/error/success 背景，并先 call 后 result。`:221` 调自有 `renderCall`，`:243` 调自有 `renderResult`；后者只收到 `{content, details}`，错误信号另经 context.isError 传入。
9. 本仓 `tui/tool-renderers.ts:69` 消费 name hint，进入本文首段的 `:56` 硬编码。成功结果则经 `compact-rendering.ts:166` 的 `formatCompactSubagentSpawnSummary` 生成 `* subagent started <agent>: <title>`（实际拼接位于 `:172`），并由 renderer 写入显示 state。工具执行结果和模型收到的数据都没有被改名。

上游 `pi-subagents` 也有原生 renderer，但不是本问题的显示所有者。其 `node_modules/pi-subagents/src/extension/index.js:611` 定义的是旧工具 `subagent`，`:620`、`:633` 定义原生 call/result，`:641` 调 `registerPinnedTool`；`src/extension/declaration-pinning.js:40` 最终仍调用 `pi.registerTool`。增强包在 `src/subagent-dispatch/extension.ts:2743` 用 `createHeadlessSubagentApi` 引导 upstream；`runtime-membrane.ts:175` 拦截工具注册，仅捕获旧 supervisor 的 execute，`:192` 起拒绝未允许的 register API，白名单在 `:1` 只含 message/entry renderer。上游不会额外给 `subagent_start` 装一个覆盖本仓定义的工具 renderer。

**Host 已知/未知工具的 fallback 都不做下划线 humanize**

- 已有 definition 但没有 renderCall，或自有 renderCall 抛错：`tool-execution.js:215`、`:226` 调 `createCallFallback`，`:95` 将 `this.toolName` 原样交给 `dist/core/tools/render-utils.js:81` 的 `formatToolCallWithArgs`。后者只加样式和参数，不替换 `_`，也不使用 definition.label。
- 没有 definition：`tool-execution.js:262` 调 `formatToolExecution`，`:312` 直接 `theme.bold(this.toolName)`；参数 JSON 与结果附在后面，同样保留 `_`。
- 成功/失败改变的是背景和结果投影，不会使 Host 切换到另一套工具名 humanize 规则。针对根 src、pi/extensions、增强包以及相关依赖 core/modes/upstream 源码的搜索，未发现这条链路存在 `_` 转空格逻辑；具体分支代码和离线输出共同支持这一判断。

**为什么调用成功后仍可能显示 `subagent start`**

成功结果正常含结构化 agent/title：coding 路径在 `subagent-dispatch/extension.ts:1229` 构造 handle，并于 `:1245` 返回；generic 路径在 `:1385` 返回相同身份字段。因此这里无需假设缺字段或畸形结果。

实际顺序如下：

```text
tool_execution_end
  → ToolExecutionComponent.updateResult(result)          tool-execution.js:134
    → updateDisplay()：先切到成功背景                   :200
    → renderCall(args, context)：读取旧 state            :221
      → new Text("subagent start\nagent: title")         本仓 tool-renderers.ts:82–83
    → renderResult({content, details}, context)           Host :243
      → state.subagentSpawnSummary = "* subagent started ..."
      → 返回空 Text                                     本仓 :97–98
  → requestRender()                                     interactive-mode.js:2910
```

call 回调已经创建了内容固定的 Text，之后仅修改 state 不会更新这个 Text。result 回调既不更新 call 组件，也不触发使 call 重建的操作。因此第一次成功绘制仍可能保留启动标题，结果正文又被隐藏。直接再次 `render(width)` 也不重跑 `updateDisplay`；直到 `invalidate()`、展开切换等导致 `updateDisplay` 再次运行，call 才读到成功摘要（Host 的 `invalidate`、`setExpanded` 分别见 `tool-execution.js:155`、`:139`）。

这不是只凭静态顺序推测：本次离线诊断加载本仓实际 SDK 的公开 `ToolExecutionComponent` 与增强包 `createChildConversationRenderers`，仅构造内存 args/result 和组件，没有调用工具 execute、没有创建真实 Host 会话。输出为：

```text
调用中: ["subagent start","delegate: 调查显示标签"]
成功后首次渲染: ["subagent start","delegate: 调查显示标签"]
再次 render（未 invalidate）: ["subagent start","delegate: 调查显示标签"]
invalidate 后: ["* subagent started delegate: 调查显示标签"]
subagent_run_status 自定义: ["subagent_run_status · diagnostic-run"]
subagent_run_steer 自定义: ["subagent_run_steer · diagnostic-run"]
supervisor_request_status 自定义: ["supervisor_request_status · request: diagnostic-request"]
managed_workspace_list 已知无renderer: ["managed_workspace_list"]
subagent_start 已知无renderer: ["subagent_start agent=\"delegate\" task=\"只读调查标签\" title=\"调查显示标签\""]
subagent_start 未知: 首行 "subagent_start"，随后为原参数 JSON
原始 args/result 未改写: true
```

诊断的核心调用顺序可复用为 `new ToolExecutionComponent(...) → render(120) → updateResult(success) → render(120) → render(120) → invalidate() → render(120)`；主题通过 `sdk.initTheme("dark", false)` 初始化，ANSI 使用 `stripVTControlCharacters` 去除。已知无 renderer 对照显式传入不同于 name 的 label，以证明该 label 不会被 Host 当成工具卡标题；renderer 对照使用同一共享回调及按名 hint，未运行后台调度。

现有 `test/subagent-runtime-membrane.test.mjs:705` 的 spawn 用例显式断言初始两行 `subagent start`，随后调用 result，再手动调用一次 `renderSubagentCall` 验证 `* subagent started`（`:724`、`:733`、`:738`）。它证明摘要状态可读写，却没有覆盖实际 Host 首次成功绘制的先 call 后 result 顺序。因此该用例通过不能排除上述现象。

数据来源分类：标签硬编码和刷新顺序均位于正常 production 渲染路径；输入字段来自公开 typed schema，成功 agent/title 来自正常 execute 返回。离线对象仅重放这些合法字段和 Host 事件顺序，不是为缺字段 mock 增加兼容需求。未执行真实 provider，故本报告不声称复现了用户原会话的具体事件、run 身份或屏幕快照。

**后台活动标题是另一条链路**

活动行不消费 `ToolDefinition.name`，也不经过 `spawnStartingSummary`：

```text
typed 派发 title / task 默认 title
  → titleRegistry.prepare / remember
  → subagent:async-started（或 status reconcile）
  → SubagentSessionBrowserState 的 BrowserChild.label
  → subagentActivityLabel(child)
  → ActivityRow.label
  → 根 presenter / layout
```

可逐段核对：

- `subagent-dispatch/title-registry.ts:4` 仅 trim、校验单行/长度/控制字符，没有 `_` 替换；`:40` prepare、`:44` started、`:72` titleFor 保留任务 title。coding 的 prepare/remember 位于 `extension.ts:1104`、`:1228`；generic 位于 `:1320`、`:1379`。
- `subagent-dispatch/runtime-membrane.ts:31` 用 titleRegistry 关联生命周期事件；`tui/footer-runtime.ts:994` 接收 async-started，缺 event title 时查询 registry，再于 `:999` 调 browser.trackStarted。
- `tui/session-browser.ts:234` 读取 event.title，`:252` 存为 child.label；`:301` 的 status reconcile 读取 step.label / step.title / existing.label。
- `tui/subagent-activity.ts:51` 的 `subagentActivityLabel` 取 registry title，回落 child.label；`:53` 输出 `<title> (<agent>)`，缺 title 才只显示 agent。`:102` 起组装 ActivityRow。`footer-runtime.ts:985` 创建该 source；旧 selector 同样在 `:243` 取 title。
- `src/background-activity/presenter.ts:260` 将 registry 行送给 `renderActivityLayout`；`layout.ts:294` 起投影 row.label，`:224` 的清理只去终端控制序列、制表符和控制字符，`:437`、`:455` 展示标题，未将工具名转为空格。

因此，若用户看到的是后台活动行，其文字应先核对实际任务 title/child.label，不能据 `subagent start` 四字推定是工具卡；若 title 自身恰为该字符串，活动行当然可以照常显示它，但这不是工具名格式化。当前有直接源码与组件证据的来源是主对话 start 卡。

还需区分“后台活动标题”与“后台详情中的子会话工具卡”：后者在 `tui/footer-runtime.ts:949` 使用 `NativeChildConversationRenderer(createChildConversationRenderers(...))`，`tool-renderers.ts:149` 起为 typed 工具绑定同一 renderer，`native-conversation.ts:257` 创建实际 Host 工具卡、`:275` 更新结果。所以后台详情正文中的历史工具卡也可复用上述显示行为；这不意味着 ActivityRow.label 由工具名产生。正常 child 工具准入与历史记录是否包含 start 另属运行事实，本次没有推定某个 child 实际调用了它。

**最小修复方向，仅设计**

建议在增强包现有 TUI 层统一 start 与同族 run/supervisor 的显示机制：

1. start 的 call 标题同样从已注入的 `context.tool` 取 `subagent_start`，与 `tool-renderers.ts:78` 的普通分支一致；仍可在下一行保留 agent/title。旧历史 union 工具继续依据原名/原 action 显示，不给它伪造新的执行身份。
2. 成功摘要放回 `renderSubagentResult` 所属的结果区域，call 保持稳定工具名；复用现有 `formatCompactSubagentSpawnSummary` 和 Host 的成功背景。这样可同时消除硬编码标题的不一致、call/result 共享 state 引起的首帧滞后，也不依赖用户触发重绘。保留错误原文与 context.isError 语义，不改 args、details、content 或工具注册名。
3. 如果必须维持“一行成功摘要替换 call”的现有交互，则仅调整既有 renderer 组件：借鉴 `src/compact-tools/index.ts:42` 返回组件并在其 `render(width)` 内读取共享 state 的方式，而不是在创建 Text 时提前固化摘要；同时统一启动和成功摘要的工具名。不要在 renderResult 内无条件调用 context.invalidate，避免与 Host 同步重入形成循环。此方案仍需覆盖 title 缺省，因为当前 call 是否读取摘要还受 `spawnStartingSummary(args)` 前置条件限制。

第一、二项组成推荐方案，复用同族现成的“稳定 call + 结果正文”，不增加状态机、事件、轮询、额外 registry 或 provider 交互。仅把 `subagent start` 字面量改成 `subagent_start` 可修正启动标题，但无法处理成功后的 `* subagent started` 风格差异及刷新滞后；仅改 definition.label 不会生效。修复授权后应优先在现有 renderer 测试内覆盖真实 `ToolExecutionComponent.updateResult → render` 顺序、有/无显式 title、失败与展开重绘，当前没有新增或修改任何测试。

**验证记录与剩余边界**

执行的聚焦验证命令：

```sh
node --test --test-name-pattern='compact spawn summary|compact rendering routes new operation|project operation tools retain injected|spawn rendering keeps' test/subagent-compact-rendering.test.mjs test/subagent-runtime-membrane.test.mjs
```

输出：`tests 5 / pass 5 / fail 0`，耗时约 591 ms。选中的用例使用纯 formatter 或测试自带 mock RPC，不调用真实 provider；其中注册接线用例确认 start 与所有 run_* 都有按名 hint 的 call/result 回调。未运行整个 runtime 集成套件。另执行一次 `node --input-type=module` 标准输入诊断，加载 `test/helpers/pi-runtime.mjs` 的 SDK/Jiti 别名和本仓 renderer，输出见上文，没有落盘新脚本或测试。

源码定位使用 `rg` 与只读文件读取；早期搜索根 `node_modules/pi-subagents/src` 等猜测路径出现不存在错误，随后通过包目录发现实际依赖在 `packages/pi-subagents-enhanced/node_modules/pi-subagents`，已按实际文件核实，未以失败搜索当作不存在实现的证据。

本次仅新增本报告；开始调查时工作区已 dirty，未覆盖或清理任何既有变更。暂存区检查 `git diff --cached --exit-code` 返回 0。剩余限制是未观测用户现场 session/终端、未验证已运行进程是否加载当前源码；因此成功卡在用户环境中保留旧标题多久、是否经历额外 invalidate，只能由现场记录进一步判断，不影响本次对文本生成点、默认 fallback 行为和正常成功渲染顺序的结论。
