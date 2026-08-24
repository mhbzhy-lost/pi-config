# 非法 execution amendment 在校验前暂停 runtime，及缺 provider fixture 误用不可达 action

## 1 类：production 缺陷——已 accepted Task 的 acceptance amendment

**provenance 分类：第 1 类（预期 production 数据未被正确处理）。** 生产可达的 public 入口是 typed `goal_amend(operation=propose_execution_change)`；owner 是 runtime Projection 中唯一 active session binding 的 `ownerSessionId`，不能由调用参数替代。真实 runtime 可经 `goal_dispatch` → executor binding → `goal_settle` → `goal_integrate` → `goal_accept` 到达 accepted Task，因此 accepted acceptance 的修改不是仅存在于手工 Store fixture 的情况。

权威事实是 Goal event ledger/Store projection（runtime state、execution revision/contract、accepted Task facts、suspension、pending decision）。修复前 `scripts/lib/goal-engine/extension.mjs` 在 active 分支首先调用 `suspendOwnedRuntime(ctx, "execution_amendment")`，它先 append `goal.runtime_suspended`（随后 closure 再 append 一条）、撤销 action offer，并可能调用 owned executor stop、workspace/resource quarantine；随后才构造 target 并发现 accepted Task acceptance immutable。**首个偏离点**正是该 `propose_execution_change` 分支中 `suspendOwnedRuntime` 位于 target/accepted-fact 语义校验之前，而不是 reducer、proposal append 或 input handler。

正确顺序是：从当前权威 projection 纯计算、normalize 并严格校验 update（含 unknown task 和 accepted acceptance immutable）→ 对合法请求 durable suspend/owned closure → reload projection，重构并重验 target，确认 revision、contract 与 accepted facts 未漂移 → append proposal。非法请求必须零 append、零 stop/quarantine，runtime 继续 active 且没有 suspension/pending decision。

## 2 类：缺 final review provider 测试 fixture/期望错误

**provenance 分类：第 2 类（fixture 或测试期望错误）。** production `goal_status` 在缺 `finalReviewProvider` 时已经正确 fail-closed：返回 `R11_FINALIZATION_REQUIRED`，且没有 `machineAction` 或 action token；同一集成文件已有测试锁定此 public status。错误测试却在缺 provider 分支先走 approval，再解引用 `noProviderOffer.machineAction.params`，即构造了 production 不可达的 action。

测试应直接以结构合法 dummy `goal_finalize` 参数调用，并断言 `FINAL_REVIEW_PROVIDER_UNAVAILABLE`；checkpoint/status 可以存在，但不得有 `goal.action_offered`、`goal.final_review_started`、`goal.completed`、final-review custom intent 或 provider 文件副作用。此项不改变 provider production 门禁。
