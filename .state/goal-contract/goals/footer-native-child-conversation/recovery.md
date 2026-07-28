# Recovery: footer-native-child-conversation

## Current State
- Status: completed
- Phase: complete
- Current slice: slice-005

## Completion Evidence
- 原 Footer-native 实施与完整 iTerm2 按键/滚动/折叠/draft/reload 矩阵已由用户确认通过。
- Amber/Cobalt 两个同为 delegate 的并发 run 显示正确 start/completion title，没有串线。
- 最终扩大回归 158/158；fresh SDK create 373.2ms，reload 304.6ms/296.8ms，15 extensions，0 errors。
- Doctor 只有两个已知 limitation；scoped `git diff --check` 通过。
- Final reload 后，用户确认 Footer 长 title 截断且 sibling 可见、无 `main`、status 折叠/展开都只显示状态、completion 只显示 title/status、thinking 正文隐藏且 Footer 保留 `xhigh`。
- Final acceptance runs: `51135a2c-9ca6-4134-9d45-69d8af9389ff`、`a2de5989-4a15-4834-945f-102f424d53dc`。

## Residual Boundary
- Main physical scrollback repair remains out of scope and pending separately as Todo #38。
- 不需要恢复本 goal；除非出现新回归，否则以新 bug/goal 处理。
