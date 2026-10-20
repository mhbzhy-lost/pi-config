# Inline 当前收口证据

> 本文件是较早的一轮快照。当前权威状态见 `closure-matrix.md` 与 `acceptance.md`；下文“真实 workspace 仍 blocked-interface”“fixture 迁移未完成”等表述已被后续事实取代：真实 workspace 已用当次 token 完成 `preserve`（`release` 因缺 observed terminal proof fail-closed），model-selection 与 real-git 两份 fixture 已迁移并实跑通过。

- `npm run typecheck`：恢复 `ledger.ts` 原有 request factory import 后，`typecheck-final` exit 0；随后测试断言只改 `.mjs`，未改 TypeScript production，posttests typecheck 已再次启动。
- focused：`focused-final3` exit 0，36/36 pass：Supervisor gate wire、workspace operation tools、managed workspace service。
- 首次 H2 断言失败已分类为测试合同错误：无 observed terminal proof 的 bound release 被拒后，状态应为 preserved/allowed release；生产代码未放宽 proof 门禁。
- `git diff --check` exit 0。
- 当前真实 workspace 仍 `blocked-interface`，策略字段 provider/Host 投影问题未通过重复参数或 raw 操作绕过。
- 仍未做 fresh Host、真实 provider、SIGKILL、跨进程竞争、旧 heartbeat 根删除或整批全仓回归。
