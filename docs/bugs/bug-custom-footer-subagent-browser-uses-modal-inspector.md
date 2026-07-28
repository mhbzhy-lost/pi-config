# Bug：Subagent 浏览被实现为原生浮层快捷键转发

## 1. 现象

custom footer 将右 `Option+O` 改写为 `pi-subagents` 原生 `Ctrl+Alt+F`，期望打开 child-only inspector。自动测试通过，但真实 iTerm2 中右 `Option+O` 无可见反应；`/subagents-fleet` 能正常打开 inspector，物理 `Ctrl+Alt+F` 已被 custom listener 消费。

即使原生 inspector 能通过快捷键打开，其交互仍是覆盖主对话的临时浮层：输入框保留在浮层下方，`main` 不属于可选数据源，关闭浮层才能返回主对话。这与期望的“footer 选择数据源、输入框以上显示所选 session”不一致。

## 2. 影响

用户无法通过约定快捷键进入 subagent 浏览。原生浮层还把数据源选择、transcript 浏览和返回 main 分散到两个 UI surface，footer 只显示被动名称，不能说明当前正在查看哪个 session。

## 3. 稳定复现

1. iTerm2 Default profile 设置 Left Option 为 Normal、Right Option 为 Esc+。
2. 启动一个后台 `plan-reviewer` 并执行 `/reload`。
3. `/subagents-fleet` 能打开原生 inspector。
4. 物理 `Ctrl+Alt+F` 无反应，说明 replacement listener 正在消费旧键。
5. 按右 `Option+O`，没有 inspector，也没有字符进入输入框。

## 4. 证据

`test/custom-footer-subagents.test.mjs` 只直接调用 mock terminal listener，断言它为 `Alt+O` 返回 `{ data: "\x1b\x06" }`；测试没有经过真实 `TUI.handleInput()`、focused editor 和 extension shortcut dispatcher。源码检查证明 Pi 当前会顺序应用 input listener 的改写，但真实验收说明“返回正确 rewrite 对象”不足以证明 inspector handler 被调用。

Pi TUI 的 `ctx.ui.custom(..., { overlay: true })` 会建立覆盖层；`pi-subagents/src/tui/fleet.ts` 的 `openSubagentFleet()` 正是该模式。Pi 公开扩展 API没有 conversation viewport replacement，但支持 non-capturing 全宽 overlay、动态 editor replacement 和 custom footer。`InteractiveMode.setCustomEditorComponent()` 在切换 editor 时复制现有草稿，恢复时再写回，因此只读 child 模式可以隐藏输入框而不丢草稿。

`pi-subagents` 的 `subagent:async-started` 公开 `id`、`asyncDir`、`cwd`、`agent(s)`、`workflowGraph` 和 `sessionId`；`asyncDir/status.json` 的 step 提供 `transcriptPath`。上游 `fleet-transcript.ts` 已提供受 trusted roots 约束的 transcript parser/renderer，无需重新解析 child session JSONL。

## 5. 根因

实现选择了错误的 UI 所有权边界：custom footer 只维护名称，却试图通过 raw key rewrite 借用一个不包含 `main`、也不能替换主内容区的 modal inspector。测试又停在 listener 返回值，没有验证真实 TUI 分发和最终可见状态，因此产生了错误的完成结论。

这不是继续调整 `Ctrl+Alt+F` 字节序列能够解决的问题。即使 shortcut alias 修好，原生 inspector 仍不符合 footer 驱动的 session viewport 模型。

## 6. 修复与验证策略

废弃快捷键转发。`Alt+O` 由 custom footer controller 直接处理：有 current-session async children 时进入只读浏览态，默认选择第一个或上次选择的 child；`↑/↓` 在 children 间切换；再次 `Alt+O` 或 `Esc` 退出并回到 main。

main 模式保留原 editor。child 模式安装零行 read-only editor，Pi 自动保留未提交草稿；全宽 non-capturing overlay 仅覆盖 footer 以上区域并实时渲染所选 transcript。footer 使用 `⏺/◯` 表示当前 viewport 数据源，选择状态完全由 footer controller 拥有。

浏览态消费普通输入，不调用 `switchSession`、`resume`、`steer` 或任何 session mutation API。只支持 async children，因为它们是 parent 仍可交互时需要切换 viewport 的场景；foreground child 继续由原生 subagent tool result 渲染。

测试必须经过真实 `TUI.handleInput()` 链，覆盖 legacy/Kitty `Alt+O`、进入/退出、上下切换、输入框隐藏与草稿恢复、transcript trusted roots、reload 回 main、listener/overlay/timer cleanup。最终在 iTerm2 中派发后台 child 做可视验收。

## 7. 验证结果

状态机、transcript 安全适配器、零行 editor、viewport、footer 集成、真实 TUI input chain、reload 边界、`pi-subagents` 兼容门禁、紧凑工具和 Todo 共 93 项聚焦回归通过。覆盖 legacy/Kitty `Alt+O`、混合 child 终态、动态 append-step、20 条 recent 上限、plain roster reload 迁移、selected child 删除、重复 `session_start`、stale poll、同步/异步 UI rollback、draft 恢复、unsafe transcript warning、ANSI/CJK/emoji 宽度和 PageUp 锚定滚动。

兼容门禁会实际导入当前安装的 `pi-subagents@0.37.0` 并检查 `readFleetTranscript`、`renderFleetTranscript` 与 `getArtifactsDir`。运行时 `loadConfig()` 返回 `fleetView: false`、`asyncWidget: false`、`artifactDir: project`，因此没有恢复重复的原生 Fleet widget。

在 `~/mega-aone-service` 使用完整配置连续调用两次与 TUI `/reload` 相同的 `session.reload()`，早期验收耗时分别为 150ms 和 136ms，`extensionErrors` 为空。最终接线后的独立 SDK create 373.2ms，两次 reload 为 304.6ms/296.8ms，15 extensions 且 extension/runtime errors 均为空。`git diff --check` 对全部相关实现、测试和文档通过。

用户随后在真实 iTerm2 确认右 Option+O、隐藏输入框、双 child 切换、逐行/分页/首尾滚动、工具展开、draft 恢复与 reload listener 唯一性全部通过。final reload 后又确认紧凑 notify/status、移除 `main`、长 title 限宽和 thinking 隐藏全部通过。
