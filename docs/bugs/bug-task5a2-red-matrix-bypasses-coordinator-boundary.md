# Bug：Task 5A2 RED 矩阵绕过 Coordinator 边界

## 症状

Task 5A2 tests-only 提交 `d33eb98` 的 10 个聚焦用例全部 RED，但父级逐项检查发现部分失败没有进入待实现的 Coordinator 边界，另有断言与已冻结合同冲突。

## 影响

该提交不能作为 GREEN 实现依据。若直接修生产代码，Executor 会被诱导支持 reducer 明确禁止的重复 allocated Attempt、返回未定义的 `dispatch.taskId`，并拒绝本应无损分块的 5000-byte Plan 文本；workflow/cwd/non-command 组合测试也无法证明后三个分支分别被覆盖。

## 复现

运行 `node --test --test-name-pattern='Task5A2' test/plan-coordinator.test.mjs`：revision identity 篡改在 `createPlanCoordinator()` replay 时由 `plan-events.mjs` 抛出，重复 attemptId 在 reducer 抛出 `attempt already exists`；parallel 测试读取固定返回合同中不存在的顶层 `taskId`；long-text 测试期望 `/capacity/` 拒绝，而需求要求 5000-byte 内容分块成功。

## 根因

测试作者以 `fail 10` 作为完成条件，没有逐层确认失败发生在 Event reducer、Coordinator prepare 还是断言阶段。矩阵还把多个独立行为串在一个测试中，当前第一个显式限制抛错后后续行为根本未执行；同时没有重新核对 Task 5 固定返回 shape 和“可表达内容无损分块、仅总容量超限拒绝”的决策。

## 修复

仅修改测试：使用 reducer 可接受的 `dispatchContextHash` 篡改测试 Coordinator 重算；删除领域上不可构造的 ambiguous allocated Attempt；parallel 从 `contract.taskId` 读取；把 workflow、cwd、non-command 拆为可独立执行的用例；5000-byte 文本改为期望分块成功，并另增超过 32 项总容量的 pre-allocation 拒绝测试。pending replay 同时验证不会触发 integration drain。

## 验证

逐个运行修正后的 `Task5A2` 用例，确认每项失败都进入 `prepareAuthorizedDispatches()` 的现有未实现分支或产生目标断言差异，而不是 reducer/fixture/语法错误。happy-path 保持 GREEN，`coordinator.mjs` 相对 `2a1e116` 无变化，修正提交仅包含测试文件。
