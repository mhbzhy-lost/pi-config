# Bug：goal_status 无法重放历史 v2 任务契约

## 1. 现象

部署初始化安全门禁后，对已有 TokenRec Goal 调用 `goal_status` 直接失败：`taskDef task1-skeleton acceptance.commands[0] must not use absolute cd`。该 Goal 在门禁上线前已由旧版 `goal_init` 成功持久化，当前只读状态查询却无法返回 projection。

## 2. 影响

所有包含旧版允许、但新版禁止任务字段的历史 v2 Goal 都可能无法执行 `goal_status`，也无法依据状态进行 `goal_amend` 恢复。Agent 会失去恢复入口；不过事件和 projection 文件没有被本次只读失败修改。

## 3. 稳定复现

1. 写入一个历史 `goal-engine.event.v2` 的 `goal.created` JSONL，其中 acceptance command 使用绝对 `cd`。
2. 通过 store `loadProjection()` 或真实 extension 的 `goal_status` 重放该日志。
3. 观察重放在 `validateTaskDefinitions()` 中抛错，而不是返回 version 1 的 active projection。
4. 对同样不安全的新 v2 create/amend 执行 append，确认新写入仍必须被拒绝且日志零变化。

## 4. 根因

新增任务契约门禁直接放在 `applyEvent()` 的 v2 create/amend reducer 路径中。store 的历史重放与新事件写入共用同一严格调用方式，且 v2 schema 没有可区分“门禁上线前后”的标记，因此新规则被反向施加到已经持久化的 v2 日志。

## 5. 促成因素

兼容性测试只覆盖了 v1 oversized/unsafe 历史事件，没有覆盖门禁上线前已经存在的 v2 create/amend。测试也只证明直接 `applyEvent()` 会拒绝新无效事件，没有同时证明“历史 replay 宽容、新 append 严格”的双边界。

## 6. 修复与验证策略

在事件层显式区分历史 replay 与新 mutation：store 重建已有 JSONL 时使用兼容模式，只跳过后来新增的 task-contract/derived-dispatch 门禁；append 的候选事件继续走严格模式，保留事件层最终拒绝和原子性。先增加真实 JSONL 与 extension `goal_status` RED 测试，再做最小实现；同时验证历史 v2 create/amend 可重放、新 unsafe create/amend 仍拒绝、失败 append 不修改 events/projection/registry，并复跑完整 Goal Engine 与真实 Pi Host 测试。
