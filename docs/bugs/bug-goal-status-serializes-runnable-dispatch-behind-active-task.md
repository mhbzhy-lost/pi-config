# Goal status 将 runnable dispatch 串行化在 active task 后

## 1. 预期行为

当一个较早 task 已 dispatched，且后续无依赖 task 仍为 pending+runnable 时，`goal_status` 应先为每个可安全派发的 pending task 提供 `goal_dispatch` offer；所有 runnable task 都已派发后，才返回已派发 task 的 `goal_settle`。

## 2. 实际行为

`goal_status` 按 task 插入顺序选取第一个 `requiredNextAction`。较早的 dispatched task 产生 `goal_settle`，使后续 pending+runnable task 不能取得 dispatch action token，尽管它们没有依赖且不存在 orphan workspace。

## 3. 稳定复现

创建两个无依赖 task，先通过 status offer dispatch `t1`，再调用 status。当前实现为 `t1` 返回 `goal_settle`，而不是为 `t2` 返回 `goal_dispatch`；因此无法按 status→dispatch 流程并行派发 `t2`。

## 4. 根因

`machineActionForProjection` 将普通 task 的 action（dispatch、settle、integrate、accept）混在同一插入顺序循环中。它没有在选择 settle 前先扫描所有安全的 pending runnable dispatch 候选项。

## 5. 影响范围

任意包含多个独立 runnable task 的 Goal 会被第一个 active workspace 串行化，协调器缺少 task identity 绑定的一次性 dispatch token，无法启动预期的并行 executor。

## 6. 修复与验证

保留 untriaged discovery、非 active lifecycle、orphan 和 task action state 所表达的安全门禁优先级。先扫描无 orphan 的 pending+runnable task 并返回首个 `goal_dispatch`，再按原插入顺序返回 settle、integrate、accept 等动作。测试覆盖先 dispatch `t1` 后 `t2` 取得 token，以及全部派发后回退到 `t1` 的 settle。
