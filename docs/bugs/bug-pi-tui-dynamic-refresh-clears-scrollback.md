# Bug：动态 TUI 刷新清空 terminal scrollback 并重置阅读位置

## 1. 现象

在 iTerm2 中向上查看 Pi 主会话历史时，Todo、pi-subagents progress、tool expand/collapse 或其他动态组件刷新会把 viewport 跳到顶部或底部。动态区域接近或超过一屏时，用户几乎无法停留在历史位置；刚滚动就再次跳转。

## 2. 影响

长任务运行期间无法稳定阅读早期消息，滚动行为随组件高度和刷新频率变化。Pi-subagents 与 Todo 同时占用可见高度时，主会话历史在实际需要回看时最不可用。

## 3. 稳定复现

使用 10 行 terminal 和 30 行 TUI model 首次渲染，此时 `previousViewportTop = 20`。只修改第 0 行并再次调用 `TUI.doRender()`，terminal write 明确包含：

```text
CSI ?2026h  CSI 2J  CSI H  CSI 3J
```

同一 fixture 只修改第 29 行时不包含 `CSI 3J`，只差分更新当前可见行。真实长动态组件的首行位于 viewport 上方，周期性 progress update 与该 fixture 等价。

## 4. 证据

`pi-tui@0.82.1` 的 `doRender()` 在 `firstChanged < prevViewportTop` 时调用 `fullRender(true)`。该函数固定发送 `\x1b[2J\x1b[H\x1b[3J`：清屏、回到 home、清除 scrollback，然后重放完整 `newLines`。因此 scroll position 不可能保留。

本机 `PI_CLEAR_ON_SHRINK` 未设置，Pi settings 也没有 `terminal.clearOnShrink`，默认值为 false；现场主路径不是 clear-on-shrink。其他独立触发仍存在：terminal width/height change 会 `fullRender(true)`；rpiv-todo `toggleCollapse()` 明确调用 `requestRender(true)`，该调用先清空 TUI previous-state，再导致 full clear。

rpiv-todo 默认最多渲染 12 个 content rows，加 trailing spacer 后最多 13 行；factory widget 不受 Pi 对 string-array widget 的 10 行截断。小终端再加 editor/footer 后，Todo 足以占满 viewport。前台 pi-subagents progress 也可以超过一屏并高频更新。

## 5. 根因

Pi 主 conversation 没有 application-owned scroll viewport，而是把 terminal scrollback 同时当作历史存储和浏览界面。Terminal ANSI 只能修改当前可见 screen，无法原位更新已经进入 emulator scrollback 的历史行；当 off-screen 动态行变化时，pi-tui 只能在“保留过期历史”与“清空并重放”之间选择，当前选择后者。

因此问题不是单个 Todo 或 pi-subagents renderer 的状态丢失。长动态组件只是更容易让变化起点落到 viewport 上方，触发 TUI 架构中的 full-clear 分支。

## 6. 修复与验证策略

短期配置仓缓解：typed coding dispatch 固定 async，避免 executor/spark 前台 progress 占屏；限制 Todo widget 高度并默认使用紧凑状态；避免 extension 主动调用 `requestRender(true)`。这些措施降低触发频率，但不能保证原生 scrollback 稳定。

完整修复需要 Pi/pi-tui 提供 application-owned conversation viewport：只向 terminal 渲染当前 viewport，维护 scroll offset/anchor/follow-tail；滚动期间 off-screen model 可更新但 anchor 不变；PageUp/PageDown 与 mouse wheel 都修改应用状态；不再依赖 terminal scrollback 更新历史行。配置仓可选择实现只读 main-history overlay 作为过渡，但它不是主 TUI 的通用修复。

验证必须覆盖：off-screen dynamic update、append-only update、组件高度增减、Todo collapse、前台 subagent progress、terminal resize、manual anchor、tail follow 和真实 iTerm2 wheel 行为。
