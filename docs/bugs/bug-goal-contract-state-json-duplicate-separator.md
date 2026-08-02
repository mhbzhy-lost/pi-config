# Bug: Goal Contract 状态写入重复 JSON 分隔符

## 症状
恢复 `plan-ir-v3-complete-capsule-contract` 时，`state.json` 无法被 JSON 解析器读取；错误定位到 `next_action` 行尾连续出现两个逗号。

## 影响
Goal Contract 的恢复入口失去机器可读性，后续 slice 无法可靠校验或更新状态。聊天摘要虽然仍能提示当前任务，但不能替代损坏的权威状态文件。

## 复现
运行 `node -e "JSON.parse(require('node:fs').readFileSync('.state/goal-contract/goals/plan-ir-v3-complete-capsule-contract/state.json','utf8'))"`，稳定得到 `Expected double-quoted property name`。

## 根因
上一轮将 `current_slice` 和 `next_action` 推进到 `flat-runtime-task-4` 时采用了手工文本更新，`next_action` 的既有分隔符未被替换而是又追加了一个分隔符。故障只存在于该次写入；其他 Goal Contract 状态文件均可解析。

## 修复
删除 `next_action` 行的重复逗号，不改变任何 Goal Contract 语义或生产逻辑。后续每次检查点更新后立即执行 JSON 解析和 Goal Contract validator，避免损坏状态进入下一轮恢复。

## 验证
重新运行直接 JSON 解析，并使用 `validate_goal_contract.py --registry .state/goal-contract/registry.json` 验证完整恢复结构。
