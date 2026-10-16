# Bug：Compact edit 展开态忽略原生 details.diff，渲染纯文本块而非 +/- diff

- 日期：2026-10-15
- 状态：Inline 验收完成，91/91 focused tests、root typecheck、diff check 通过；真实用户终端视觉仍未确认
- 数据来源分类：**分类 1（预期 production 数据未被正确处理）**

## 1. 现象

用户截图中 compact edit 工具卡点击展开后，结果区域显示的是纯文本块（compact `expandedBlock` 的 `│ 内容` 行），而不是 Pi 原生 edit 展开时的彩色 +/- diff。同一份结果对象携带的 `details.diff`（原生 `EditToolDetails.diff`，显示导向 diff 字符串）从未出现在 compact 渲染输出中。

本记录撰写者未运行真实 TUI/Host 复核视觉表现，视觉真实性以用户截图为唯一来源，标记**视觉真实未验**。

## 2. 影响

- display regression：edit 展开态丢失 diff 可视化（+/− 行、行号、上下文），只有执行结果文本；与原生 Pi 行为不一致。
- raw intact：compact 渲染只做显示投影，`result.content/details` 与 session 原始数据未被改写（既有 compact 测试持续覆盖深比较）。

## 3. 首个偏离点

`src/compact-tools/renderer.ts` 中 `edit.renderResult` 直接绑定为共享 `resultRenderer`（`summary: () => "done"`），其展开分支 `expandedBlock(textOutput(result), ...)` 只消费 `content` 文本，从不读取 `result.details.diff`。原生侧（`@earendil-works/pi-coding-agent` `editRenderers.renderResult`）在成功且 `details.diff` 为字符串时经 `renderDiff` 渲染 +/- 行。compact renderer 覆盖显示字段时把这一消费点整体丢掉，即为本仓 compact renderer 相对原生 edit 的首个显示偏离。

数据可达性：`details.diff` 由公开 typed 入口产生（SDK `EditToolDetails.diff` 为成功结果的必填显示字段，`createEditToolDefinition` 执行路径写入），属合法 production 数据，故分类 1，按生产缺陷做最小修复；不为测试制造数据添加兼容分支。

## 4. 证据链（lastComponent 适配基于官方组件，非测试 mock）

委托原生 `renderResult` 必须回答一个上下文适配问题，证据全部来自官方安装面：

1. 官方 Host（`tool-execution.js` `updateDisplay`）把上一次 `renderResult` 的返回值作为 `context.lastComponent` 传入下一次调用。
2. compact 折叠成功路径返回 `new Text("", 0, 0)`（`index.ts` 折叠 wrapper / `renderer.ts` `resultRenderer`），展开路径返回 `expandedBlock` 的 `Container` 或失败组件普通对象。
3. 官方原生 edit `renderResult` 对 `context.lastComponent ?? new Container()` 调用 `component.clear()`。
4. 官方 `@earendil-works/pi-tui` `dist/components/text.js` 的 `Text` 类只有 `setText/setCustomBgFn/invalidate/render`，没有 `clear()`（`clear()` 定义在 `tui.js` 的 `Container` 上）。

结论：折叠→展开切换时，原生 `renderResult` 会在 compact 上一帧的 `Text`/普通对象上调用 `clear()` 抛 TypeError，Host catch 后回落 `createResultFallback`（纯文本预览），diff 依旧不可见。因此委托时对 context 做浅拷贝并置空 `lastComponent`，让原生像首帧一样自建 `Container`；原 context/state/result/details 对象不修改。该适配不吞异常、不仿造 diff。

## 5. 修复策略（最小 diff，不替换原生 resolver）

- `src/compact-tools/index.ts`：resolver 在 `(name, next)` 解析时把 `next()` 取得的 remaining/registered 渲染器经 `{ current?: ToolRenderers }` 槽注入 edit renderer；resolver 不做失败判断（错误语义不丢），空 next 时槽为空、edit 走 compact，不崩且不改 raw。槽位随最新 resolve 更新，被覆盖的显示字段函数身份保持稳定（既有 extension 测试的 identity 断言不受影响）。
- `src/compact-tools/renderer.ts`：`edit.renderResult` 仅在 `options.expanded === true`、`!failed`（`context.isError`/`result.isError` 均否）、`options.isPartial !== true` 且 `typeof native.renderResult === "function"` 时委托 `native.renderResult(result, options, theme, { ...context, lastComponent: undefined })`；否则保持既有 compact resultRenderer。原生消费 `details.diff` 经上游 `renderDiff` 输出，不自造 diff/parser/ANSI。
- 折叠单行摘要、失败组件、partial 语义、其他工具与 apply_patch/bash_async 路径全部不动；`pi/extensions/compact-tools.ts` 无需改动（DI 经既有 dependencies 对象传入）。

## 6. Inline 验证记录

- `node --test test/compact-tools-renderer.test.mjs test/compact-tools-extension.test.mjs test/compact-tools-error-visibility.test.mjs`：exit 0，**91/91 pass**。新增四项证明公开 SDK 原生 diff 委托、折叠保留、失败/partial 不委托、空 next 与重解析。
- `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true npm run typecheck:root`：exit 0。修复本任务引入的 DI 类型缺陷：`nativeEditRenderers` 使用可选默认槽，而非要求 Host 入口提供它；槽仍仅由 resolver next() 填充。
- `git diff --check`：exit 0。
- 首次 focused run 的唯一失败是新增测试错误要求 expanded error 带 `✗`，而既有 compact expanded 合同是完整原文块；调用链为测试直接调用真实 resolver→既有 compact expandedBlock。分类为测试断言错误，仅修测试，不给 production 添加显示分支。
