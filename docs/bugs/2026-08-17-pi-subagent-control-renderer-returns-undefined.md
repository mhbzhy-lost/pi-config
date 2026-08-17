# Pi 启动恢复 subagent 控制调用时崩溃

## 一句话描述

Pi 0.84.2 恢复包含 `subagent` 控制调用的会话时，项目 renderer 返回 `undefined`，导致 TUI `Box.render()` 读取不存在组件的 `render` 方法并崩溃。

## 复现流程

1. 在会话中执行 `subagent` 的 `status`、`workspace_status` 等带 `action` 的控制操作。
2. 退出并重新启动 Pi，使 TUI 恢复该工具调用行。
3. `renderSubagentCall()` 返回 `undefined`，随后 `Box.render()` 抛出 `TypeError: Cannot read properties of undefined (reading 'render')`。

## 修复方案

自定义 tool renderer 在无可见调用标题时返回空 `Text` 组件，而不是 `undefined`；增加控制调用 renderer 回归测试，确保返回值始终符合 Pi `Component` 合同。
