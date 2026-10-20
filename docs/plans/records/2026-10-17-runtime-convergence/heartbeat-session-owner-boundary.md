# T14：heartbeat 覆盖、正常 fixture 结算与旧 evidence root 边界

权威叙述见 `lifecycle-boundaries.md`；本文件给出该任务要求的 disposition 表，不外推任何未验证拓扑。

| 项 | disposition | 依据 |
| --- | --- | --- |
| managed coding + `worktree:true` 父死 heartbeat | `verified`（历史单次授权实验） | `docs/plans/records/2026-10-13-heartbeat-acceptance.md`：一次真实 SIGKILL 后 child 在 lease 期限附近自行退出，零补杀、零残留 |
| generic / binding-failed / detached / bash 后代 / 多 child / 长续租序列 | `coverage-unverified` | 无同拓扑证据；不因核心用例通过而外推 |
| 旧 heartbeat 实验 workspace 与证据根（`hb-iKUNgy`/`hb-fTmWES`/`hb-vhjjea`/`hb-BXRJmy`） | `blocked-recovery` | owner 已终止、无当前合法 public 处置出口；本会话 `managed_workspace_list` 只投影 A8F3，不含这些旧实验 workspace；不 raw 删除、不猜 token |
| 正常 heartbeat fixture 的 child 报告结算（`commandsRun`） | `fixture-code-updated` / `behavior-unverified` | `test/fixtures/heartbeat-provider.ts` 已迁移新工具名，并用真实 read 结果生成 `commandsRun`，不再伪造空命令证据；prepare-only/正常结算 Host 本轮未重跑 |

## 本轮边界

未运行任何 SIGKILL、孤儿、跨进程竞争或真实 provider 实验；历史实验授权不继承。fixture 源码修改不等于行为验证。
