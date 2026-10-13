# bash_async 调用与启动回执缺少精简 renderer，Host 回退完整 JSON

## 来源分类

**类别1：预期 production 入口下的展示缺陷，不是执行缺陷。** 用户真实调用 `{"command":"sleep 5","cwd":"/Users/leshi.zhy/pi-config","timeout":15}` 经合法 Host tool-call 门禁与 `bash_async.execute` 正常启动，模型收到完整 `kind:'bash-async-launch'` receipt；缺陷仅在 TUI 投影层：调用卡与启动回执走了 Host 通用 fallback，把完整 launch JSON 当普通文本展示，并伴随默认 pending 底色，无任何"已接受"语义。

## 现场与首个偏离点

- 调用链（只读诊断 `/tmp/bash-async-tui-diagnosis.md` 为完整原文）：`src/bash-async/index.ts:27-28` 注册 `bash_async` 时有意剥离原生 `renderCall/renderResult/outputSchema`（launch 不是原生执行终态，剥离本身合理），但未提供 launch 专用显示替代；`src/compact-tools/renderer.ts` 的 TOOL_NAMES 与 renderers map 只有 `read/bash/edit/write/find/grep/ls/apply_patch`，没有 `bash_async`；`src/compact-tools/index.ts` 的 resolver 按 exact-name 查 owned map 未命中后 `next()`，`core/tools/renderers/index.js` 内置 map 也没有 `bash_async`，于是 definition 带着 undefined renderer 进入 `ToolExecutionComponent`，走 `createCallFallback/createResultFallback`。
- 首个偏离点：中央精简显示 owner `src/compact-tools/renderer.ts` 漏掉新工具名 `bash_async`，属绑定覆盖缺口，不是 renderer 抛错，也不是原始 JSON 不应存在。
- 形态约束：launch receipt 的 content[0].text 是单逻辑行 JSON；Host result fallback 预览十个逻辑行，因此完整 JSON 以原始形态平铺展示，不会收敛为紧凑接受状态。
- 不能用 `renderers.bash` 直接 alias 给 `bash_async`：bash 摘要按 JSON 文本行数产生 `1 lines`，既不表达接受语义，又使用同步 bash 标题，会误导为已按同步方式执行。

## 最小修复

- 只在 `src/compact-tools/renderer.ts` 增加 `bash_async` 专用显示项并加入 TOOL_NAMES；resolver owned map 由 Object.entries 自动覆盖，不改 `src/compact-tools/index.ts` 的 next 链，不重新注册/激活/执行工具。
- renderCall 沿用仓库既有 `∗`、bold toolTitle、accent 命令、`singleLine` 宽度预算，工具名如实显示 `bash_async`，不伪装同步 bash。
- renderResult 仅当 `details.kind === 'bash-async-launch'` 且非 error、非 partial 时生成"已接受，待完成"中文语义摘要并附短 jobId 身份；折叠态摘要经共享 state 挂在调用行，展开态显示完整 receipt 原文（完整身份仅展开可见）；禁止 succeeded/已完成/命令成功表述。
- 错误以 `context.isError` 为权威（保留直接 `result.isError` 调用兼容），复用既有 `failedResult` 四物理行上限与展开完整错误块；失败时清理旧"已接受"摘要，避免错误叠加接受状态。
- `options.isPartial` 时不提前显示已接受；未知格式或缺少事实时中性显示原文（不猜接受/成功，不做 production 执行输出兼容分支）。
- 不改 `src/bash-async/index.ts` 的 execute payload、content/details、controller、执行链；模型仍收到完整 launch JSON。原始 args/result/content/details/structuredContent 在渲染前后保持引用与内容不变。

## 验收

- 聚焦既有测试：`node --test test/compact-tools-renderer.test.mjs test/compact-tools-extension.test.mjs test/compact-tools-error-visibility.test.mjs`，在原文件内扩展 bash_async 用例（不新建测试文件、不 TDD）。
- `npm run typecheck:root` 与 `git diff --check` 通过；其他 dirty 现场保留不提交。

## 未知/处置限制

- bash_async 完成消息（`bash-async-complete` custom message）缺 MessageRenderer 属另一独立缺陷，由 feature-owned renderer 处理，不在本修复范围；本修复不得动 completion 的发送与内容。
- 未验证真实终端 resize/主题动态变化与真实后台任务；测试只覆盖注入 fixture 与真实 Host 工具卡组件，不执行真实后台命令。

## 实现与验收记录

- production 仅改 `src/compact-tools/renderer.ts`：TOOL_NAMES 增加 `bash_async`，renderers 增加 bash_async 专用项（renderCall 沿用 `∗`/bold toolTitle/accent 命令/`singleLine` 宽度预算；renderResult 按上述接受/错误/partial/未知语义实现）；`src/compact-tools/index.ts` 未改，owned map 由 Object.entries 自动覆盖，resolver 显示字段覆盖且 base 其余 metadata（含 execute）身份保留。
- `bash_async` 不加入 sampleArgs（与 apply_patch 同理：全局循环以七工具一行执行摘要为前提），三个既有测试文件内扩展专用用例，未新建测试文件，未使用 TDD。
- 验收：`node --test test/compact-tools-renderer.test.mjs test/compact-tools-extension.test.mjs test/compact-tools-error-visibility.test.mjs` → 87 tests，87 pass，0 fail；`npm run typecheck:root` 通过；`git diff --check` 通过；`git diff --cached --name-only` 为空，其他 dirty 现场保留未提交。附带运行 `test/bash-async.test.mjs` 11/11 通过确认无回归。
- raw 不变验证：launch 展开显示 receipt JSON 原文（Host Text 按列宽换行完整可见），折叠/展开/错误/partial/unknown 各用例均含 structuredClone 前后 deepEqual 与 content/details/args 引用身份断言；Host 真实 ToolExecutionComponent 路径验证 context.isError 权威与旧“已接受”摘要清理。
