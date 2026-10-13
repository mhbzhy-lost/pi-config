# bash_async 完成回执缺少 custom message renderer 的 production 展示缺陷

- 日期：2026-10-13
- 分类：production 展示缺陷（第 1 类：合法 production 数据未被正确展示），不是 Bash 执行、timeout、队列、取消或 durable 状态缺陷
- 来源诊断：`/tmp/bash-async-tui-diagnosis.md`（只读诊断，含完整调用链原文）；本文仅覆盖其中"完成消息"缺陷，调用/launch 回执缺陷由 compact-tools 另行处理，不在本文范围
- 授权：用户明确授权 bash_async 确诊问题直接修，不等待统一 footer 计划；本缺陷修复与 footer 统一功能无关，也不修改 footer

## 1. Production 现象

用户实际执行合法异步命令（入参 `{"command":"sleep 5","cwd":"/Users/leshi.zhy/pi-config","timeout":15}`）后：

1. 立即看到 `kind:'bash-async-launch'` 的完整 JSON（launch 显示问题另案处理）。
2. 约 5 秒后完成消息以 **Host 默认 custom 消息样式**出现：`[bash-async-complete]` 粗体标签 + `customMessageBg` 背景框 + Markdown 渲染，正文包含完整关联 JSON（`jobId/toolCallId/command/cwd/outcome/exitCode/elapsedMs`）、安全前缀长句，末尾为 `(no output)`。

预期的仓库统一回执样式是：dim、无背景框、水平 padding 1 / 垂直 padding 0 的简短状态投影（subagent 可见 completion 与 supervisor 本地回执均为此形式，见 `packages/pi-subagents-enhanced/src/tui/tool-renderers.ts` 的 `new Text(theme.fg('dim', …), 1, 0)`）。

## 2. 完整调用链与首个偏离点

```text
原生 Promise 完成
  → src/bash-async/controller.ts:75
      send({ customType:'bash-async-complete', content:[header, ...blocks], display:true, details:{...terminal} },
           { deliverAs:'followUp', triggerTurn:true })
  → src/bash-async/index.ts:11 → pi.sendMessage
  → Host agent-session sendCustomMessage：role:'custom' 消息进入会话
  → InteractiveMode message_start → addMessageToChat
      dist/modes/interactive/interactive-mode.js:3138–3143：display:true 时
      getMessageRenderer('bash-async-complete')
  → 扩展 messageRenderers Map 无命中（runner.getMessageRenderer 返回 undefined）
  → CustomMessageComponent(message, undefined, …)
      dist/modes/interactive/components/custom-message.js:49–87：
      无 custom renderer → 默认 [customType] 标签 + Box(customMessageBg) + 提取全部 text blocks 的 Markdown
```

**首个偏离点**：bash-async feature 完成了发送 `customType:'bash-async-complete'` 的出口（`src/bash-async/controller.ts:75`），但整个仓库没有为该 customType 调用 `pi.registerMessageRenderer`：

- `src/bash-async/index.ts` 只注册 tool、session 事件和 cancel command；
- `pi/extensions/bash-cwd.ts` 只初始化同步/异步 extension；
- SDK `MessageRenderer` 合同为 `(message: CustomMessage<T>, options: {expanded, outputPad}, theme) => Component | undefined`（`dist/core/extensions/types.d.ts:1119–1134`），由精确 customType 索引；`registerEntryRenderer` 面向 custom entry，不能替代。

不是 `sendMessage` 未送达（消息实际可见即证明已被消费），也不是 tool `renderResult` 可以接管 custom completion（launch tool result 与 custom message 是两个独立显示面）。

## 3. 归因证据

1. `src/bash-async/controller.ts:70–75`：header 文本（完整关联 JSON + 安全前缀）与原生 blocks 顺序，和用户看到的默认渲染正文逐字一致。
2. `dist/modes/interactive/components/custom-message.js:49–87`：缺 custom renderer 时走默认标签/背景框/Markdown；本次缺注册已足以解释现象，无需推测 renderer 抛错。
3. `src/bash-async/contracts.ts:13`：`BashAsyncTerminalReceipt` 是本 feature 的 typed contract（`outcome: 'succeeded'|'failed'|'timed-out'|'aborted'|'spawn-error'|'execution-error'`、`exitCode?`、`elapsedMs`、`output`），renderer 应只读消费它，而不是解析 header JSON 或按 stdout 关键词猜状态。
4. 空 `stdout` 时原生 Bash 文本块就是 `(no output)`（`core/tools/bash.js`），属于预期 production 数据；默认渲染让它占据回执正文是展示缺陷，不是数据缺陷。

## 4. 修复边界（已按此实施）

- 新增 feature-owned `src/bash-async/renderer.ts`：只读投影 `BashAsyncTerminalReceipt`，折叠态采用仓库统一回执视觉（dim、无框、`Text(…, 1, 0)`），显示短命令/短 job + 真实 outcome/exitCode/耗时；失败用 error 色保持可见；未知详情中性显示不报成功；展开态按 SDK `{expanded, outputPad}` 显示原始 content 文本块。对中文/ANSI/宽字符/长命令用 TUI 宽度 API 做预算。
- `src/bash-async/index.ts` 仅新增公共导出；`pi/extensions/bash-cwd.ts` 仅 Host 绑定 `pi.registerMessageRenderer('bash-async-complete', …)` 并注入 TUI `Text`/宽度能力（与 compact-tools 的依赖注入模式一致）。
- 不改 controller/contracts/execution/queue/security/cancel；不改 completion 的 content/details/display:true、发送时机、`followUp/triggerTurn` 行为；不新增第二 completion 出口、不追加 notify；不深引 subagent 内部、不新增通用 package。
- 约束：不把 `completionDelivery`（attempted/accepted）或 launch 接受当成命令终态成功；`(no output)` 不占折叠正文；raw payload 完全不变，模型仍收到完整 header/原生 blocks。

## 5. 验证方式

- 既有 `test/bash-async.test.mjs` 扩展 renderer/入口绑定/raw 不变断言（不新增测试文件，非 TDD）。
- `node --test test/bash-async.test.mjs`、`npm run typecheck:root`、`git diff --check`。
- 不操作真实后台进程/任务，不提交、不 stash/reset。

## 6. Harness 分类说明（2026-10-13 提交前核验）

- 测试 fixture 首次偏离：聚焦测试首次运行时 `test/bash-cwd-extension.test.mjs` 的 mock Host 只提供 `registerTool/on/registerCommand`，未提供 `registerMessageRenderer`；入口按本文修复边界合法调用 `pi.registerMessageRenderer("bash-async-complete", …)`（完整 Host 上为 public SDK 方法，调用本身合法），mock 缺方法抛 TypeError。属类别2陈旧 harness，不是 production 缺陷，不新增 production 防御。
- 同文件旧源码级断言 `doesNotMatch(/renderShell|renderCall|renderResult|compact-tools|pi-tui/)` 产生于完成回执绑定之前，与已授权的 pi-tui 依赖注入冲突，同为类别2陈旧断言。
- 处置：仅修该测试文件——mock 收集注册并断言 `bash-async-complete` 精确注册一次且 renderer 为 function；源码断言拆分为继续禁止 renderShell/renderCall/renderResult/compact-tools 进入执行 owner，同时精确断言入口只绑定 `bash-async-complete` 这一个 message renderer，且同步 bash 保留原生 renderers 的既有验证不变。
