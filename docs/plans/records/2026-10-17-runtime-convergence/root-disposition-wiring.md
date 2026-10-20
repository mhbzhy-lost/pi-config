# T26：Root Host 将 public 处置接入 coordinator 权威

## 实现

- 新增 `packages/pi-subagents-enhanced/src/workspace/disposition-facade.ts`：`createCoordinatorDispositionFacade`，public disposition 写操作经 coordinator，并携带可信 callback 或已记录 terminal proof。
- `workspace/tool.ts` 与 `extensions/subagent-runtime.ts`：读写显式 `await`，避免把未解析的 Promise 投影成成功结果；错误路径保留结构化信息。
- 保留 `CHILD_OWNS_INTEGRATION` 边界：coding workspace 的 integrate 由 child integration queue 自主拥有，父会话不直接 integrate。

## 证据

- fresh SDK 注册检查 1/1（14 工具 model-only）；`test/subagent-managed-worktree.integration.mjs` 5/5 exit 0（分配、绑定、proof 投影、discard、preserve/release、复合 tool-call ID），日志 `/tmp/runtime-convergence-existing-worktree-migration.log`。
- 本轮真实调用链验证：`managed_workspace_status` → `managed_workspace_dispose(preserve)` 成功、`managed_workspace_release` 按 proof 门禁 fail closed，说明 public 面确实经权威路径而非本地捷径（见 `current-workspace-settlement.md`）。

## 边界

`integrate` 路径本轮未执行（origin-dirty 且 terminal 未 observed），不声称 integrate 已验证；raw git worktree 操作始终禁止。
