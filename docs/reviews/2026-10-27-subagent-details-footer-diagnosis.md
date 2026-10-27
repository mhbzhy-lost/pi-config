# Subagent 详情 footer 截断与滚动状态诊断

## 结论

当前 footer 的两行来自受控仓库的根 renderer：

```text
2/2 ● 审阅 goal runtime 执行计划 (reviewer) · 运行中 · 模型 (codex-pool) gpt…
行 908-942/942 · 跟随底部 · x 展开
```

第一行的 `gpt…` 不是 agent 消息、tool result、session 或 status payload 被截断，而是详情 footer 把身份、状态、模型和 thinking 拼成单行后，调用 `truncateToWidth` 的结果。原始 `BrowserChild.model` / `thinking` 仍由合法的 subagent status 投影取得，`ActivityRow.metaLabel` 只是只读展示投影。

“跟随底部”不是唯一状态。正常滚动时它会切换成“手动滚动”，两者分别代表当前 viewport 是否位于内容末尾；Home、End、方向键、分页键和滚轮都能合法触发切换。当前 `●` 也不是“运行中”状态圆点，而是固定的 subagent 类型图标。因此从现有产品合同看，两者语义不重复；若产品仍要求视觉上隐藏“运行中”，应只在 renderer 的详情首行对该一个文案做条件省略，并保留“已完成”“待处置”“受限”“已暂停”“已停止”“运行失败”等其他终态/处置状态。

模型要保证完整显示，最小修复必须在 renderer 层改为按终端列换行，并同步让 overlay 正文预算和 footer 的动态行数一致。只删除当前三行上限或只把 `truncateToWidth` 换成普通换行都会使 overlay 与 footer 重叠，因为当前 overlay 的底部保留行数是静态值 4。

## 1. 合法 UI 入口与实际调用链

先记录一个快捷键事实：本仓库实际注册的是 `Alt+O`，不是 `Ctrl+O`。`packages/pi-subagents-enhanced/extensions/custom-footer.ts:21-24` 调用 `pi.registerShortcut(Key.alt("o"), ...)`，handler 委托 `runtime.openBrowser`。仓库 README 也在 `README.md:108-110` 和 `packages/pi-subagents-enhanced/README.md:39-44` 固定写明 `Alt+O`。Pi 上游文档 `node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md:164` 与 `docs/usage.md:23` 则把 `Ctrl+O` 定义为展开/折叠工具输出。由当前源码不能证明 Ctrl+O 会打开这个详情页；如果用户确实按 Ctrl+O 进入了详情，需要额外的运行时 keymap 或 Host 配置证据。详情内部的关闭键也是 `Alt+O` 或 `Esc`，见 `src/background-activity/detail-controller.ts:357-369`。

统一入口的调用链如下：

1. `packages/pi-subagents-enhanced/extensions/custom-footer.ts:14-24` 注入 SDK/TUI 依赖并注册唯一 `Alt+O`。
2. `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts:932-940` 校验快捷键所属 `sessionManager`；有根 presenter 时走 `view.openDetails()`，否则走 standalone browser。
3. 根 presenter 由 `pi/extensions/background-activity.ts:60-62, 94-128` 发布并注册；它不调用 `setFooter`，只发布 factory。
4. package runtime 是唯一 footer owner，在 `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts:698-721` 调用 `ctx.ui.setFooter`，把 `view.createFooter` 安装到 Pi。
5. 根 `src/background-activity/presenter.ts:369-431` 保存 editor/draft，调用公开 `ctx.ui.custom` 挂载只读 overlay；`src/background-activity/presenter.ts:99-116` 使用 `row: 0`、`width: "100%"`、`maxHeight: "100%"` 和静态 `margin.bottom = 4`。
6. overlay 内每次 render 由 `src/background-activity/presenter.ts:338-363` 调用 `renderDetailFooterLines`。详情 footer 当前最多返回三行：身份行、位置/滚动行、键位提示行。

Pi 公共 API 证据是 `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:111-128`：`setFooter` 接收 renderer factory，`custom` 接收 component factory，并允许静态或函数形式的 `overlayOptions`。Pi TUI 文档要求 component 按可用宽度返回行，并使用 `visibleWidth`、`truncateToWidth`、`wrapTextWithAnsi` 等按终端列处理的工具；本仓库也遵循这一边界。

## 2. Footer 结构与截断首个偏离点

详情 footer 的实际结构在 `src/background-activity/presenter.ts:307-337`：

- `:308-313` 取当前条目；无条目时写“当前无后台活动”。
- `:316-323` 将可选 `entry.metaLabel` 追加到 `${label} · ${stateLabel}` 后面，形成完整身份行。
- `:327-331` 生成 `行 start-end/total · 跟随底部/手动滚动 · x 展开/收起`。
- `:332` 生成键位提示 `‹ › 切换任务 · ↑↓ jk 滚动 · PgUp/PgDn/Home/End 翻页 · Esc/Alt+O 关闭`。
- `:334-335` 以 `DETAIL_FOOTER_MAX_ROWS` 截取并交给 `renderActivityDetailTextLine`。

首个偏离点在 `src/background-activity/detail-controller.ts:135-155`：

- `toActivityDisplayText` 在 `:135-143` 只生成显示副本，剥离 ANSI/OSC 和控制符，不写回输入。
- `renderActivityDetailTextLine` 在 `:146-155` 先清理，再调用 `tui.truncateToWidth(cleaned, safeWidth, "…")`。

因此模型信息只在 renderer 的最后一步丢失可见尾部；不存在 raw payload 被修改或 provider/model 数据在前面丢失的证据。

当前静态高度合同也会限制修复方式：`src/background-activity/layout.ts:73-76` 定义详情 reserve 为 4 行、footer 最多 3 行；`src/background-activity/detail-controller.ts:335-342` 以 `terminalRows - DETAIL_RESERVED_BOTTOM_ROWS` 分配正文高度，并再扣实际标题行；`src/background-activity/presenter.ts:116` 的 overlay margin 同样固定为 4。若模型换行超过一行，必须把 footer 实际行数纳入 overlay margin 和正文预算，否则 footer 会覆盖正文或正文覆盖 footer。

现有测试直接证明当前结构：`test/background-activity-details.test.mjs:1088-1097` 断言首行携带 `模型 (codex-pool) gpt-6.1-sol`、位置行仍在第二行、键位提示仍在第三行，并断言总数为 `DETAIL_FOOTER_MAX_ROWS`；`test/background-activity-details.test.mjs:1099-1108` 只验证宽度 24 下不越界，不能证明长模型在窄宽下完整保留。

## 3. “跟随底部”可达状态与切换条件

详情 controller 的状态事实在 `src/background-activity/detail-controller.ts`：

- `:207` 初始 `autoFollowState = true`。
- `:314-326` 的 `position()` 在跟随时把起点取为 `maxStart`，并返回 `autoFollow: true`；手动状态使用保存的 `viewportStart`，返回 `false`。
- `:347-353` 把 SGR 滚轮映射到 `scrollLines`；`handleMouse` 在 `:405-419` 对 Pi 1.3 fullscreen 的标准 wheel event 走同一滚动路径。
- `:374-395` 将 Up/Down、`j/k`、PageUp/PageDown、Home/End 映射到滚动操作。
- `:664-674` 的 `scrollLines` 会从当前窗口移动，并将 `autoFollowState` 设为 `viewportStart === maxStart`。
- `:676-686` 的 `scrollPage` 采用同样条件；分页到末尾恢复跟随，分页离开末尾进入手动。
- `:688-696` 的 `scrollHome` 把起点设为 0；只有没有溢出时仍算跟随，否则是手动。
- `:698-704` 的 `scrollEnd` 把起点设为 `maxStart` 并明确恢复跟随。
- `:728-736` 将这两个布尔状态分别渲染成“跟随底部”和“手动滚动”。

所以 footer 的 follow/unfollow 文案只有两个：

| 内部状态 | Footer 文案 | 进入条件 |
| --- | --- | --- |
| `autoFollowState === true` | `跟随底部` | 初始打开、Down/PageDown 到末尾、End、滚轮/方向键回到末尾；没有溢出时 Home 也保持该状态 |
| `autoFollowState === false` | `手动滚动` | 向上离开末尾、Home 在有溢出内容时、PageUp、向上滚轮/方向键，或停在非末尾位置 |

“加载中”“详情读取失败”“too-small”是正文/壳状态，不是 follow 状态：正文文案在 `src/background-activity/detail-controller.ts:596-611`，壳状态在 `:215-224`。当前没有第三个 follow 文案，也没有“unfollow”字样。已有 `test/background-activity-details.test.mjs:1015-1020` 用 Home/PageUp/PageDown/End 证明了手动与跟随切换；`test/background-activity-details.test.mjs:695-696` 证明手动状态可达。

## 4. 圆点、运行状态与其他终态

`●` 来自 `src/background-activity/layout.ts:53-58` 的 `ACTIVITY_KIND_GLYPHS.subagent`，`composeEntryBlock` 在 `:325` 以后只把它作为类型 glyph；README 明确写成“图标只表类型，状态另列文字”，见 `README.md:104-110` 和 `packages/pi-subagents-enhanced/README.md:41-44`。因此 `●` 不等于“运行中”，不能从圆点推断 active。

状态文字来自 `packages/pi-subagents-enhanced/src/tui/subagent-activity.ts:77-100`：

- presentation `running` 或 active classification → `运行中`（`:79, :90`）。
- `completed` 或结构化 `complete/completed` → `已完成`（`:80, :92`）。
- `reported`、`needs-context`、legacy `failed/rejected` → `待处置`（`:81-82, :93`）。
- `limited`、`timed-out` → `受限`（`:83, :94`）。
- `paused` → `已暂停`（`:84`）。
- `stopped`/`detached` → `已停止`（`:85, :95`）。
- `runtime-failed` → `运行失败`（`:86`）。

因此其他终态/处置态应保留可读状态。对“运行中”有两种产品选择：

1. **按现有合同的安全选择：保留“运行中”。** 因为 `●` 只说明 subagent 类型，删除文字会丢失 active 事实。
2. **若产品明确接受详情首行不再显示 active 文字：** 只在 `src/background-activity/presenter.ts:320-323` 的 renderer 投影中对 `entry.stateLabel === "运行中"` 省略该段；对其他状态保持原文。此改动只能发生在 renderer，不得改写 `ActivityRow.stateLabel` 或 source 状态。现有测试中 `test/background-activity-details.test.mjs:1089` 需要按最终产品合同调整，但本任务禁止新增或修改测试。

## 5. 模型 provider/id 来源、完整性与调用链

模型数据的完整生产调用链如下：

1. 合法 subagent UI/runtime 事件由 `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts:994-1005` 监听 `subagent:async-started` 和 `subagent:async-complete`；事件先经过当前 `sessionManager` 身份校验。
2. started 事件由 `SubagentSessionBrowserState.trackStarted` 进入 browser，初始创建 `BrowserChild`，见 `packages/pi-subagents-enhanced/src/tui/session-browser.ts:220-258`。开始事件本身未携带模型时，字段可以暂时为空。
3. runtime 每 500ms 在 `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts:526,1008` 调用 `readBrowserRunStatus(run.asyncDir)`，送入 `browser.reconcileRun`。
4. `reconcileRun` 在 `packages/pi-subagents-enhanced/src/tui/session-browser.ts:263-325` 从 `status.steps[index]` 读取 `step.model` / `step.thinking`（`:304-305`）；缺失时经 `adjacentFacadeLeafStep` 从可信相邻 leaf step 补取（`:308-311`）；最后仅把值放进新的 `BrowserChild`（`:324-325`）。
5. `createSubagentActivitySource` 在 `packages/pi-subagents-enhanced/src/tui/subagent-activity.ts:115-140` 把 browser snapshot 投影为 `ActivityRow`。`subagentActivityMetaLabel` 在 `:63-68` 生成 `模型 <provider/id> · thinking: <level>`，只读字段在 `:102-110` 进入 row。
6. `formatChildModelLabel` 在 `packages/pi-subagents-enhanced/src/tui/session-browser.ts:47-52` 去掉重复的 `:<thinking>` 后缀；有 slash 时把 `provider/id` 格式化为 `(provider) id`，无 slash 时保留完整裸 id。这里没有 `…` 截断。
7. registry 在 `packages/pi-subagents-enhanced/src/tui/background-activity.ts:173-182,303-311` 只校验并拉取 row；`ActivityRow.metaLabel` 被定义为只读展示投影，明确不参与身份/去重/排序，也不写入 session/tool result。
8. presenter 在 `src/background-activity/presenter.ts:155-157,307-323` 取 row 并拼接详情 footer；只有随后 `renderActivityDetailTextLine` 的 `truncateToWidth` 在 `src/background-activity/detail-controller.ts:146-155` 造成当前可见的 `gpt…`。

因此 provider/id 的“当前何处截断”结论是：**只在详情 footer chrome 的宽度截断处，模型来源链未截断。** 若 model 尚未从 status 轮询到达，`subagentActivityMetaLabel` 会在 `:66` 返回 undefined，这是“尚未观察到”的空缺，不是长 id 截断；不要为此增加 production fallback。

## 6. ANSI/Unicode、长 id、窄宽与动态高度

现有 renderer 已有部分安全措施：

- `toActivityDisplayText` 先剥离 ANSI/OSC 和控制符，避免 footer chrome 把控制序列当可见列，见 `src/background-activity/detail-controller.ts:135-143`。
- 主布局已经使用 `visibleWidth`、`wrapTextWithAnsi` 和 `truncateToWidth`，并对长 token、CJK、emoji 做字素边界处理，见 `src/background-activity/layout.ts:231-263`；Pi TUI 对应实现 `node_modules/@earendil-works/pi-tui/dist/utils.js:823-907` 按 grapheme 分割长 token。
- 当前详情 chrome helper 在 `:155` 只做按列截断；它保证每行不越界，但必然会省略长模型。

模型完整显示的最小 renderer 方案应当是：

1. 在 `src/background-activity/detail-controller.ts` 现有 `toActivityDisplayText` / `renderActivityDetailTextLine` 附近增加“按列换行”的显示 helper，复用公开 `wrapTextWithAnsi` 和 `visibleWidth`；身份行禁止使用 `truncateToWidth`，长 provider/id 也必须按 grapheme/终端列拆成多行。每行再单独应用主题色，不能用 `String.length`。
2. 在 `src/background-activity/presenter.ts:307-337` 只对详情身份行使用该 helper，把完整的 `label`、状态、provider/id、thinking 生成多行；位置行和键位行继续使用现有按列 renderer。若最终选择省略“运行中”，只在这里做显示投影条件，不动 row。
3. 去掉或改造 `:334` 的固定三行裁剪，使 footer 行数等于身份行换行行数加位置行和提示行；不能用一个固定上限重新截掉模型尾部。
4. 同步高度：当前 `DETAIL_RESERVED_BOTTOM_ROWS=4`（`layout.ts:73-76`）实际是“动态 footer 3 行 + separator 1 行”。应让 presenter 记录当前 footer 实际行数，并通过 `ctx.ui.custom` 已支持的函数形式 `overlayOptions`（类型证据 `types.d.ts:128`）返回对应 `margin.bottom`；同时让 shell 的 `render` / `scrollBounds` 从同一动态 reserve 计算正文高度，替换 `detail-controller.ts:335,645` 对固定 4 的依赖。若只改 footer 换行而不改这条预算链，窄终端下会发生 overlay/footer 重叠。
5. 以 `visibleWidth` 验证每一条身份 continuation line；ANSI 清理仍只生成显示副本，不写回 `metaLabel`、raw status 或 session。模型长 id、provider 名称、CJK/emoji、ANSI label 和宽度 1/窄宽均应遵循同一列宽规则。

这是 renderer 层最小归属：推荐修改路径为 `src/background-activity/presenter.ts` 与 `src/background-activity/detail-controller.ts`，必要时调整 `src/background-activity/layout.ts` 的详情 reserve 常量/注释；不需要修改 `packages/pi-subagents-enhanced/src/tui/session-browser.ts`、事件 payload、status 文件、session/tool result/details，也不需要改 `node_modules`。当前 `rg` 未发现 `patch-package`、`patchedDependencies` 或本仓 patch 链；实际维护源码均在上述受控路径，`package.json` 固定 Pi 四核心为 `1.4.0`，`packages/pi-subagents-enhanced/package.json:39` 固定 `pi-subagents` 为 `0.80.0`。

## 7. 数据来源分类

本问题应归类为**类别 1：预期 production UI 数据未被正确渲染**，不是测试数据问题。

依据是：

- 合法入口是 package extension 的 `Alt+O`/详情 renderer，以及 runtime 监听的 typed/public subagent lifecycle 事件，见 `footer-runtime.ts:994-1008`。
- 当前 session 身份检查在事件处理器中先执行；通过后才进入 `trackStarted` / `trackCompleted`，随后由权威 status 轮询 `readBrowserRunStatus` → `reconcileRun` 读取 status steps。
- 模型事实可由正常生产的 `step.model` 或经路径约束的相邻 leaf step 产生，身份由 browser key、runId/index 和当前 source 维护；没有手工拼 projection、倒退时间、缺字段 mock 才能触发“长 id 被省略”的必要条件。
- 首个偏离点是 renderer 的 `renderActivityDetailTextLine` 单行 `truncateToWidth`，此前 raw/browser/ActivityRow 均保持完整。
- 测试中使用的 `metaLabel` fixture 能证明当前 renderer 合同，但不是生产可达性的唯一依据；生产调用链已经由上面的 public event、status 和 source 代码闭合证明。

因此应修复显示层，不应增加兼容分支、改写 raw payload 或为测试 fixture 增加 production fallback。

## 8. 现有验证命令与现场结果

本次未新增或修改测试，未运行真实 TUI 交互，未修改生产文件；只运行现有聚焦验证：

```text
node --test test/background-activity-details.test.mjs \
  test/subagent-activity-provider.test.mjs \
  test/subagent-session-viewport.test.mjs \
  test/custom-footer-input.integration.test.mjs \
  test/custom-footer-fullscreen.integration.test.mjs

66 tests passed, 0 failed
```

```text
npm run typecheck
# tsc --noEmit -p tsconfig.json       passed
# npm --prefix packages/pi-subagents-enhanced run typecheck
# tsc --noEmit -p tsconfig.json       passed
```

后续单点 renderer 修复后，适用的既有命令仍是上面的聚焦测试和 `npm run typecheck`；若修改 package/入口校验，再补充仓库已有的 `npm run verify:subagents-enhanced`。不新增测试，不做真实交互运行。现有测试已覆盖 footer 三行合同、follow/manual 切换、窄宽不越界、模型 metaLabel 投影和 raw 不变；没有覆盖“任意长模型 id 在动态换行后完整显示”，但本任务合同禁止增加测试，应以现有测试和类型检查验证回归范围。

## 9. Dirty 现场与写入边界

本次只写入本报告文件。原有用户改动保持不变：`skill-overrides/playwright/**`、`skill-overrides/writing-plans/SKILL.md`、未跟踪的 `docs/plans/2026-10-26-goal-runtime-v1.md` 等均未覆盖、未 stash、未 reset、未提交；未读取 models、凭据或证书内容。未发现 staged 文件。
