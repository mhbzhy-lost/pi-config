# Runtime Task 合同无法派发或物化修复任务

**Bug：** `goal-runtime.v1` 初始化曾仅保留任务 id，且 `goal.amended` 丢弃 Host remediation metadata，导致严格 criteria-only 任务既不能编译派发也不能链接修复 episode。

## 复现

以仅含 `{ id: "task-1" }` 的 runtime init 创建 runtime，随后对该任务调用 strict dispatch 编译；任务缺少 description、writePaths 和 acceptance criteria。对 `validateRemediationTask()` 的结果执行 `goal.amended` 时，metadata 未被保留，接着的 `repair.task_linked` 无法验证绑定。

## 修复方案

将 runtime init 按既有 PlannedTask criteria-only 公共合同完整规范化并校验 scope、deps 与 DAG；draft reducer 完整物化严格任务字段。仅允许 runtime 内 canonical `goal.amended` 的 Host remediation metadata，并保留它以供同批 consume/link 的绑定校验；store 边界拒绝拆分或重排的 remediation batch，transport 仍使用既有 dispatch 合同剥离 metadata。

## 补充：可选依赖字段

**根因：** Store 对 canonical remediation taskDef 使用了将 `deps` 列为必需键的精确 shape 校验，与公共 PlannedTask 中省略 `deps` 等价空依赖的合同不一致，导致合法任务在 reducer 前被拒绝。

**修复：** Store 只接受公共 criteria-only 字段和 remediation metadata；`deps` 仅在出现时校验，`workflow` 仍必须显式为 `tdd`。新增测试确认由 `validateRemediationTask()` 生成且省略 `deps` 的 canonical batch 通过 Store 门禁并进入 reducer。
