# Bug：Goal Engine amendment 可绕过孤儿工作区门禁

## 表现

`goal_status` 和 `goal_dispatch` 已能发现 exact candidate attempt 的 orphan Executor workspace，并要求先通过 `goal_integrate(discard|preserve)` 处置；但 `goal_amend` 只验证候选 projection 和 task contract，不检查被删除或改写 task 的 orphan inventory。调用方可直接移除或替换该 task，projection 随即失去与磁盘 workspace、lease 和 branch 的关联。

## 影响

- 删除 orphan task 后，typed tools 不再拥有可用于恢复该 exact workspace 的 task identity，资源可能永久遗留。
- 改写 task contract 会让 status 展示的新计划与旧 Executor attempt 混合，破坏“先处置旧 attempt、再修改并重派”的人工决策顺序。
- status 提供的 discard/preserve choices 可被另一 mutation 工具绕过，typed tools 不再是统一的安全写入口。

## 根因

`goal_amend` handler 在构造并验证 `goal.amended` candidate 后直接调用 `appendEvent()`。orphan inventory 门禁只接入了 `goal_status` 和 `goal_dispatch`，没有在 amendment 的 durable append 前复用 exact candidate-attempt oracle，也没有区分受 amendment 影响的 task 与无关 task。

## 触发条件

1. active goal 中的 pending task 在 projection 里没有 workspace。
2. exact next attempt 的 workspace、lease 或 branch 至少有一项仍存在，inventory 为 verified 或 unverified。
3. 调用 `goal_amend`，在 `remove_tasks` 或 `update_tasks` 中包含该 task。
4. candidate contract 本身合法，因此现有 handler 将 amendment 持久化。

## 修复方案

先按现有顺序完整构造和验证 amendment candidate，保持 schema、DAG 和 task contract 错误优先；验证通过后、append 前，仅对原 projection 中被 `remove_tasks` 或 `update_tasks` 触及的 pending task计算 exact next attempt inventory。若存在 orphan，复用与 dispatch 相同的机器恢复契约：verified 只提供 discard/preserve 多选，unverified 只允许 `goal_status`。无关 task 的安全 amendment 继续允许。

## 验证方案

1. 对 verified rollback orphan 分别执行 remove、update 和 remove+add replacement，断言稳定恢复契约及 events、projection、registry、workspace、lease、branch 零变化。
2. 对 partial-resource unverified orphan 执行 remove/update，断言不暴露 destructive choices，只返回 `goal_status`。
3. 构造非法 amendment 与 orphan 同时存在，断言 `INVALID_GOAL_CONTRACT` 优先且零副作用。
4. amendment 只修改无关 task 时应成功，并在返回的 status 中继续显示 orphan task 的恢复 choices。
5. 通过 typed discard release orphan 后，相同 task 的 amendment 应成功。
