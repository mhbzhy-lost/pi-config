# T29：coordinator 结构化错误投影与恢复

## 合同

- 新增 `packages/pi-subagents-enhanced/src/workspace/coordinator-errors.ts`：`toCoordinatorErrorInfo` / `fromCoordinatorFailure`。
- `coordinator-protocol.ts`：`errorInfo` 为严格 optional 字段，只允许 `code`、`detail`、`keypath`；状态类 detail 精确为 `{ state, allowedActions, nextAction }`。
- `coordinator-server.ts` / `coordinator-client.ts`：继续返回字符串错误以兼容既有消费者，同时携带/恢复元数据；不传输 `Error` 实例、`cause` 或 stack。
- 恢复语义不变：`MANAGED_WORKSPACE_STATE` 等状态失败仍附带 allowed actions 与 next action，供调用方按当次权威状态决策。

## 证据

- root/package typecheck exit 0。
- 既有 protocol/协调器组合检查通过（69/69 快照内含 `managed-workspace-coordinator-protocol.test.mjs` 相关合同）；本轮真实调用也观察到该合同生效：`managed_workspace_status` 对 preserved 状态返回 `MANAGED_WORKSPACE_STATE: … allowed actions: release; next: 调用 release 回收`。

## 边界

错误投影只承载白名单字段，不得成为泄露 session 路径、正文、token 或 stack 的通道；未新增错误码语义，也未把失败投影成成功。
