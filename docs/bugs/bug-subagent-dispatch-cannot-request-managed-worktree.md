# Subagent 派发无法按需使用受管 Worktree

## 现象与根因

旧门面把 workflow root/leaf 的 `worktree` 固定为 `false`，schema 也没有可选参数。直接透传上游 `worktree:true` 会绕过项目的 owner registry、CAS 与受控回收；因此不能以共享 checkout 的普通委派替代受管隔离。

## 公开 ABI

```ts
// Generic
{ agent: string, title: string, task: string, worktree?: boolean }
// coding dispatch-ir.v1
execution: { cwd?: string, timeoutMs: number, worktree?: boolean }
// local controls
workspace_status(workspace_id)
workspace_disposition(workspace_id, disposition, strategy?, action_token)
// disposition: "integrate" | "preserve" | "discard"
```

缺失或 `false` 保持既有 cwd、RPC payload、prompt 与 contract hash，且不创建 lease、branch 或目录。`true` 只从 clean、attached 的 primary source 分配；普通 staged/unstaged/untracked 改动均 fail closed 为 `WORKTREE_SOURCE_DIRTY`。当前 checkout 有未提交改动，故只能在独立的 temporary arena 验证 `true` 路径，不能在此 checkout 创建真实 worktree。

`workspace_status` 提供官方 observed process terminal 证明及一次性 action token；普通 completion 或 RPC status 不是终止证明。必须先 status、再 disposition；未处置的 workspace 长期保留为 `active/awaiting-disposition`。只有 observed terminal 允许 destructive disposition：`preserve` 保留 workspace，`discard` 仅释放 clean workspace 而不合并，`integrate` 仅适用于通过 `writePaths` 检查的 coding；Generic 只能 preserve/discard。模型不接触私有 owner token 或 ledger 字段。

## RED / GREEN 证据（Task 0–8）

| Task | RED（目标失败） | GREEN（对应验证） |
| --- | --- | --- |
| 0 合同冻结 | 文档缺少参数层级、终止证明和三种处置定义。 | 冻结上述公开 ABI；私有 owner 信息不公开。 |
| 1 IR/schema | `execution.worktree` 曾被当作未知字段；false hash 路径无显式合同。 | IR 测试覆盖 absent/false hash 相同、true 参与 hash，且 prompt 标明 managed worktree。 |
| 2 Broker proof | Generic leaf 不保存官方终止证明。 | Broker/Workflow 测试覆盖 Generic observed/pending/冲突 proof，且不授予 Executor grant。 |
| 3 Ledger | durable workspace ledger 不存在。 | ledger 测试覆盖权限、CAS、恢复及一次性 token/快照失效。 |
| 4 Workspace | 受管创建、检查、集成与释放原语不存在。 | temporary arena Git 测试覆盖脏来源、边界写入、Generic integrate 拒绝及无 force 的释放。 |
| 5 Facade | schema、隔离 cwd 与 control action 未接线。 | focused suite 由主 Agent 验证 **135/135**；覆盖默认 false、true 路由和 status/disposition。 |
| 6 Host 闭环 | Host 尚未验证 coding integrate 与 Generic preserve/discard。 | temporary arena integration 覆盖 observed proof、token 重放、dirty source 与 Generic integrate 拒绝。 |
| 7 Skill/文档 | Skill 没有最终 ABI、安全顺序或示例。 | `node --test test/subagent-dispatch-skill.test.mjs` 覆盖默认、参数层级、observed proof、处置限制和示例。 |
| 8 终验 | 真实 Pi fixture 最初因未提交 `.pi/agents` 正确触发 `WORKTREE_SOURCE_DIRTY`。 | 修正 fixture 后真实 Pi 0.84.1 Host 通过；两轮各 **268/268**，Fresh SDK 连续两次 reload 无 extension error，worktree、branch 与 lifecycle manifest 哈希均保持基线。 |

## 安全约束

所有创建/释放仅经项目 managed lifecycle API 或 typed Goal disposition；禁止 raw `git worktree add/remove/prune/move/repair/lock/unlock`、`--force` 删除和 raw branch cleanup。临时路径、TTL、clean 状态、普通 completion/RPC status 均不构成回收授权。脏来源、身份漂移、活跃进程、非 observed proof、未提交 workspace、越界写入或冲突一律保留并 fail closed。
