# Bug：Compact Tools 未覆盖 Skill 调用样式

## 1. 现象

启用 `compact-tools.ts` 后，`read`、`bash`、`edit`、`write`、`find`、`grep`、`ls` 均使用统一的紧凑样式，但通过 `/skill:<name>` 或 skill 展开机制产生的 Skill 调用仍显示 Pi 默认的带背景框样式。

## 2. 影响

同一段会话中 Skill 调用与工具调用的视觉层级、留白和标题格式不一致。Skill 内容较多时，默认外框还会额外占用终端纵向空间，削弱紧凑渲染的效果。

## 3. 稳定复现

1. 启动加载 `pi/extensions/compact-tools.ts` 的 Pi TUI。
2. 调用任意已加载 Skill。
3. 对比 Skill 调用和随后出现的 `read` 等工具调用。
4. Skill 调用仍显示 `[skill]` 背景框；其他工具显示 `∗ <tool>` 紧凑标题。

## 4. 证据

`compact-tools.ts` 只遍历 `factories` 中的 7 个原生工具并调用 `pi.registerTool()`。Pi 0.81.1 并不存在名为 `skill` 的工具；Skill 调用由 `interactive-mode.js` 解析用户消息中的 skill block，并直接实例化独立的 `SkillInvocationMessageComponent`，不会经过工具 renderer。

## 5. 根因

扩展把 Skill 调用误归入工具 renderer 的覆盖范围。实际渲染边界位于独立的 `SkillInvocationMessageComponent`，而当前扩展既未适配该组件，也没有针对 Skill 调用的回归测试，所以其他工具样式统一后仍遗漏 Skill。

## 6. 修复与验证策略

为 Skill 调用增加独立、可测试的紧凑组件适配器，在扩展加载时安装，并保留折叠/展开行为。先用组件测试确认当前缺少适配器而失败，再实现最小补丁；最后运行 renderer 测试与扩展加载 smoke test，确认普通工具不受影响。
