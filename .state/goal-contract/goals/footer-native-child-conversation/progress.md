# Progress: footer-native-child-conversation

- Status: completed
- Phase: complete
- Current slice: slice-005
- Completed: roster、Pi native renderer、viewport、input、active/history、teardown、cache、native-first/Fleet fallback、title/runId 绑定、移除 `main`、长 title 单项限宽、thinking 隐藏、notify/status 选择性 renderer
- Automated evidence: 计划聚焦回归 96/96；扩大回归 158/158；fresh SDK create 373.2ms，reload 304.6ms/296.8ms，15 extensions，0 errors
- Manual evidence: 用户确认原完整 iTerm2 矩阵通过；Amber/Cobalt 同 agent 并发标题未串线；最终 reload 后五项新增验收全部通过
- Final acceptance runs: `51135a2c-9ca6-4134-9d45-69d8af9389ff`、`a2de5989-4a15-4834-945f-102f424d53dc`

## Residual Boundary
- 主对话物理 scrollback 修复仍是独立范围，对应 Todo #38 与 `docs/bugs/bug-pi-tui-dynamic-refresh-clears-scrollback.md`。
- Spark provider 的 upstream HTTP 502 不属于本目标；delegate acceptance 已完成。
