# 后台活动 footer 换行/缩进/空槽显示回归问题记录（F1）

- 日期：2026-10-15
- 任务：`dispatch-60b384bd`（delegate，F1；执行计划 `docs/plans/2026-10-15-runtime-closeout.md` §2/F1）
- 性质：中文问题记录（生产显示缺陷 → 显示合同修订 + 最小修复）。不修改任何历史记录（`docs/plans/records/2026-10-13-*` 等保持原样）。
- 本窗口边界：未启动真实 Host/provider/网络/通知/kill；未读真实 session/settings/auth；未 stage/commit/stash/reset；未使用 MCP/tdd。

## 0. 结论速览

用户截图投诉的「换行拆词」「缩进/左沿」「右元数据独占空槽」三项，首偏离点均在根
`src/background-activity/layout.ts` 的旧实现（wrap / compose / slot 三处，见 §3）。
数据来源分类为**预期 production 数据未被正确处理**（合法 public 链可产生该帧：registry
snapshot → presenter 投影 → 纯 layout 回放可复算），按生产显示缺陷处理：修订显示合同
（计划 §2 冻结）并最小重写纯 renderer；不改 presenter/owner/source，不改 raw 数据。

## 1. 真实问题来源与证据分类

### 1.1 截图来源（唯一真实视觉输入）

- 路径：`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-clipboard-8df89397-7147-4f20-a090-8ed12c7e51e9.png`
  （用户剪贴板 PNG，1282×318 像素；本窗口只读该 PNG，未读其对应真实 session/settings/token）。
- 截图逐行可见事实：
  1. `~/brightness-control`（左）/ `1.4%/900k`（右）；
  2. 左区空 / `(codex-pool) gpt-6.1-sol`（右）；
  3. 左区空 / `thinking: low`（右）；
  4. `› ● 在  /Users/leshi.zhy/brightness-control 只读诊断用户刚报告的 b (del`＋行末 `运行中`；
  5. 续行 `egate)`（缩进对齐 label 内容列）。
- **unknown（不得推定、本记录不冒称）**：终端 cols/rows（PNG 像素≠列数，缺字体度量）；
  标题精确原文（截图只给换行后投影，`的 b` 与 `bug` 等不可分辨）；theme 名；model id 是否被截断；
  该窗口 session 身份（禁止且无需）。`width=78` 仅为**复现向量/回放假设**，不是测得的用户终端宽度
  （沿用 `docs/research/2026-10-14-background-activity-visual-readiness.md` §5.3/§5.5 口径）。

### 1.2 数据来源分类（缺陷门禁）

- **类别 1（预期 production 数据未被正确处理）**：截图帧可由合法 public 链产生——
  registry.snapshot() 的 available 行（subagent label = `${title} (${agent})`，
  `packages/pi-subagents-enhanced/src/tui/subagent-activity.ts:51-54`）→ 根 presenter
  `projectActivityFooterMeta` 投影 → `renderActivityLayout` 纯函数；旧实现对该合法输入产出
  拆词/空槽帧（§3 代码级证据），身份/时间/资源事实均有效。**按生产显示缺陷处理。**
- 不涉及类别 2（测试制造数据）：本记录不复用任何手拼 projection；复现输入为显示 fixture 且显式标识。
- 类别 3（来源未证实）部分：cols/标题原文保持 unknown、fail closed，不据此加兼容分支。

### 1.3 截图同形显示 fixture（显式标识，不称精确原文）

`test/background-activity-layout.test.mjs` 中「截图同形 label」用例的 label
`在  /Users/leshi.zhy/brightness-control 只读诊断用户刚报告的 bug (delegate)` 是**同形显示
fixture**（双空格、长路径、CJK、尾随 `(delegate)` 与截图同形）；其中 `bug` 为占位补全，
截图标题精确原文 unknown，本仓不读取真实 session 补齐。

## 2. 投影链与复算方式

截图帧 → 输入向量 `{cols(unknown→回放假设78), rows, meta:{cwd,home,contextLabel,
providerModelLabel,thinkingLabel}, rows[]:{key,kind,label,stateLabel,placement}, selection}`
→ 纯函数 `renderActivityLayout`（`src/background-activity/layout.ts`）离线回放 → 与截图逐行比对。
该回放不启动 Host，即可判定旧帧是否偏离新冻结合同（计划 §2.5/§5.3 同法）。

## 3. 首个偏离点（旧实现，代码级）

| # | 偏离 | 旧代码位置（修复前 HEAD 工作区） | 截图对应现象 |
| --- | --- | --- | --- |
| wrap | `wrapByVisibleWidth` 字素级贪心换行，无词边界优先 → `(delegate)` 被拆成 `(del` / `egate)`；且只 trim 行尾、不消费断点前导空格 | 旧 `layout.ts:215-241`（`GRAPHEME_SEGMENTER` 逐字素累加） | 第 4/5 行词内断行 |
| compose | `composeEntrySegments` 状态接在首行 chunk0 之后（`stateFits` 即拼 ` ${state}`），不是跨行稳定右列；短标题不补空格右对齐 | 旧 `layout.ts:333-360` | 第 4 行 `运行中` 贴 chunk0 饱和右沿、多行时状态不成列 |
| slot | `renderActivityLayout` 的 `slotInliningAllowed`/`pending` 槽位策略：需换行条目整条下移，右元数据仍独占槽位行右半、左区留空「activity 槽」 | 旧 `layout.ts:530+`（槽位内联条件 `continuations.length===0 && firstLinePlainWidth<=leftBudget`） | 第 2/3 行左区全空 |
| 左基线 | 旧网格 pad1+选择列2+glyph+gap（标题 col6）、溢出行 col2、cwd 行 col1，三种左沿并存 | 旧 `layout.ts:75-79,414-424` | 用户「缩进也有问题」感知候选（research §5.5.4） |

## 4. 修复（F1，计划 §2 冻结合同）

- 统一左基线：选择标记单 cell 占 col1（选中 `›`/未选中空格），glyph 从 col2 起补空格到公共
  glyph cell，1 列 gap，标题列 = `3 + 公共glyph宽`；续行/状态挂行只补前缀宽、不保留断点空格；
  cwd/元数据/overflow 从 col1 起；信息行保留空选择列+图标、文本对齐标题列。
- 状态真右列：本帧全部 main rows（先于预算裁剪）算公共状态宽；首行标题补空格使状态右对齐到
  width，标题/状态间隔 ≥2 列；窄宽转 stacked 独立 `状态：<state>` 行挂标题列并换行；极窄逐级
  glyph-only 降级，不静默隐藏状态、不截身份。
- 词边界优先：正常换行复用 pi-tui 公开 `wrapTextWithAnsi`（ASCII/空白分词优先、CJK 逐字与超宽
  长 token 字素兜底、消费断点空白）；单字素宽于极小 budget 用本模块字素 clip 明确降级，不另造
  ANSI parser；宽度测量一律 `visibleWidth`。
- 元数据连续渲染：第一行 cwd 左/context 右；第二元数据行 provider/model 左 + thinking 右，放不下
  分别换行且均 col1 共同左基线；删除 `slotInliningAllowed`/`pending` 空槽策略；活动区全部在元数据
  之后连续绘制。
- 预算与公平：物理预算仍 `max(0, terminalRows-6)`、详情 reserve 4、详情 footer ≤3 不变；全放得下
  按稳定顺序整块渲染；否则优先保留第一元数据行、次要元数据整 block 让位、预留溢出提示行，再按
  「每 kind 首个完整 block → 剩余条目 → 信息行」公平填充；放不下整 block 计 overflow（信息行在已有
  条目让位后先被折叠），不截 block；任何隐藏以现有 overflow 数与「还有 N 项 · Alt+O」入账。
- 公开签名 `renderActivityRows/renderActivityLayout/computeActivityGeometry` 与 raw rows/meta
  不写回不变量保持；只改 `src/background-activity/layout.ts`，不改 presenter/owner/source。

## 5. 复现与验证（本窗口实际执行）

```bash
node --test test/background-activity-layout.test.mjs test/background-activity-details.test.mjs  # exit 0；51 tests / 51 pass / 0 fail / 0 skipped（layout 23、details 28）
npm run typecheck:root   # exit 0
git diff --check         # exit 0
```

- width=78 同形回放（纯函数，未启动 Host）：`(delegate)` 作为完整词落在续行、续行 = 3 列前缀宽 +
  `(delegate)`、首行状态 `运行中` 右对齐到 78 列右边界且与标题间隔 ≥2 列、元数据两行连续无空槽。
- 既有 details 测试中与新合同直接冲突的一组 main footer 断言，经主管授权按新合同最小更新
 （映射见 `docs/plans/records/2026-10-15-runtime-closeout/footer-layout.md`），其余 details 用例不动。

## 6. 未验证边界与未修事项

- **用户观感（L3）未验证**：配色/闪烁/IME/断行美观需用户现场确认；本记录与 F1 测试均为 L1 纯布局
  证据，不冒充真实终端视觉（真实 TUI 验证归 V1/V2）。
- 不冒称真实终端宽度：78 列仅为复现向量；用户窗口 cols 需用户 `stty size` 回传（research §5.3）。
- ambiguous-width 字形（`● ⌘ ⏱ ◯ ›`）与 CJK 在用户终端的实际列宽若与 `visibleWidth` 假设不同，
  感知网格整体平移——环境测量未知（research U5），不归因用户错误。
- 历史 RPC/supervisor、triggerTurn、idle/resume、scheduler 并发等均不在本记录范围；旧 records 未改。
