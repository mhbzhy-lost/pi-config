# Bug：flat Harness 的 Plan Runner generation 被 child acceptance 误拒绝

## 1. 现象

在真实 flat Harness 中设置显式 `PI_REAL_BIN` 并运行持久化 Plan Runner 后，`plan_open` 已成功写入 durable Plan events，但 Plan 投影停在 `PLAN_RUNNER_WAITING_LIFECYCLE`。Plan Runner generation 没有产生最终 `status`，child 最终一直等待，Harness 超时。

## 2. 影响

首个真实产品 Harness 路径无法从 Plan Runner generation 进入后续 durable Plan lifecycle，正常的 `plan_open` 被误判为未满足 child acceptance。该问题阻塞 Plan 的验证与调度，同时将 generation 文本错误当成需要交付的工作结果。

## 3. 复现

1. 设置 `PI_REAL_BIN` 为真实持久化 Harness 使用的 Pi 二进制。
2. 运行 `test/plan-flat-runtime-harness.integration.mjs` 的 flat Root runtime Harness。
3. Root 通过 Launcher 异步 spawn `plan-runner`，Plan Runner 调用 `plan_open` 并写入 durable Plan events。
4. 观察 Plan lifecycle 保持 `PLAN_RUNNER_WAITING_LIFECYCLE`；child 没有最终 `status`，最终触发 Harness timeout。

## 4. 根因

`pi-subagents` 0.37.2 的异步 spawn 默认推断为 attested acceptance，并要求 child 回报 structured report。Plan Runner generation 的权威进度和完成信号实际是 durable Plan events 与 Root official lifecycle；它的 generation 文本不是工作结果，也不会产生该 acceptance 所需的结构化最终 `status`。因此 child acceptance 把已正确开始的 Plan Runner 错误拒绝。

## 5. 修复

Launcher 仅在 spawn Plan Runner 时显式传入 `acceptance:{level:"none",reason:<nonempty>}`。原因必须说明：Plan Runner generation 的进度与完成权威为 durable Plan events 和 Root official lifecycle，generation 文本不是工作结果。

该显式禁用只适用于 Plan Runner generation，不用于 Executor；Executor 仍应保留其工作结果的 acceptance 约束。

## 6. 验证

1. 先添加 unit exact spawn contract RED：未传 `acceptance:{level:"none",reason:<nonempty>}` 时断言失败。
2. 修复后该 unit contract GREEN，精确断言 Launcher 的 Plan Runner spawn 带有上述 acceptance 对象与非空 reason。
3. 使用显式 `PI_REAL_BIN` 重跑真实 flat Harness，确认 `plan_open` 后不再停在 `PLAN_RUNNER_WAITING_LIFECYCLE`，durable Plan events 与 Root official lifecycle 驱动正常完成，且不再因缺少最终 `status` 超时。
4. 提交前执行 `git diff --check HEAD^ HEAD`；提交仅 stage 本文档，随后以 `git diff-tree --no-commit-id --name-only -r HEAD` 确认仅该文件，并以 `git diff --cached --quiet` 确认 index 为空。
