# Bug: revision dispatch 接受未知事件字段

## 症状
带 revision identity 的 `attempt.dispatch-requested` 事件在包含未定义字段时仍被投影接受。

## 影响
事件绑定合同不能保证 dispatch 输入的精确结构，未知字段可能被上游误认为已受验证，削弱重放和审计边界。

## 复现
运行 `node --test test/plan-events.test.mjs`；`extra dispatch key` 用例传入 `unexpected: true`，预期拒绝但当前未抛错。

## 根因
`requestDispatch` 仅逐项校验四个 revision hash 字段的格式和三个比对值，没有在 revision 分支校验完整的事件数据键集。

## 修复
仅在带 revision 的 dispatch 分支校验 `attempt.dispatch-requested` 的精确键集；保留无 revision 的 legacy event replay 路径。

## 验证
新增 identity mismatch matrix 覆盖 `planIrHash`、effective `taskHash`、`schedulingHash` 错配，以及 `dispatchContextHash` 缺失、非法格式和额外键；修复后运行两组 Task 5 回归和 `git diff --check`。
