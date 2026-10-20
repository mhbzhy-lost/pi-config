# T25C：server 普通/recovery/proof 路由与启动恢复屏障

## 实现

- `coordinator-server.ts`：普通处置、recovery 处置与 queued no-payload proof 路径统一接入 settlement；`coordinator-protocol.ts`/`coordinator-client.ts` 保留字符串错误并附带严格 optional `errorInfo`（见 `coordinator-error-contract.md`）。
- `finishStartupRecovery()`：顺序为 settlement replay → proof replay → resume-intent pump → `startupReady`；正常 listen 与 EADDRINUSE stale-socket 重听走同一收尾。
- 恢复期间只允许 status/receipt/audit 读取，mutation 返回 `COORDINATOR_RECOVERY_NOT_READY`。
- 恢复扫描按当前 repository 分区，避免跨仓消费他人 ledger。

## 证据与状态

- typecheck exit 0；queue restart 6/6（queued/admitted/rebasing/resolving-conflict/prepared）与 coordinator recovery 12/12（idle shutdown fencing、stale socket 回收、dead daemon admission 重发）通过，覆盖的是既有协调器恢复语义。
- 状态 **local-fix-ready**：`test/**` 无文件引用 `finishStartupRecovery`，`COORDINATOR_RECOVERY_NOT_READY` 门禁与启动顺序无专项用例；跨仓分区隔离亦无专项用例。

## 边界

startup barrier 的正确性目前只有实现与类型检查支撑；新增用例需明确授权，建议范围见 `settlement-window-audit.md` §“若取得新增测试授权”。
