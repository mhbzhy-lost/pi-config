# Bug: executor 完成工作后被 acceptance 验证拒绝

## 现象

executor 成功创建文件并 commit（`86d4df6`），但 pi-subagents 的 acceptance
验证拒绝了 run：

- `tests-added evidence missing from child report`
- `Required criterion 'criterion-2' was not reported`

attempt 被标记为 `failed`，导致 plan 无法推进。

## 根因

coordinator 的 dispatch 指令没有设置 `acceptance` 字段，
pi-subagents 使用默认的 `attested` 策略，要求 executor 提供测试证据等。
对于简单的文件创建任务，这些证据不存在，导致 acceptance 失败。

plan-runner 有独立的 gate 系统（deterministic, plan-audit,
external-review, final-completeness），不需要 pi-subagents 层面的
acceptance 校验。

## 修复

coordinator dispatch 指令中添加
`acceptance: { level: "none", reason: "plan-runner manages verification through dedicated gates" }`
