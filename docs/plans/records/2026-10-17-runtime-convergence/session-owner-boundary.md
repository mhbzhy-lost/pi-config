# T15：session-owner 剩余验证边界

权威叙述见 `lifecycle-boundaries.md`；本文件给出该任务要求的 disposition 表。

| 项 | disposition | 依据 |
| --- | --- | --- |
| 受控 launcher 下的 CLI 独占语义（active recent 阻断、`-c` 精确 free recent pin、`--no-extensions` 不可绕过、selecting picker 阻断、持久 assistant） | `verified` | `docs/plans/records/2026-10-15-runtime-closeout/owner-cli.md`：真实 controlled PTY 5/5 |
| P3 历史单次终止恢复与非 PTY 边界 | `verified`（历史） | `owner-esrch.md` 等既有验收，不重跑 |
| 真实 `SessionManager.open` 失败路径 | `coverage-unverified` | 无同次现场；不以同 PID/串行 claim 场景替代 |
| 跨进程真并发同目标竞争 | `coverage-unverified` | 用户已确认双 Host 恢复同 session 被前置门禁阻断；本批不围绕该被阻断拓扑新建验证或修复 |
| 外部 import 目标无 header 的路径 | `blocked-upstream` | 保持 fail-closed；不声称全量 import 支持 |
| 受控 launcher 之外的 CLI/SDK/RPC 独占保证 | `not-claimed` | 不外推 |

## 本轮边界

未启动真实 Host/PTY 实验，未发信号，未跨进程竞争取证；只归档状态与解阻条件。
