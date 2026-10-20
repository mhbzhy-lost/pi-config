# managed dispose 可选字段投影归因（T19）

## 结论

`managed_workspace_dispose` 的 `strategy` 在本仓注册源始终是可选字段；此前一次失败来自当时运行 Host 的模型面投影把可选字段表达为必填/nullable，不是本仓 factory 缺陷。当前会话的模型面已能省略 `strategy`，并据此完成了真实 `preserve`。旧投影为何变成必填仍缺原始 provider schema 证据，按“来源尚未证实”保留，不加兼容分支。

## 逐层对照

| 层 | 事实 | 来源 |
| --- | --- | --- |
| 注册 factory | `fields` 中 `strategy` 为 `{ key: "strategy", required: false, kind: "enum", values: STRATEGIES }`；required 仅 `workspace_id`、`disposition`、`action_token` | `packages/pi-subagents-enhanced/src/workspace/operation-tools.ts:106-111` |
| 版本事实 | 该文件相对 HEAD 无本轮改动，最后一次变更是 `381f86d feat(workspace): 增加独立工作区操作工具`（2026-10-16） | `git diff HEAD --stat`、`git log -1 -- <file>` |
| schema 语义 | 顶层 `allOf` 早拒已移除，非 integrate 携带 `strategy` 由 runtime `INVALID_WORKSPACE_STRATEGY` 拒绝；属明确降级为 runtime 裁决，不是放宽 | 同文件 `:11`、`:98-104` |
| 旧模型面（事故时） | 工具定义把 `strategy` 列为必填，取值只能是 enum 或 `null`；`preserve/discard` 携带 `cherry-pick` 被 runtime 拒，省略又无法通过 schema 校验 | 本会话历史回执（未保存原始 provider schema 字节） |
| 当前模型面 | required 仅 `workspace_id`、`disposition`、`action_token`，`strategy` 为可选 enum；实际省略后调用成功 | 本次 `preserve` 调用与回执 |
| runtime validator | 非 integrate 不接受 `strategy`；bound release 需 observed terminal proof（H2 收紧） | `workspace/service.ts` `disposeForLease`/`releaseForLease` |

## 首个偏离点与分类

- 首个偏离点位于 Host/provider 的 strict schema 投影层：把源 `required:false` 字段投影为必填 nullable，使模型无法合法表达“省略”。
- 分类：**来源尚未证实**。当前无法证明该投影由本仓注册链产生（源字段为 optional 且未变更），也无法证明它只是当时 provider/Host 版本的一次性投影。按门禁 fail closed：不为本仓增加 nullable 兼容、不拆工具、不忽略非法 `strategy`、不放宽 runtime validator。
- 已排除的错误处置：重复用相同参数重试、把 `strategy` 当必填填写、raw `git worktree` 清理、删除 ledger 记录。

## 解阻条件

若再次出现同类投影故障，需要在同一次失败中保留：模型面原始 JSON schema 字节、Host/provider 版本、注册 factory 的 `required` 投影，以及 runtime 返回的精确错误码。取得后可判定 owner 是本仓注册链还是上游 converter；在此之前不预判修法。
