# scoped worktree list 被 foreign stale origin 阻断

## 分类

这是第 3 类：**来源尚未证实**。现场的统一 workspace ledger 位于 `PI_CODING_WORKSPACE_DIR`，其中有 6 条 `active` 的 `goal-task` 记录；其 origin 前缀为 `goal-runtime-rpc-smoke`，且 origin 已删除。仓库文本不能完整证明这些记录由 production 路径产生，也不能证明它们仅是 fixture 污染；但 Goal/RPC smoke fixture 污染具有强证据。因此保持来源未证实、保留现场并 fail closed，不清理或改写真实 ledger。

## 实际入口、权威身份与调用链

实际入口为 `subagent_workspace` 的 list action：

```text
tool list
  -> service.listOwned(ownerScope)
  -> ledger.list()
  -> readPrivateJson（no-follow、0600、regular-file 边界）
  -> canonicalOrigin(parsed.request.originRoot)
  -> validateRecord
  -> service 再按 owner 过滤
```

当前 standalone scope 的权威身份是 Host 解析的 live `rootSessionId`，并且 scope 的精确形状为 `{kind: "standalone-subagent", rootSessionId}`；不是 workspace ID、路径、title 或请求中的其他字段。

## 顺序与首个偏离点

全局 administration 的 `ledger.list()` 应继续逐条 canonicalize origin 并完整验证，因而 stale origin 必须 fail closed。问题只在 scoped list：foreign `goal-task`、`goal-validation` 或其他 standalone session 的严格有效 owner record 在 service owner filter 之前已被 `canonicalOrigin` 阻断。

首个偏离点是 `service.listOwned` 调用全局 `ledger.list()` 后才过滤 owner。修复应令 ledger 提供仅供 scoped list 使用的 owner-envelope 预筛选：候选先经过私有文件、record marker、文件名/workspaceId、request exact codec 与 owner envelope 的严格校验；只有 owner 精确匹配当前 standalone scope 的候选才进入现有 `canonicalOrigin + validateRecord` 路径。owner envelope 或 record identity 无法严格验证时仍须 fail closed，且不得产生 public receipt。
