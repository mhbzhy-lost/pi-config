# Bug：deterministic provider 缺少实例状态与 acceptance report

## 1. 现象

task63ah 的真实 flat Harness 在 initial 与一次 revived Plan Runner 后停滞。revived
generation 只调用一次 `plan_continue`；task-1 的首次 `subagent` 成功取得 handle，且
`attempt.bound` 已成立。此后对同一 task-1、同一 `deterministic-subagent-3` 连续发出
2,603 次请求，均返回 `requested dispatch unavailable or missing`。这不是多任务派发，
而是已尝试 contract 的不可用重试风暴。

唯一启动的 Executor 确实把 typed coding prompt 映射为 bash。该命令完成提交
`eb957a9`，diff 为 1 insertion；但 provider 随后只返回裸文本 `deterministic`。由于
Executor 的 dispatch 使用 verified acceptance，缺少结构化 acceptance report 的 attempt
被拒绝，run 最终 failed。

## 2. 真实证据与反证

`.pi-subagents/artifacts/verification/task63ah-flat-harness-provider-shape.md` 记录 initial
和 revived 两个 Plan Runner generation，且 revived 仅有一次真实 `plan_continue`。记录的
task-1 首次 dispatch 已成功，随后同一 call ID 的 requested-unavailable 重复累计为 2,603
次；总观察中该 ID 被复用而非产生新 ID。

provider stream 的 message-history 最大窗口调整，以及已见 ID 的过滤修复，均不能阻止该
复现。这构成反证：传入 `streamSimple` 的 context 是截断/投影视图，不会可靠回显 provider
自身此前发出的 call/result，不能从 context 推导完整的已发派发历史。

同一证据链还记录 typed prompt 的 bash call；其后 bare `deterministic` 不符合 verified
acceptance。Plan success validator 仍以 Git commit 与受控 verification 为权威；attempt
output 只将合法 blocked JSON 作为特殊状态处理，而不是用裸文本覆盖成功 Git 验证。

## 3. 根因

根因一在 `streamSimple`：每个 turn 只从 context 重建 deterministic 状态。context 的截断和
投影使已发出的 dispatch contract 与 tool-call ID 丢失，`decideDeterministicTurn` 因而再次
选择同一个 task-1，并生成已被消费的 ID。

根因二在 `codingSpawnParams`：它为 Executor 明确选择 verified acceptance，要求
`criteria`、`evidence` 与 `verify`。bash 成功后的 bare text 没有 pinned
`parseAcceptanceReport` 可解析的结构，因此按该契约必然失败；这不是应当放宽 acceptance 的
情形。

## 4. 正确修复

每次 `registerProvider` 必须在其闭包中持有已发 subagent contract key 的 `Set` 与单调递增的
tool-call ordinal。`decideDeterministicTurn` 接收 issued set，并在消息投影中选择首个未尝试
contract；发出 tool call 前先登记。ID 从闭包 ordinal 单调生成，同时继续避开 context 中可见
的 ID。状态只属于一个已注册 provider 实例/process，不使用全局变量、process environment
或文件，避免跨 provider/session 污染。

typed Executor bash 成功后应返回 pinned `parseAcceptanceReport` 接受的 fenced
`acceptance-report`：`criterion-1` 为 satisfied，`changedFiles` 等于 typed scope，
`testsAddedOrUpdated` 为空，且完整填写 `commandsRun`、`validationOutput`、
`residualRisks`、`noStagedFiles` 与 `diffSummary`。runtime 仍自行运行 verify 命令。Markdown
是 authoritative output 的载体，但 `readAttemptDisposition` 仅把合法 blocked JSON 特判；
成功 Git 验证仍保持权威。

## 5. TDD 验证

先建立三个彼此独立的 RED：

1. 同一 provider 实例在相同截断 A/B context 连续两次 `stream`，必须先派 A 后派 B。
2. 同一 provider 对相同 bash context 连续两次调用，toolCallId 必须不同。
3. typed prompt 的 bash success final text 必须通过 pinned `parseAcceptanceReport`，并含完整
   关键 evidence。

随后仅以实例闭包状态和 pinned report 使三项测试 GREEN。不得修改 production
Acceptance、Plan 或 Boundary，不得禁用 verified acceptance，也不得写入全局持久状态。

## 6. 影响与提交边界

该缺陷会让已绑定的 task-1 无限重试并阻塞后续 contract，同时把已产生 Git 改动的 Executor
误判失败。修复应限制在 deterministic provider 与其测试、runtime acceptance 适配的明确边界；
真实 Harness 必须确认一次 revival 后不再复用 dispatch 或 ID，并确认结构化报告通过。

本记录只新增本文件，不改 production Acceptance/Plan/Boundary。本提交采用
`docs(bug): 记录 provider 实例状态缺失`；提交后应以
`git diff-tree --no-commit-id --name-only -r HEAD`、`git diff --check HEAD^ HEAD` 与
`git diff --cached --quiet` 检查单文件、无空白错误和空索引。
