# Bug：Task 5 Executor 上下文耗尽留下无效 TDD 基线

## 症状

Host 退役 Task 5 的 Executor run 在完成部分 Coordinator、Boundary、Capsule 和依赖注入改动后以 `NEEDS_CONTEXT` 结束。工作树保留九个未提交文件改动，Coordinator v3 聚焦回归仍有四项失败，完整四文件套件在十分钟预算后被终止。

## 影响

Task 5 无法验收。更重要的是，唯一保存的先行 RED 只证明 `plan-executor-tool-boundary.mjs` 模块不存在，没有命中一次性消费、篡改拒绝、旧 revision 拒绝、Coordinator durable intent 或 Capsule 授权等新增行为；直接在此基础上补测试会违反仓库的严格 TDD 红线。

## 复现

检查 run `afe65ace-5151-4d83-bed2-f3558ae3f144` 的 session 与 `/tmp/task5-red.txt`：RED 为 `ERR_MODULE_NOT_FOUND`，而新增 Boundary 测试只断言导出函数存在。随后运行 `node --test --test-name-pattern='v3' test/plan-coordinator.test.mjs`，稳定得到四项旧 spawn/toolHash 合同断言失败。

## 根因

初次派发同时包含九个写入文件、Coordinator 迁移、Boundary 状态机、Capsule 工具面、依赖注入和多个十分钟级测试，超过单个 Executor 的有效上下文与执行预算。Executor 在只有存在性 RED 时批量写入生产逻辑，之后才根据 GREEN 结果修改旧测试；父级要求迁移旧断言和补充行为 RED 的 steer 到达时，子进程已进入最终状态，无法继续。

## 修复

撤回该 run 产生的全部未提交 Task 5 代码与测试改动，恢复 Task 4 验收 HEAD 的干净逻辑基线。随后把 Task 5 串行拆为 Coordinator durable intent、Boundary/Capsule 一次性授权、依赖注入与累计回归三个小分片；每个分片先建立命中具体缺失行为的 RED，再写最小生产实现，并在分片结束时提交可恢复检查点。

## 验证

确认九个 Task 5 文件与 `HEAD` 无差异、两个新增文件不存在，同时 `pi/settings.json`、`.state/**` 和其他用户文件的既有状态不变。后续每个分片保存 tests-only RED 原文，运行本分片聚焦 GREEN；Task 5 收尾再用长预算运行四文件套件、Task 4 累计门禁、Doctor 和 `git diff --check`。
