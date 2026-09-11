# 问题：workspace publish/apply 与恢复证据尚未分离

## 现象

现有 v1 只有 `integrate`、`discard`、`preserve` disposition。`integrateManagedGitWorkspace()` 在同一操作中 preflight origin 并 cherry-pick 或 merge；ledger receipt 没有 published artifact、policy、intent 或 apply receipt。因而无法先 durable publish，再在 origin clean 时单独 apply，也没有 apply 中断后的专属恢复记录。v1 是冻结历史 generation，不是 publish/apply 的迁移输入；这些能力只属于新 public v2 request/policy 创建的 lease。

## Provenance

- 实际入口：`createManagedWorkspaceService()` 的 `issueDisposition()`/`dispose()` 进入 `recoverDisposition()`；integrate 分支调用 `integrateManagedGitWorkspace()`。
- 权威身份：leaseId、ledger record、managed branch/worktree registration、base commit 和 origin ref 是权威身份；caller-supplied result、terminal status 与 action token 之外的文本都不是 Git apply authority。
- 事件或资源顺序：v1 active lease -> inspect workspace/origin -> issue v1 disposition token -> durable v1 `disposing` intent -> `integrateManagedGitWorkspace()` 执行 origin preflight 与 Git mutation -> release -> durable `released` receipt；异常时当前只记录 `cleanup-debt`。v2 顺序必须是 public policy codec -> v2 allocation -> official observed terminal proof -> owned status -> action-specific issue token -> durable publish intent/artifact -> 重新 status/issue token -> apply，且每一步绑定同一 owner、proof 和 snapshot。
- 首个偏离点：`workspace/contract.ts` 没有 public `ManagedWorkspaceRequestV2`/`ManagedWorkspacePolicy` codec，无法创建合法 v2 lease。T5 补齐 codec 后，`service.ts` 仍缺少 `issueAction()`、`publishOwned()` 与 `applyOwned()`；不得以无授权的 `service.publish()`/`service.apply()` 旁路 official proof、status 与 action token。v1 receipt/disposition 继续只允许 integrate/discard/preserve。
- 数据来源分类：**production**。上述代码由唯一 managed workspace service 和 Git adapter 调用，不是测试直接 append ledger 或手工拼接 receipt 的 fixture-only 路径。

## 影响

source dirty 时 v1 allocation 可以完成但 origin preflight 阻止 integrate；未来 v2 publish 不得受 source dirty 阻断，apply 才需要 origin clean。当前系统不能保留可独立验证的 publication，也不能在 origin 漂移、冲突或进程中断时按 artifact、CAS 和 receipt 精确恢复。活跃 v1 lease 必须保持这一冻结 disposition 语义，publish/apply 只能服务后续 v2 lease。

## RED 证据

生命周期合同测试首先要求 public v2 request/policy codec，并验证 40/64 位 base commit identity；当前首个 RED 是 codec 缺失。测试同时 GREEN 验证 v1 lease 没有 policy/publication/application，且 preserve/release disposition 不变。T5 codec GREEN 后，后续 RED 将要求仅对 v2 lease 使用 official observed terminal proof、owned status 和 action token 调用 publish/apply；当 source dirty 时 apply receipt 必须保持未应用。该 RED 的下一失败原因应是 publish/apply service 缺失，而非既有 resolver identity baseline。
