# Bug：Plan Graph 使用对象读取 Map 投影

## 1. 现象

`nextRunnableTask()` 对 `projection.tasks` 使用方括号索引；传入计划规定的 `Map` 时返回 `undefined`。

## 2. 影响

Task 6 领域事件投影接入后，即使存在无依赖的 pending 任务，Coordinator 也无法调度任何任务，计划永久停在 created/running。

## 3. 稳定复现

创建一个只有 `task-1` 的 graph，并传入 `tasks: new Map([["task-1", "pending"]])` 调用 `nextRunnableTask()`。

## 4. 证据

实施计划的 projection 契约明确写为 `tasks: Map`；当前实现却读取 `projection.tasks[task.id]` 和 `projection.tasks[dep]`，现有测试也只覆盖普通对象。

## 5. 根因

Task 5 在 Task 6 reducer 尚未实现时自行假定了状态容器形态，没有按计划中已声明的跨模块数据契约编写测试。

## 6. 修复与验证策略

将 Task 5 测试 fixture 改为真实 `Map`，先观察 runnable 断言失败；实现统一通过 `Map#get` 读取 task/dependency 状态。暂不增加对象兼容路径，避免形成第二种 projection 协议。
