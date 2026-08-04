# Bug: Goal Engine Doctor ABI 安全约束缺少完整回归门禁

## 现象

Task 6 的 Doctor ABI 检查能够拒绝缺少 `execute`、公开 `handler`、缺少预期工具和额外工具，但独立审查发现测试没有覆盖重复注册、factory 同步/异步失败、异步完成注册，以及“检查过程绝不调用工具 `execute`”。当前生产实现具备这些行为，但后续重构可在现有测试全部通过时移除相应保护。

## 影响

- 重复工具定义可能进入运行时，导致实际调用目标依赖注册顺序。
- factory 失败若不转成 Doctor issue，Doctor 会直接崩溃，无法提供机器可读诊断。
- 若 Doctor 不等待异步 factory，合法工具会被误报缺失；若错误调用 `execute`，配置检查可能读取或写入 Goal Engine 状态并触发 Git 副作用。
- 上述回退无法被当前测试及时发现，削弱生产候选的发布门禁。

## 稳定复现

1. 删除 `scripts/doctor.mjs` 中 `seenTools` 的重复检测，现有 Doctor ABI 测试仍通过。
2. 删除 factory 调用外层的异常捕获，现有测试仍通过。
3. 去掉 factory Promise 的等待，现有测试仍通过。
4. 在收集 definition 后调用任一 `definition.execute`，现有测试仍可能通过；仅断言 `.state/goal-engine` 目录未新增不足以捕获只读工具调用。

## 根因

首轮 RED 只针对此前明确缺失的四条外部结果设计：默认 factory、缺少 `execute`、公开 `handler`、工具集合 missing/extra。测试 fixture 的 `execute` 返回成功且没有调用计数，factory 也只有同步成功路径，因此实现中的重复检测、异常降级、Promise 等待和无执行约束没有对应的可观察断言。

## 促成因素

- 将“只调用 factory”视为代码审查事实，没有把它转成可执行回归门禁。
- 用 Goal Engine state 目录是否存在间接判断副作用，但 `goal_status` 等只读执行不一定创建目录。
- exact-set 测试只覆盖 missing/extra，没有覆盖集合相同但定义重复。
- factory fixture 没有同步抛错、异步 reject 和 await 后注册变体。

## 修复与验证策略

### 修复策略

本缺陷是测试门禁缺口，当前生产逻辑无需修改。扩展 Doctor fixture：所有可执行定义共享调用计数并在被调用时抛错；新增重复注册、同步抛错、异步 reject、await 后注册用例；所有注入 factory 的用例断言 `execute` 调用次数为零。

### 验证策略

1. 重复注册预期工具时，断言只产生一次对应 `invalid Goal Engine tool ABI` issue。
2. factory 同步抛错和异步 reject 时，断言返回 `invalid Goal Engine tool ABI: factory`，而不是让 `inspectConfiguration` reject。
3. factory 在一次 `await` 后注册完整七工具时，断言无 ABI issue。
4. 合法及非法 fixture 均断言 `execute` 调用次数为零。
5. 运行 Goal Engine ABI pattern、完整 Doctor、全量 Goal Engine 和最终 runtime integration。
