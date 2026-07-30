# Bug: Plan Capsule 延迟注册工具无法通过 child 启动校验

## 症状

真实flat Plan Runner child加载Capsule后，`plan_open`已经注册并可执行，但pi-subagents在首轮前拒绝profile中的`plan_status`、`plan_continue`、`plan_verify`、`plan_block`和`plan_read_revision`，报告这些工具不可用。Harness无法进入模型首轮协调。

## 影响

`Root -> Plan Runner`真实启动在严格child tool validation阶段失败，parallel、Attention和amendment Harness均无法迁移。单元测试把“只注册plan_open”当成旧设计特征，因此没有暴露profile与最终registry不一致。

## 复现

1. Plan Runner profile静态声明Plan生命周期工具，但不声明`subagent`或Supervisor工具。
2. Child extension factory调用`createPlanCapsuleExtension`，当前只注册`plan_open`。
3. 其余Plan工具仅在`plan_open`成功后的`activateTools()`中注册。
4. pi-subagents在模型首轮和`plan_open`之前校验profile tool inventory，发现声明工具不在final registry并终止child。

## 根因

Capsule把“工具是否注册”和“工具当前是否授权激活”合并成同一延迟动作。严格runtime需要启动时完成静态registry，而Plan授权边界只需要控制active tool集合；两种生命周期不能共用延迟注册。

## 修复

Capsule factory阶段一次性注册全部Plan生命周期工具和`plan_open`，随后把open前active集合精确收敛为`plan_open,read,grep`。`plan_open`成功或从session事件恢复已打开Plan后，才把active集合切换为完整Plan工具、项目`subagent`和`plan_executor_supervisor`。Plan Runner profile继续不声明`subagent`，也不恢复旧wait/supervisor工具。

## 验证

增加独立RED证明factory完成后registry已包含全部profile Plan工具，以及open前active集合只有`plan_open/read/grep`；保留open后完整激活断言。真实flat Harness必须通过strict child validation并继续执行parallel Plan，且runtime tool policy与Capsule授权测试全绿。
