# 合法 canonical workspace 身份漂移被误报为 Git 基础设施错误

## 复现（2026-09-08）

`planned.v1` 的公开链路先分配真实 `managed-workspace.v1` receipt、绑定官方
Root Broker proof，并在 Executor worktree 创建干净提交。随后只把该 worktree
从 receipt 的受管分支切换为 detached HEAD：

```
goal_settle
  -> ManagedWorkspaceService.status
  -> inspectManagedGitWorkspace / currentRef
  -> MANAGED_WORKSPACE_IDENTITY
  -> extension.workspaceMutationError
  -> GIT_INFRASTRUCTURE_ERROR   # 错误的首偏离
```

该 receipt、lease、owner 和 terminal proof 都是合法且已验证的；唯一变更是 branch
identity。旧边界按 error message 的模糊文本匹配，`Git HEAD must be attached` 没有
命中，因而把 typed `MANAGED_WORKSPACE_IDENTITY` 泛化成 Git 基础设施错误。

## 根因与边界

`workspaceMutationError` 必须只根据 service/Git 提供的 discriminated `error.code`
映射。`MANAGED_WORKSPACE_IDENTITY`（以及 CAS lease identity）映射为稳定的
`EXECUTOR_WORKSPACE_IDENTITY_MISMATCH`；`MANAGED_WORKSPACE_NOT_FOUND` 和既有 lease
code 保持原分类。`MANAGED_WORKSPACE_GIT`（例如 `rev-parse` 不能执行、非 repository）
没有身份 code，继续为 `GIT_INFRASTRUCTURE_ERROR`。

orphan inspector 已把未验证 receipt 作为
`ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED`，不应由这个 settlement/service 边界覆盖。
