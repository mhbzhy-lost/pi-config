# Goal settle 缺少 Executor 与官方终止证明绑定

## 1. 现象

Goal dispatch 只持久化 task contract hash 与 workspace，随后 `goal_settle` 仅凭调用方提供的 outcome、evidence 和工作树 HEAD 即可推进。Subagent 返回的 runId、asyncDir 以及 Root Broker 观察到的真实进程终止事实没有进入 Goal task 的持久状态。

## 2. 影响

主 Agent 可能把另一次运行、被替换的 contract、错误 workspace，甚至尚未终止的 Executor 结果用于 settle。完成文字、YAML、commit 或退出码也可能被误当作 Root Broker 的官方终止证明；重试时还可能复用旧 run 的结果，破坏 task/attempt 隔离。

## 3. 触发条件

对 Planned task 完成 `goal_dispatch` 后，直接调用 `goal_settle`，或在 Subagent spawn 前后修改 contract、cwd、attempt、owner；当前路径没有不可变 `task.executor_bound` 记录，也没有在 settle 时按 runId 查询 Root Broker 的只读 ownership 与 terminal proof。

## 4. 根因

Goal Engine 与 Subagent runtime 只有一次性 dispatch contract 交接，没有 spawn 前后双重校验和 post-spawn durable binding。Root Broker 虽然内部保存 owned run 与 process terminal，但未提供冻结的只读证明接口；Goal reducer 也没有 executor binding 状态与冲突约束。

## 5. 修复方案

为 Planned task 增加不可变 `task.executor_bound`：精确绑定 goal/task/attempt、contractHash、workspace、lease owner 摘要、runId 与 asyncDir。Subagent 在 spawn 前和 execute-time 分别重算 ticket，并确认 worktree 仍位于干净的 dispatch HEAD；spawn 后复验 lease owner 再持久化 returned run。Root Broker 只有在取得非空 process birth identity 后才标记 owner 为 verified，并深拷贝、冻结 ownership/terminal proof 快照；冲突 proof 只置冲突标记、绝不替换首份证明；`goal_settle` 必须验证 binding、owner、asyncDir 与成功官方终止证明，legacy Goal 保持原有完成路径。

## 6. 防回归

增加纯 binding、Subagent transport、Root Broker 与真实 Goal tool 测试，覆盖缺 binding、contract 任一字段变化、execute-time replacement、spawn 前 dirty/commit、spawn 后 owner replacement、跨 attempt 重复 runId、错误 owner/asyncDir、缺失或冲突 proof、非成功终止、外部 proof 对象事后篡改，以及 generic reviewer/非 Goal coding run 不受影响。所有测试先 RED，再以最小实现转绿；Root Broker 不获得任何 Git 删除能力，Goal model-facing ABI 保持精确七工具。
