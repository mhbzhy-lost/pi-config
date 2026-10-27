# 主会话后台任务 footer 两物理行限制诊断

本报告仅做源码诊断，不实现修复。唯一写入文件是本报告；没有新增或修改测试、fixture、生产代码、配置、handoff 或计划，没有启动真实 bash_async、Host、provider，也没有运行测试套件或处置旧 workspace。行号均指本次读取的主仓现场；旧 patch 行号指补丁文件本身。

## 结论与缺陷分类

长 bash 命令通过合法的 `bash_async` typed 工具入口进入 controller，以原始 `command` 留存在 launch receipt，并作为 `ActivityRow.label` 原样交给统一 renderer。当前 renderer 对标题无限换行；窄宽下还会在全部标题行之后继续追加全部状态行。主 footer 只有整体高度预算，没有单任务上限，因此一个足够长的、仍能整块放入预算的命令会占据大部分 footer。更长且放不下的任务则被整块折叠为 overflow，而不是被截成两行。

这是**类别 1：合法 production 数据的显示处理缺陷**，首个相对新“两物理行”要求的偏离点是 `src/background-activity/layout.ts:353–366` 的全部标题续行输出，以及 `:369–378` 的全部标题与 stacked 状态行输出。旧代码遵循原“标题/状态全文换行”的显示合同；新需求改变这一显示合同，不需要 source、controller 或 registry 的兼容/fallback。

推荐在 `composeEntryBlock` 内将每个任务块限制为最多两物理行，然后让 `renderActivityRows` 与 `renderActivityLayout` 共用该结果。统一覆盖 `subagent`、`bash_async`、`scheduler`，不添加 kind 特判、配置或新框架。两行包含首行标题/命令、标题续行和状态挂行；不是“标题两行外加状态”。保留所有 raw 数据和详情入口。

本报告证明的是生产源码可达性及生成链，不声称捕获了用户当时的具体 jobId、命令或终端帧。未读取 session/私有 ledger，也未为诊断另跑任务；不以显示 fixture 作为生产来源证据。

## 1. 合法入口、权威身份与完整生成链

| 环节 | 当前现场证据 | 数据/身份保证 |
| --- | --- | --- |
| 宿主入口 | `pi/extensions/bash-cwd.ts:18–45` | 创建同步 Bash、异步 controller、完成消息 renderer 和同 Host publisher；session_start 向 publisher 提供当前 mode、sessionManager 和 sessionId。 |
| 公共参数 | `src/bash-cwd/extension.ts:14–28`；`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:28–31` | 从原生 Bash schema 继承 `command: Type.String` 与 timeout，只增加 cwd。command 没有用于 footer 的长度限制。`src/bash-async/contracts.ts:4–7` 明确 command 为 string。 |
| 工具注册与返回值 | `src/bash-async/index.ts:29–78` | `createBashAsyncExtension` 继承参数，注册 `bash_async`；execute 调用 `controller.launch`。返回的 JSON receipt 和 details 保留原 receipt，没有显示截断。 |
| 准备执行 | `src/bash-async/index.ts:33–45`；`src/bash-cwd/extension.ts:40–50` | 准备 cwd/原生定义、捕获会话事实，保留原命令交给原生执行；没有把显示摘要替换到执行参数。 |
| 任务权威 | `src/bash-async/controller.ts:43–66` | session_start 启动当代；launch 检查 TUI/RPC、当前 sessionId、toolCallId、command 类型、timeout、abort，在 prepare 后再次检查 generation/branchEpoch/sessionId。`randomUUID()` 产生 jobId；receipt 保存原 command、已准备 cwd 和 acceptedAt。 |
| 接受→运行→归档 | `src/bash-async/controller.ts:58–72,75–99` | 先 `jobs.set(jobId, job)`，再 invalidate，再用 `{ ...request }` 执行原生命令。收束时删除 active、追加 completed、再 invalidate。snapshot 从唯一 jobs/completed 生成 receipt 副本，观察者不是第二任务权威。合法长耗时工作在两次失效通知之间处于 active。 |
| ActivitySource | `src/bash-async/index.ts:122–133,221–253` | 精确 key 是 `bash_async:<jobId>`；active 的 label 是 `receipt.command`、stateLabel 是 `running`、placement 是 main；terminal 同 key 进入 recent。source 注释明确截断/换行归 renderer。 |
| 同 Host 注册 | `src/bash-async/index.ts:275–316` | TUI-only publisher 在 owner-ready 时核对 sessionManager/sessionId/hostKey，复用 registrationId，携带匹配 scope 注册 source。RPC 可以执行任务但不发布终端 footer。 |
| 唯一 owner | `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts:788–843,861–873` | owner 建立 token 世代与 registry；只接受完整 scope 匹配的 source/presenter。注册 source 最终调用 `epoch.registry.register(source)`。 |
| Registry | `packages/pi-subagents-enhanced/src/tui/background-activity.ts:173–202,303–307,384–410` | 校验合法行形状并返回 source snapshot；只聚合 available 行，按 kind 顺序透传 row，不缩短 label、不按 label 去重。精确 key 用于 source 反查。 |
| Presenter 注册与安装 | `pi/extensions/background-activity.ts:60–65,94–128`；`packages/pi-subagents-enhanced/src/tui/footer-runtime.ts:705–723,752–777` | 根扩展只发布 factory；package 是唯一 setFooter owner，安装 `view.createFooter`，不再改写任务显示串。 |
| 主 footer 调用 | `src/background-activity/presenter.ts:155–181,184–216,294–305,350–357` | 未挂详情时读取 registry.snapshot、终端宽高、cwd/model/context/thinking 和独立 sourceStatuses，调用 `renderActivityLayout`。 |
| 任务块布局 | `src/background-activity/layout.ts:289–297,325–380,574–589,615–660` | label/state 先生成清理后的显示副本；`renderActivityRows` 与主布局均调用同一个 `composeEntryBlock`，其中没有单任务行数 cap。 |

上述身份、时间和资源顺序均来自工具/controller/owner 的生产逻辑。无需手拼 projection/event、倒退时间、缺字段 mock 或过期 fixture，即可生成任意长合法命令的 main 行。命令是否成功与显示缺陷无关，接受回执不代表成功；完成后主视图只显示 recent 汇总，完整终态仍由详情承载。

例如，一条合法的长测试命令被接受后，只要其显示标题换行数大于 2、但连同 metadata/分隔行仍能放入 `terminalRows-6`，`fullLines` 路径就会完整输出这些行（`layout.ts:687–696`）。这是静态可达条件，不是本次运行的复现记录。

## 2. 当前物理行规则与精确偏离点

令 `W` 为规范化终端宽度，`G` 为公共 glyph cell 的 visibleWidth，`P=1+G+1` 为选择 cell、glyph cell、gap 的总宽，`T=W-P` 为标题区域宽度。当前常量和 glyph 宽度计算在 `layout.ts:80–106`；不以 JS 字符数代替列宽。三种 glyph 分别为 `●`、`⌘`、`⏱`，只表达类型，不表达状态。

| 条件 | 当前输出规则 | 当前任务块总物理行数 |
| --- | --- | --- |
| W<=0 | 两个公开入口返回空显示 | 0 |
| W 小于本任务 glyph 宽 | `composeEntryBlock` 返回一个空行块 | 1；主布局若有预算可纳入该块 |
| glyph 可放，但公共选择/glyph 网格放不下 | glyph-only | 1 |
| 无标题列，即 W<P+1 | 选择 cell + 补齐后的 glyph；状态留详情 | 1 |
| 内联状态 | 以全帧 main 行的最大状态宽 `S` 预留公共右列；T>=2+2+S 时标题按 T-2-S 换行，状态只在首行右对齐，后续标题同一缩进 | 等于标题换行数，无上限 |
| stacked 状态 | 标题按 T 全部换行；随后 `状态：<state>` 按 T 全部换行；每行都对齐标题列 | 标题行数 + 状态行数，无上限 |
| 无状态 | 无需状态挂行，标题按 T 全部换行 | 等于标题换行数，无上限 |

`frameStateWidth` 在 `layout.ts:483–489,583,652` 先于预算裁剪计算，包含将被 overflow 折叠的 main 行，保证同帧右边界稳定；不能只按最终可见条目重算。

显示清理位于 `layout.ts:218–222`：剥离终端序列，tab 换单空格，移除包括 LF/CR 在内的控制符。因此 bash 原命令中的换行不是 footer 行边界；物理扩展来自 renderer 的宽度换行。`wrapDisplayText`（`:259–268`）调用公开 `wrapTextWithAnsi`，优先词边界、消费换行处空白，长 token/CJK 按字素拆分，单字素超宽时用 `clipToWidth`（`:242–252`）安全省略。内联分支在 `:366` 无条件输出所有 `chunks.slice(1)`，stacked 分支在 `:369–378` 无条件输出所有标题和状态 chunk；这两处是最小修复落点。

不要在 `wrapDisplayText` 全局加两行上限：metadata 和 source/recent 信息行也调用它。不要在 `renderActivityRows` 或主布局的最终 string[] 上简单 `slice(0,2)`：这会把其它任务切掉，或使 stacked 状态随标题续行一起消失。

## 3. 最小两行方案、真实截断提示与安全边界

建议只改任务块组装逻辑，保留现有排序、glyph/选择列和公开函数签名。当前主仓仍绘制选择箭头；本次单独修复不顺手删除，旧 patch 的箭头变更见后文。

1. **内联状态分支**：沿用公共状态宽和首行右对齐。标题最多保留两行；第一行仍为标题首段 + 状态，第二行是对齐标题列的标题尾段。若标题在两行内完整结束（包括恰好两行），原样显示，不加 `…`。只有第三行及之后仍有内容，或因不可容纳字素实际丢失标题内容时，才在最后保留的标题行尾标记 `…`。第二行继续使用既有标题 wrap 宽，保持统一网格。
2. **stacked 分支**：第 1 行保留标题，第 2 行保留状态，两行已经包含状态挂行。标题压成一行可见前缀，实际超宽时尾加 `…`；第 2 行将 `状态：<state>` 压成一行，只有该字段自身超宽时才尾加 `…`。保持标题→状态顺序，不将第三行状态悄悄切掉。
3. **窄宽状态可读性**：优先保留 state 的实际文本。若 `状态：` 的装饰文字会占光状态可用列，可在该窄宽显示分支省略这三个装饰字，直接显示 state 前缀及必要 `…`，不改 stateLabel、不替换事实词。例如要保留 `running` 的可见前缀，而不是只显示装饰性的 `状态…`。若宽度连一个 state 字素加省略号都装不下，就按列安全缩为 `…` 或沿已有无标题列的 glyph 降级，完整状态在详情查看，不声称完整可读。
4. **无状态分支**：标题最多两行，只有真实丢弃尾部时在最后保留行加 `…`；不凭空增加状态行，也不强制任务始终占两行。原有 width 0/空行/glyph-only 阶梯继续成立，单项可以只有 0 或 1 行。
5. **省略号语义**：`…` 属于被截字段的最后保留行，不要求必须位于整卡最后一行。stacked 标题被截但状态完整时，第 1 行标题尾有 `…`，第 2 行完整状态不假加省略号；两个字段都被截时可各有一个。此解释已通过主管确认，符合单任务两行包含状态的要求。

只在本文件内部为任务标题生成“最多 N 行”的显示结果及真实 hidden 标志即可，不扩展公开模型，不新建通用模块。内部 helper 只由 `composeEntryBlock` 消费，不能接到 metadata、详情 chrome 或 provider 正文。

安全实现要点：

- 先使用 `toDisplayText` 得到无输入 ANSI/OSC/C0 的显示副本，再测量/换行/截尾，最后 `renderSegments` 上主题色；不裁切已经上色的 ANSI 字节串。
- 常规换行复用 `wrapTextWithAnsi`；列宽用 `visibleWidth`；截尾用 `truncateToWidth(text, columns, "…")`；字素安全依赖公开工具与现有 `Intl.Segmenter`，禁止用 `slice(0,width)`、UTF-16 length 或自写 ANSI parser 计算列宽。Pi 1.4.0 对应实现见 `node_modules/@earendil-works/pi-tui/dist/utils.js:823–1004,1018–1140`，包含 grapheme 分割与 ANSI 处理。
- 对“还有后续行，但最后保留 chunk 本身未超宽”的情况，直接 `truncateToWidth(lastChunk, width, "…")` **不会**产生省略号。应在已证实 hidden 的分支，为 `visibleWidth("…")` 预留列，用 `truncateToWidth(lastChunk, width-visibleWidth("…"), "")` 安全保留字素前缀再追加 `…`。实际 columns 为 0 时不添加越界字符。
- hidden 判断不能仅看 `wrapDisplayText(...).length>N`：现有极窄字素降级可能已丢弃超宽单字素，换行处空白也被规范化。任务局部的限行投影需在丢弃不可容纳字素时记录真实内容损失；正常断点空白消费不算新的截断。无损恰好两行、未超宽短标题和完整状态不能因“进入 cap 分支”就假加 `…`。
- 同帧公共状态预算继续先于 cap/overflow 选择计算；inline 中不能挤掉或改写状态来换更多标题。stacked 已明确允许 renderer 截短显示，但 raw state 与详情保持完整。

不存在“任意窄宽里既完整显示任意长状态、又必须两行且不越界”的物理可能。本任务已明确选择两行摘要和详情完整信息；主管确认允许字段级截尾和既有 glyph 降级，因此不需要添加 fallback 或阻塞实现。若未来要求主卡完整状态永不截断，则需重新决定产品优先级，不能暗中突破两行上限。

## 4. 任务种类、元数据、详情与整体预算

| 内容 | 是否受单任务两行 cap | 理由与路径 |
| --- | --- | --- |
| main 任务卡：subagent、bash_async、scheduler | 是，统一规则 | `ActivityKind` 三种值定义于 package `background-activity.ts:21`；两公开入口共用 task block。没有 bash 专属无限标题合同。 |
| subagent 标题/状态 | 是，仅主卡显示副本 | `packages/pi-subagents-enhanced/src/tui/subagent-activity.ts:50–54,77–112` 投影 title/agent、真实状态。不能把 `●` 当作状态来删状态字。 |
| scheduler 名称/状态 | 是，仅主卡显示副本 | `src/task-scheduler/activity-source.ts:64–105` 保留完整 name 或 type/schedule；enabled 或观察到 running 进入 main，其余 recent。 |
| cwd、主会话 provider/model、thinking、context | 否 | presenter `:184–216` 独立投影；layout `:637–649` 独立 composeMetaPair。当前实际代码把 model/thinking/context 合并在右串；文件头“第二元数据行”的注释已落后，不能据注释误改实现。 |
| stale/unavailable source 状态 | 否 | `layout.ts:661–673` 的 isEntry=false 信息块，包含来源错误/上次观察数量；不是一个后台任务。 |
| recent N 汇总 | 否 | `layout.ts:623–625,673–676` 按 recent key 去重，只是信息块；即使极窄会换行，也不逐条展示 recent 任务。 |
| overflow“还有 N 项 · Alt+O” | 否 | `layout.ts:412–415,720–721` 是被整体隐藏的任务数，不是截短标题数。 |
| Alt+O 详情 footer | 否 | presenter `:307–337,353–354` 是独立模式，含任务身份、状态、metaLabel、位置和操作提示，不能套主卡 cap。 |
| 详情 provider 正文/原始命令与输出 | 否 | bash source `src/bash-async/index.ts:155–166,195–211,240–250` 明确保留完整 command 与原始输出；shell `detail-controller.ts:768–800` 消费 provider 的全部行并按 viewport 展示，不调用 composeEntryBlock。 |

`renderActivityRows` 本身不会按 placement 过滤；它是通用条目显示入口，目前 `rg` 的生产调用只有主布局直接调用 composeEntryBlock，独立 renderActivityRows 的实际调用在现有 layout 测试中。让它使用同一任务块 cap 是维持 renderer 合同一致，不等于改动详情行模型或 recent 详情正文。

整体主 footer 预算仍是 `max(0,terminalRows-6)`（`layout.ts:621`），metadata/动态块之间的单个空白行仍计入预算（`:685–692,709–717`）。**必须在创建 `LayoutBlock.lines` 时就得到已限行的任务块**（`:654–659`），不能先按无限块分配预算再裁两行，否则任务可能错误 overflow、空留预算、公平分配与 geometry 失真。

随后沿用既有 `fairFillOrder`（`:502–529`）和 `fillBlocks`（`:537–559`）：预算紧时先尝试每个非空 kind 的首块，再尝试剩余任务，最后 source/recent 信息；仍按整块取舍。单块两行仍可能放不下一个剩余行槽位，不能为塞入而暗切成一行。公平策略是首块优先尝试，不保证极低高度三种 kind 同时可见。

cap 后有内容省略但卡片仍可见的任务 **不增加 overflowCount**；整个卡片放不下才计 1。recent/source 信息不计入 N；预算为 0 或 metadata 已占满时，隐藏 main 数量照旧入 geometry。`geometry.footerRows` 必须对应实际输出物理行数，不能用“任务数×2”猜测；短任务可为一行。

另有一个与本次标题 cap 独立的静态预算风险：`layout.ts:722–724` 在仅信息块被折叠时，检查 `lines.length<budget` 后整块追加 `droppedInfos[0].lines`，没有验证该多行信息块能完整放入剩余预算；`computeActivityGeometry` 的钳制也不会修剪实际 lines。本次未执行用例、未追踪这类 source 信息的具体运行实例，不将此分支推断升级为已复现的生产缺陷，也不在两行修复中顺手改信息行合同。实施者应把它作为既有主预算风险单列；若既有聚焦验证实际触发，保留证据、按来源门禁分类并上报，不放宽预算断言，不全局截平面输出当 fallback。

## 5. 与旧五文件 patch 的合并关系

仅只读检查了 `docs/patches/2026-10-27-background-activity-footer.patch`，未 apply/check-apply、访问或操作原 workspace，也未请求控制/处置。派发合同中原 `183f86ee...` workspace active、terminal observed、preserve 被错误 strategy 拒绝的事实属于主管提供的上下文，本报告没有读取私有 ledger 来独立复核。

补丁内容确为五个文件：`src/background-activity/detail-controller.ts`、`src/background-activity/layout.ts`、`src/background-activity/presenter.ts`、`test/background-activity-details.test.mjs`、`test/background-activity-layout.test.mjs`。现场主仓仍有 `SELECTION_COLUMNS`/`SELECTED_MARKER`、固定三行详情 footer、静态 margin.bottom=4，故上述补丁并未在这些落点完整集成。`detail-controller.ts` 自身另有现存 dirty，不能覆盖。

| 旧补丁内容与位置（补丁文件行号） | 与本次关系 |
| --- | --- |
| `:183–364` 删除主 footer 选择列/箭头，调整 PREFIX_WIDTH、entryPrefixSegments、composeEntryBlock 签名和两个调用点 | 与本次同在 layout.ts；函数邻近 hunk 和签名会文本冲突，prefix 宽变化也会改变标题截尾阈值。合并时保留旧补丁的无箭头网格，再在其新签名中保留两行 cap，不恢复旧选择列或旧前缀公式。 |
| `:1–182,365–512` 详情身份/模型完整换行、shell 统一计算 footer 实际行数、正文/scrollBounds/overlay margin 使用动态 reserve | 是另一条详情修复；本次 cap 不能进入 shell.renderFooter 或详情 helper，不能改回固定 2/3 行或截断完整 provider/model/thinking。旧补丁还在详情 renderer 中省略恰为“运行中”的状态；不扩展到主卡。 |
| `:513–560` 详情相关断言与主视图箭头断言迁移 | 本次不修改详情动态 reserve 期待；后续集成旧补丁时单独保留。 |
| `:561–690` layout 测试前缀/箭头迁移 | 与本次长 token/CJK/resize/stacked 的期待迁移会重叠；特别旧 patch `:673–678` 仍保留 resize“换行不丢字”，必须改为新两行摘要合同，不能择一整文件覆盖。 |

两者语义可以共存：旧 patch 让详情 footer 的完整模型换行、主卡去箭头；本次让主卡最多两行。建议主管通过已授权的正式集成流程确定基线；无论先后集成，都按最终函数/前缀做小范围人工合并并重跑聚焦验证。不要直接重放整个旧文件，不修改补丁文件或回收旧 workspace 来完成本任务。

## 6. 现有断言最小迁移与验证入口

本次只审计，未运行或修改下列测试；不新增 test()、case、fixture 或实验脚本。后续实现只同步现有断言及其说明文字，保留 raw/宽度/预算约束。

| 现有位置 | 最小迁移 |
| --- | --- |
| `test/background-activity-layout.test.mjs:1–18` | 更新原“完整标题换行”的覆盖说明为主卡两行摘要；不把测试说明当生产来源证据。 |
| `:151–183` 截图同形 label，width 78 | 当前恰好两行，应保留完整 `(delegate)`、首行状态右对齐和续行缩进，不因达到两行就误加 `…`。若已集成无箭头 patch，只按新前缀核对，不能无条件删除此期待。 |
| `:185–211` ASCII/长 token | “aaaa bbbb cccc dddd”在现有宽度能用两行放完，继续保留 tokens 完整；40 字符 longToken 的全文拼回期待改为最多两行、末尾真实 `…`，保留词内双空格与续行基线断言。 |
| `:238–248` CJK 长标题 | 原 titleBody(lines)===label 改为两行内的安全前缀摘要与末行 `…`；保留首行状态和 visibleWidth 断言、raw 不变。 |
| `:250–259` 超宽 stacked 状态 | 原全文 `状态：<longState>` 拼回期待改为恰两行：第一行标题，第二行状态前缀与必要 `…`；保留状态未混入标题首行和列宽检查。 |
| `:354–386` 既有 widths×heights 矩阵 | 原有全部宽高、行对象和 sourceStatuses 不变；在既有循环/断言内核对三种 kind 的单卡物理行上限、真实截尾、整体预算及确定性。不把 recent 行误当 main 数量，不添加新矩阵项。 |
| `:388–403` resize | narrow 下 `titleBody(entryLines)===label` 改为两行摘要、尾 `…`；wide 单行仍完整，无假 `…`。metadata 完整显示和行宽约束不减弱。 |
| `:317–352,405–452` 公平填充、overflow/recent | 继续保持整块公平策略与 overflow“隐藏任务数”语义。当前短卡和恰两行长卡的固定计数通常可保留；只有按新实际块长重新计算确有变化时才同步，不为通过而批量改计数。 |
| `:213–236,261–280,454–518,552–582` | ANSI/Unicode/raw、glyph、source/recent、zero-budget、theme 约束保持；未集成旧 patch 时箭头期待不属于本次迁移。 |
| `test/bash-async-activity.test.mjs:160–184,214–268` | 长命令 label 原文、详情 command/输出原文、snapshot 只读期待必须原样保留。本次不需要改此文件。 |
| `test/background-activity-details.test.mjs:379–409,1060–1142` | 主 footer 短卡、详情 metadata/正文完整性不因主卡 cap 改变；无需把详情上限改成两行。与旧 patch 的详情动态 reserve 迁移归其原任务。 |
| `test/background-activity-visual.integration.mjs:112–122` | 已有 long 场景目前检查 `(delegate)` 与续行缩进；其同形输入恰两行，应继续成立，不改 fixture。本任务不运行真实视觉入口，旧 patch 去箭头导致的前缀变化单独处理。 |

适合后续小修的精确 WritePaths：

- 必要：`src/background-activity/layout.ts`，只改任务块两行投影及该文件相关合同注释/任务局部 helper；公开签名不变，metadata/info/detail 函数不套 cap。
- 必要的现有断言同步：`test/background-activity-layout.test.mjs`，只修改现有用例中的期待、断言与说明，不新增用例或 fixture。
- 不需要为两行修复开放 source、controller、registry、presenter、detail-controller、package、配置、session 或旧 patch 的写权限。若集成旧五文件补丁，另由主管处理授权与基线；不能把其五文件范围自动算入本次小修。

后续聚焦验证入口（本次均未运行）：

```text
node --test test/background-activity-layout.test.mjs
node --test test/bash-async-activity.test.mjs
node --test test/background-activity-details.test.mjs
npm run typecheck:root
```

首项验证两公开 renderer 的新合同；第二项用既有替身验证 raw command/receipt/detail 不变，不执行真实 shell；第三项验证主/详情模式分离与详情交互回归，该文件头还声明需 unit-runner 授权，实施阶段应沿用主管已取得的运行授权，未授权不得运行。无需为了单文件 renderer 小修跑广域套件。`test/background-activity-runtime.integration.mjs` 可作为 owner/握手后续有条件的入口，不是本次必要验证；不得启用 `test/background-activity-visual.integration.mjs` 的真实 Host/provider 场景。

## 7. 可直接派发的最小修复合同

**目标**：统一主会话 footer 的 subagent/bash_async/scheduler 单任务卡最多两物理行，包含状态挂行。真实截短字段尾部用 `…`；未截内容不加省略号。保留 inline 首行完整状态右列；stacked 固定标题一行、状态一行，极窄安全降级。完整 command/state/meta/detail/output 保持原数据与原详情路径。

**基线**：读取当时主仓现场并核对旧无箭头/详情换行补丁是否已由主管正式集成；按当前 PREFIX_WIDTH 计算列宽，不应用旧 patch、不访问或处置原 workspace、不覆盖 dirty。`detail-controller.ts` 已有其它 dirty，禁止本合同写入。

**写范围**：仅 `src/background-activity/layout.ts`、`test/background-activity-layout.test.mjs`。第二项只允许既有断言同步，禁止新 test()/case/fixture。当前报告任务没有执行该写授权；此段是供主管下一次派发使用的合同。

**实现边界**：cap 位于 composeEntryBlock 及本文件任务局部 helper，两个调用路径同源；先 cap 后主预算/公平填充；overflow 只计整卡被隐藏；metadata/source/recent/overflow 信息不套单任务 cap；详情完整模型/footer/正文不套 cap；不加配置、module、controller/source fallback，不写回 raw row/meta/snapshot/tool result/event/session。

**验收**：用现有测试中的 longToken、CJK、stacked、ASCII、widths×heights、resize、raw 不变断言最小迁移，证明 <=2、列宽不越界、grapheme/ANSI 安全、真实省略标志、恰好两行无假省略，以及主预算/公平/overflow一致。聚焦 layout 测试与 root 静态检查通过；在既有运行授权下补跑原 source/detail 保护测试。不新增测试，不运行真实 bash_async、Host/provider，不顺带验证名册注入或 Goal 运行。

**停止条件**：若要求“任意窄宽完整状态永不省略”与两行不越界同时成立、需要新增 fixture/真实运行、需要扩大 WritePaths、旧补丁基线不清或其它 dirty 必须被覆盖，保留证据上报主管，不自行加 fallback。信息块回填的既有静态预算风险若在聚焦验证出现，只记录首个偏离点并先分类，不用放宽现有预算断言解决。

## 8. 本次验证记录与限制

执行的命令限于 `pwd`、`git status --short`、`git diff --name-only/--stat/--check`、`git diff --cached --name-only`、`rg --files`、聚焦 `rg -n` 和 `wc -l`，以及工具只读文件内容；写工具仅创建/修订本报告。未运行 node --test、typecheck、构建、真实任务或新实验，也没有安装/提交/stage、模型/凭据读取、私有 ledger 读取、控制或 workspace 处置请求。

源码和补丁审计支持上述生成链及最小方案，但本次没有 renderer 执行结果、终端视觉证明或修复后的通过输出，不能把“诊断完成”表述成“修复完成”。旧 workspace 状态和早前 261 回归结果没有在本任务复验；它们不作为本次代码验证通过证据。

交付前只读检查结果：`git diff --cached --name-only` 无输出，暂存区为空；`git diff --name-only` 与开工时的既有 tracked dirty 路径列表一致；本次涉及的 layout/presenter/source/registry/runtime 和 layout/details 测试的 `git diff --stat` 无输出。指定报告为新增 untracked 文件，未 stage。`git diff --no-index --check -- /dev/null <报告路径>` 无 whitespace diagnostics；其返回 1 是新文件相对空文件有差异，不能误记为测试失败或测试通过。没有修改本次允许路径之外的文件。
