# Bug: workspace-allocated 恢复忽略 inspector 状态与仓库身份

## 症状

Task5A2 已在 pending replay 与 `workspace-allocated` crash recovery 中调用 `inspectWorkspace`，但 Coordinator 忽略 inspector 返回的 `headCommit/clean`。同时 `inspectAttemptWorkspace()` 只比对 lease 文件字段并读取 Git 状态，没有验证当前路径仍属于 stored origin 的 Git common directory、也没有验证当前 branch。

## 影响

`attempt.workspace-allocated` 已持久但 `attempt.dispatch-requested` 尚未持久时，不存在合法 Executor 写入。若 workspace 已前移、变脏或被同路径独立仓库替换，Coordinator 仍会发布 dispatch，把未授权改动或错误仓库正式纳入 Attempt。Pending dispatch replay 则可能对应已经启动但尚未绑定的 Executor，不能错误要求 clean 或 base HEAD。

## 复现

1. 投影停在 `workspace-allocated`，让 injected inspector 返回 `headCommit !== attempt.baseCommit` 或 `clean === false`；当前 prepare 忽略结果并追加 `attempt.dispatch-requested`。
2. 真实 allocate 后删除 linked-worktree 目录，在同一路径放入同 branch、同 HEAD、clean 的独立 clone；以原 authoritative lease 调用 `inspectAttemptWorkspace()`，当前 common-directory/branch identity 未校验，检查成功。
3. 同样的 replacement 在 allocation event 前会被 `recoverExactLease()` 拒绝，说明两个 crash window 的 repository identity 门禁不一致。

## 根因

Coordinator 把 inspector 只当作“抛错式 ownership validator”，没有为不同 Attempt 状态定义返回值后置条件。Attempt workspace 模块又把 common-directory/branch 检查只写在 allocation-event 前的 `recoverExactLease()`，没有复用于普通 authoritative lease inspection。

## 修复

Attempt workspace 提取可复用的 repository identity 检查：stored path 的 Git common directory 必须与 stored originRoot 相同，current branch 必须等于 stored branch。`readAuthoritativeLease()` 在 physical workspace 存在时执行该检查；它不要求 HEAD/clean，保持 active pending 与正常 Executor inspect 兼容。

Coordinator 的 `inspectAttemptLease()` 返回 inspector 结果。Requested pending 只依赖 inspector 抛错来验证 lease/repository identity；`workspace-allocated` recovery 额外要求结果对象存在、`headCommit === attempt.baseCommit` 且 `clean === true`，否则在 emit 前 fail closed。不得 reset、清理或接管物理资源。

## 验证

先提交 tests-only RED：Coordinator 对 dirty 与 advanced inspector 结果均拒绝且零 append；真实 `inspectAttemptWorkspace()` 拒绝 replacement clone。修复后 Coordinator、Attempt Workspace、Dependencies、Events/IR/dispatch IR 与 diff-check 全部通过，再执行 Round 2 最终复审。
