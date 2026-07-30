# Bug：Task 5A 综合 RED 未约束恢复与容量分支

## 症状

Task 5A 提交 `1fe4749` 后，新增测试和全部指定回归均通过，但提交自审发现没有显式覆盖 `workspace-allocated` crash replay、durable intent 篡改、并行 frontier、合同容量边界和非 commands acceptance。实现还在没有对应测试的情况下加入了这些恢复与容量分支。

## 影响

Task 5A 不能作为严格 TDD 检查点验收。后补测试即使通过，也只能描述现有实现，无法证明测试会捕获错误；其中非 commands acceptance 仍使用未绑定 `baseCommit` 的 `git diff --check`，直接缺失计划要求的行为。

## 复现

检查提交 `1fe4749` 与 session `e5f72ed9/run-0/session.jsonl`：唯一先行 RED 为 `TypeError: subject.coordinator.prepareAuthorizedDispatches is not a function`，测试只执行新建 v3 intent 的 happy path。随后生产实现增加 requested replay、allocated lease 复用、tamper/revision 校验和容量分块，但没有在这些编辑前运行命中对应行为的 RED。

## 根因

分片虽然缩小到两个文件，但 dispatch contract 仍要求 Executor 在一次 RED-GREEN 周期中完成多个独立行为。综合 happy-path RED 只要求最小的新建 intent 路径，未约束恢复、拒绝和容量分支；Executor 在 GREEN 后继续按照完整需求扩展生产实现，并把计划中的“测试矩阵”误解为可在实现后补充的验收覆盖。

## 修复

非破坏性 revert `1fe4749`，不保留该实现作为后补测试基线。将 Task 5A 再拆为两个强制检查点：第一步只提交完整 tests-only 矩阵并保存每组预期 RED；父级核对生产文件与基线一致后，第二步由新 Executor 仅实现使这些既有 RED 变绿的最小代码。测试必须先覆盖新建 intent、pending replay/tamper、allocated replay、并行 frontier、容量拒绝和 baseCommit acceptance。

## 验证

确认 revert 后 `coordinator.mjs` 与 `7f9768d` 一致，Task 5A tests-only 提交不包含生产文件；逐组运行测试并得到预期 RED。实现提交后运行完整 Coordinator、Plan Events、Plan IR、dispatch IR 回归与 `git diff --check`，并确认每个生产分支都能追溯到先行失败测试。
