# Goal amendment 过度使已接受任务失效

## 问题

`propose_execution_change` 当前对 source 与 target 同时存在的所有 Task 都写入 `reverify_required`，即使支持的 `update_tasks` 仅修改 description、deps、writePaths 或 workflow。已 accepted 的 Task 因此永远进入没有 producer 的 reverify frontier，阻塞 obligation policy 与后续收敛。

同时，若已 accepted Task 的 acceptance 被改变，旧证据不能证明新标准；该变更必须在 proposal append 前 fail closed，不能等待用户批准后把未验证的新标准当作满足。

## 期望

支持的 `update_tasks` 中，source∩target Task 应在新 revision 保持 `applicable`，reconciliation action 为 `keep`，pending Task 可继续 dispatch，accepted Task 的历史 accepted 状态保持不变。已 accepted Task 的 canonical acceptance 改变必须拒绝，且不创建 pendingHumanDecision 或 proposal event。Condition evidence 仍按既有保守规则失效。
