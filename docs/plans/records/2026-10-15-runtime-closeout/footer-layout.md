# F1 验收记录：footer 网格、断词与空槽修复（layout）

- 日期：2026-10-15
- 计划/任务：`docs/plans/2026-10-15-runtime-closeout.md` §2/F1；dispatch `dispatch-60b384bd`
  （contract sha256 `60b384bd3632f625327de9e63aceeb08418045d3d422546fc7441423e283a947`，agent=delegate）
- 执行方式：用户已授权 Subagent-Driven；unit-runner 独占槽经主管 steering/批复授予，槽内仅跑
  focused layout+details、root typecheck、diff check，未与其他 unit 任务并行。
- provider：本窗口未调用任何 provider/model（纯本地实现+验证），符合「非 GPT」约束。

## 1. 变更文件（本任务写路径）

| 路径 | 动作 | 说明 |
| --- | --- | --- |
| `src/background-activity/layout.ts` | Modify | §2 冻结网格唯一实现：单选择 cell+公共 glyph cell+gap、标题列=3+glyphWidth、状态真右列（本帧 main rows 先算公共状态宽）、stacked `状态：` 行、词边界优先 `wrapTextWithAnsi`+字素 clip 降级、元数据连续渲染（删 `slotInliningAllowed`/`pending` 空槽）、公平首块预算+整块 overflow；公开三签名与 raw 不变量保持 |
| `test/background-activity-layout.test.mjs` | Modify（全量重写） | 新合同断言：截图同形 label/`(delegate)`、前导空格、ASCII/CJK/ZWJ emoji/ANSI/C0、selected、三 kind、state 超宽 stacked、widths{0,1,3,12,20,40,78,80,120}×heights{0,4,7,10,24}、raw deepEqual+引用不变 |
| `test/background-activity-details.test.mjs` | Modify（临时写路径，主管授权） | 仅最小更新与新 §2 合同直接冲突的一组 main footer 断言（见 §3），其余 27 个用例不动 |
| `docs/bugs/2026-10-15-background-activity-footer-alignment.md` | Create | 问题记录：截图来源、首偏离 wrap/compose/slot、分类、修复、未验边界 |
| `docs/plans/records/2026-10-15-runtime-closeout/footer-layout.md` | Create | 本记录 |

未触碰：presenter/detail-controller/owner/source/package；未 stage/commit/stash/reset
（`git diff --cached --name-only` 为空）。

## 2. 实际命令与结果（unit-runner 单槽内）

| 命令 | exit | 计数 |
| --- | --- | --- |
| `node --test test/background-activity-layout.test.mjs test/background-activity-details.test.mjs` | 0 | 51 tests / 51 pass / 0 fail / 0 skipped / 0 todo（layout 23/23、details 28/28） |
| `npm run typecheck:root`（`tsc --noEmit -p tsconfig.json`） | 0 | 无诊断输出 |
| `git diff --check` | 0 | 无空白错误 |

迭代过程（槽内收敛，全部如实记录）：

1. 首跑 fail 2：`@earendil-works/pi-tui` index 未再导出 `getGraphemeSegmenter` → 改为本模块
   `Intl.Segmenter` 实例，**仅**用于单字素超宽 clip 边界（合同允许「辅助 grapheme 仅限边界」），
   常规换行/测宽仍走公开 `wrapTextWithAnsi`/`visibleWidth`。
2. 二跑 fail 7：6 项为测试向量/期望错误（CJK 状态宽按 6 终端列而非 3；scheduler glyph 期望写错；
   width3 降级阶梯第三行；fair 用例漏传 width；resize 元数据换行后 entry 起始行偏移；词边界拼接需
   按去空白 token 比较），1 项为真实行为取舍（见 3）。
3. 真实行为修正：`fillBlocks` 原允许信息行在已有条目整块让位后插队占用预留预算（导致 recent 汇总
   在条目被折叠时仍显示）→ 改为「条目让位后信息行先被折叠」，与 §2.6/旧 recent 语义一致；
   该修正同时满足「recent 在预算紧张时先被折叠，不计入溢出项数」。

## 3. details 测试旧断言 → 新合同映射（主管授权的最小更新）

仅 `test/background-activity-details.test.mjs` 的 `main footer：…` 用例（原 L378-404）：

| 旧断言（旧合同） | 新断言（§2 冻结合同） | 理由 |
| --- | --- | --- |
| `lines.length === 3`（activity 内联 meta 槽行） | `lines.length === 4`（meta 2 行 + 2 entry 块） | §2.5 元数据连续渲染、活动区在其后连续绘制，禁止空 activity 槽 |
| `lines[1]` 同含 `任务A`+`(anthropic) claude-test`；`lines[2]` 同含 `命令B`+`thinking: high` | `lines[1]` 为第二元数据行（provider/model 左 + thinking 右）；`lines[2]`/`lines[3]` 为 entry 块且状态真右列 | 同上 + §2.2 状态右列 |
| `bashLine.startsWith(" › ")`（旧 pad1+选择列2 网格） | `bashLine.startsWith("›⌘ ")` | §2.1 单选择 cell 占 col1、glyph col2 |

用例名同步改为「main footer：cwd/context、连续元数据行、entry 块与 selection 高亮」。
同文件其余断言（detail 壳/overlay/geometry/raw 等 27 用例）未改且全绿。

## 4. 截图来源与未知量标注（不冒称）

- 真实视觉输入仅用户 PNG：`/var/folders/27/…/pi-clipboard-8df89397-7147-4f20-a090-8ed12c7e51e9.png`
  （本窗口只读 PNG；未读其对应真实 session/settings/token）。
- **unknown**：用户终端 cols/rows（PNG 推不出列数）、标题精确原文、theme、model 截断与否；
  `width=78` 为复现向量/回放假设，**不是测得的用户终端宽度**。截图同形 label 在测试中显式为显示
  fixture（`bug` 为占位补全）。
- 首偏离点：旧 `layout.ts` 的 wrap（字素贪心拆 `(delegate)`，:215-241）、compose（状态接 chunk0 后
  非右列，:333-360）、slot（`slotInliningAllowed`/`pending` 空槽，:530+）；详见 bug 记录 §3。

## 5. 未验证 / 未跑条款（如实）

- 未运行真实 Host/PTY/provider/网络/通知/kill；真实 TUI 视觉验证归 V1/V2（L2/L3），本记录只持 L1
  纯布局证据；用户观感 pending-user，不因 51/51 转绿。
- 未跑 `test/background-activity-runtime.integration.mjs` 等其余测试（非本任务命令）；静态核对：
  其对 root layout 的断言均为子串/详情行数/standalone 行数（`:391-392,402,449-452,526-527`），
  与新网格兼容；最终回归归 Z1。
- package standalone footer（`footer-runtime.ts`）未改，其词感知换行仍为 fallback 路径既有行为。

## 6. 残留风险

- 极窄宽度（< 前缀+2 标题+2 间隔+状态）转 stacked、再窄 glyph-only：状态/标题在窄宽不保证同屏
  完整身份（合同明示，详情可看）；width=1 仅 glyph。
- `wrapTextWithAnsi` 对超宽单字素行可能产出超宽行，本模块以字素 clip 丢弃兜底（宁可丢字不越界），
  极端窄宽下个别字素不进显示串（已在测试以 width 边界用例固定）。
- 信息行在「条目让位」后先被折叠：若未来要求状态行优先于条目，需另行修订 §2.7。
