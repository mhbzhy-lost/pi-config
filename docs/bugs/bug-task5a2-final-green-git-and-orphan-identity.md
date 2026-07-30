# Bug: Task 5A2 最终 GREEN 的 Git 断言与 orphan 身份仍有缺口

## 症状

Task5A2 Coordinator 52 项全部通过，Workspace 新增行为也已执行成功，但两个 Workspace 测试在最后的 branch 存在性断言失败。`git branch --list <name>` 对被 linked worktree checkout 的分支返回 `+ <name>`，测试却比较裸 `<name>`。

提交前父级 diff 审查还发现两个未覆盖分支：pending replay 用权威 output/receipts 重算 `dispatchContextHash`，但没有要求持久 `attempt.tool.output/dependencyReceipts` 等于这些权威值；allocator 的 exact lease recovery 只要求 base commit 是当前 HEAD 的祖先，不拒绝 event 前已被修改或前进的 orphan workspace。

## 影响

错误的 porcelain 断言阻止合法 allocator 实现通过门禁。更严重的是，被改写的 durable output/receipts 可以与旧 context hash 同时存在并通过 prepare，而后续 boundary 读取不一致 descriptor；allocation event 尚未提交的 workspace 若含未授权脏改动或额外 commit，也会被恢复并正式写入 Attempt 事件。

## 复现

1. 创建 linked attempt worktree 后执行 `git branch --list pi-plan-attempt/...`，stdout 为 `+ pi-plan-attempt/...`；`refs/heads/...` 实际存在且指向正确 commit。
2. 生成合法 pending intent，只改 `tool.output` 或 `tool.dependencyReceipts`，保持 contract、toolHash 和原 dispatchContextHash；reducer 接受，当前 prepare 仍返回 dispatch。
3. 创建 authoritative lease 后，在 worktree 修改 tracked file，或提交一个 descendant commit；再次以完全相同 allocation input 调用 allocator，当前 recovery 通过 branch 和 ancestor 检查并返回 lease。

## 根因

测试把面向人的 `git branch` 展示格式当成稳定机器协议，没有考虑 linked worktree 标记。Coordinator 把“用权威值重算 context”误当成同时验证了持久 descriptor，但没有比较事件内动态字段。Allocator 的 ancestry 检查适用于已经开始执行的 workspace，却不适用于尚无 `attempt.workspace-allocated` 事件的 never-started orphan；该窗口中合法状态只能是 clean 且 HEAD 精确等于 base commit。

## 修复

测试使用 `git rev-parse --verify refs/heads/<branch>` 或 `git show-ref --verify --hash` 检查 branch identity，不解析 `git branch` porcelain 装饰。

Coordinator replay 要求持久 `tool.output` 精确等于 `outputForAttempt(attemptId)`，持久 `tool.dependencyReceipts` 与 current integrated receipts 结构完全相等；不一致统一 fail closed，且所有 pending 仍在整体返回前完成验证。

Allocator exact recovery 除 lease/path/branch identity 外，要求 workspace HEAD 精确等于 stored base commit，并且 tracked/untracked 状态 clean；dirty 或 descendant commit 都拒绝。该要求只适用于 allocation event 前的幂等入口，不修改已持久 Attempt 的正常执行与 release 路径。

## 验证

先提交 tests-only 校准与 RED：两项 branch postcondition 改用 refs plumbing 后在当前 GREEN 上通过；新增 output tamper、receipt tamper、dirty orphan 和 advanced-HEAD orphan 四项测试在当前实现上分别 RED。修复后 Task5 聚焦、完整 Coordinator、Attempt Workspace、Events/IR/dispatch IR 和 diff-check 全部通过，并再次执行独立复审。
