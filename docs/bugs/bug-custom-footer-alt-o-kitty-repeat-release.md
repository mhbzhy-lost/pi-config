# Bug：浏览控制键在 Kitty repeat/release 事件中重复执行

## 1. 现象

真实 iTerm2 验收中，右 `Option+O` 只有保持按下时短暂显示 child viewport，松开后立即返回 main。持续按住时 main 与 child 页面不断闪烁。过滤 `Alt+O` 后 toggle 恢复正常，但 `↑/↓` 短按仍会先切换 child、松开后再切回；它们复用了同一个未过滤 release 的控制分支。

## 2. 影响

Footer session browser 无法稳定保持或切换 child 浏览态，`↑/↓`、PageUp/PageDown、隐藏输入框和草稿恢复等后续交互无法可靠使用。自动测试错误地把单个 Kitty press 序列通过视为真实快捷键验收完成。

## 3. 稳定复现

1. 在 iTerm2 中启动至少一个 async child。
2. 执行 `/reload` 加载 footer session browser。
3. 按住右 `Option+O`，child viewport 与 main 持续切换并闪烁。
4. 松开右 `Option+O`，viewport 回到 main。
5. 仅过滤 `Alt+O` 后重新加载，短按 `↑/↓`，选中项在 press 时移动、release 时再次移动；两名 child 时最终回到原项。

## 4. 证据

Pi 启用 Kitty keyboard protocol 后，同一个按键会发送 `press`、零到多个 `repeat`、`release` 事件。`Alt+O` 的代表性序列分别为 `ESC [ 111;3:1u`、`ESC [ 111;3:2u`、`ESC [ 111;3:3u`。当前安装的 `@earendil-works/pi-tui` 对三个序列执行 `matchesKey(data, Key.alt("o"))` 都返回 true；`isKeyRepeat()` 只对 `:2u` 返回 true，`isKeyRelease()` 只对 `:3u` 返回 true。

`TUI.handleInput()` 先执行 `onTerminalInput()` 全局 listeners，之后才在 focused component 分发前过滤 `isKeyRelease()`。Custom footer 在全局 listener 中直接用 `matchesKey()` 切换状态，因此收到了 Pi 原本不会传给 editor 的 release；repeat 也没有被过滤。现有真实 TUI input-chain 测试只发送 `ESC [ 111;3u`，没有发送带 event type 的完整 press/repeat/release 序列。`Key.up`、`Key.down`、普通 `j/k` 和 PageUp/PageDown 的 Kitty release 也会被 `matchesKey()` 识别，原 navigation 分支因此存在同样的二次动作。

## 5. 根因

`createBrowserInputController()` 把“键位匹配”误当成“按键动作”。Kitty 的 event type 不参与 `matchesKey()` 判断，而 controller 每次匹配都执行 toggle、move 或 scroll，导致一个物理按键周期触发多次状态变化。问题位于 custom global input listener，不是 iTerm2 Right Option 映射或 viewport 生命周期。第一次修复只在 `Alt+O` 分支过滤 repeat/release，遗漏了其他浏览控制的 release。

## 6. 修复与验证策略

只允许 Kitty `press` 事件触发 `Alt+O` toggle。匹配 `Alt+O` 的 `repeat` 和 `release` 仍返回 `{ consume: true }`，避免它们继续进入其他 listeners 或 editor，但不改变 browser 状态。进入 child 浏览态后，所有 Kitty `release` 都只消费、不执行 move 或 scroll；`↑/↓`、`j/k` 和 PageUp/PageDown 的 `repeat` 保留，支持长按连续导航。Legacy `ESC+o` 和未携带 event type 的 Kitty CSI-u 序列继续视为 press。

先在真实 `TUI.handleInput()` 测试中加入完整事件周期：`Alt+O` press 后保持 child active，任意数量 repeat 和 release 后仍 active，下一次 press 才退出；arrow press 移动一次、release 不再移动、repeat 仍继续移动。再运行全部 footer/browser 回归、SDK reload，并在同一 iTerm2 会话重新执行短按、长按、松开和 child 切换验收。

## 7. 自动化验证

已通过真实 `TUI.handleInput()` 回归：`ESC [ 111;3:1u` 进入 child，两个 `ESC [ 111;3:2u` 与一个 `ESC [ 111;3:3u` 均保持 child active 且不转发给 focused editor；下一次 `ESC [ 111;3:1u` 退出。两个 child 下，Down press 只移动一次、release 不移动；Up press 移动一次、repeat 再移动一次、release 不移动。`custom-footer` runtime/layout、browser state/viewport 和 reload 边界回归均通过。
