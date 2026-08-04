# Bug：历史 v2 create 重放绕过 DAG 不变量

## 1. 现象

历史 v2 兼容修复为 `applyEvent()` 增加 replay 模式后，包含循环依赖的 `goal.created` 在 strict 模式会被拒绝，但通过 store `loadProjection()` 重放时却成功生成 active projection。

## 2. 影响

损坏或被错误替换的历史 v2 JSONL 可以形成无可执行前沿的循环任务图，`goal_status` 仍将其当作有效状态；后续 append 也会以非法 projection 为基础。原 TokenRec 的绝对 `cd` 兼容需求并不要求放宽 DAG。

## 3. 稳定复现

1. 手工写入一个 v2 `goal.created` JSONL，任务 `a` 依赖 `b`、`b` 依赖 `a`。
2. 调用 `loadProjection()`。
3. 观察 strict `applyEvent()` 报 `dependency cycle`，而 replay 返回 version 1 projection。
4. 另以绝对 `cd` 的合法 DAG 历史 create 为基础，append 一个改为相对命令的安全 amendment，验证恢复写入及三份持久状态一致。

## 4. 根因

v2 create 的 replay 分支整体跳过 `validateTaskDefinitions()`，却没有像 amendment replay 一样补回 `validateDAG()`。因此为了兼容后来新增的路径、command 和派生 dispatch 门禁，同时错误跳过了任务图结构校验。

## 5. 促成因素

首轮回归测试只验证绝对 `cd` 可重放和新 mutation 仍严格，没有为 replay 保留 DAG 不变量建立独立 oracle；恢复测试也只验证 load 和拒绝路径，没有覆盖 unsafe 历史 projection 上成功 append 安全 amendment。

## 6. 修复与验证策略

先增加 RED：历史 v2 create 的循环/未知依赖必须在 store replay 被拒绝，同时绝对 `cd` 的合法 DAG 仍可读取。再补成功恢复路径：从 unsafe 历史 create append 安全 amendment，精确检查 events 增加一条、projection 更新为安全命令、registry 保持 active 且版本一致。实现只在 v2 create replay 构造 task map 后执行 `validateDAG()`，不恢复后来新增的 command/path/dispatch 门禁；复跑目标、全 Goal、真实 Host 和 Doctor。
