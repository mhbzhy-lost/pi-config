# 纯派发回执 `triggerTurn` 决策

## 调查范围

本次只读检查了本仓 runtime membrane、TUI completion observer 和已安装 `pi-subagents@0.75.0` 的 completion sender；未运行真实派发、Host、模型或 provider。

## Sender 与字段 owner

当前真正调用 `sendMessage` 的 completion sender 位于上游：

`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/notify.js`

其 `sendCompletion()` 根据上游事件的 `result.triggerTurn` 聚合决定 `{ triggerTurn: items.some(item => item.triggerTurn) }`。`packages/pi-subagents-enhanced/src/tui/completion-notices.ts` 只监听 `message_end` 并投影 TUI，不是 sender；`runtime-membrane.ts` 只透传 `sendMessage` options，不拥有 workflow receipt selector。

## 结论

- `ownerComponent`：upstream completion sender。
- `ownerPath`：`node_modules/pi-subagents/src/runs/background/notify.js`（上游安装物，禁止本仓修改）。
- `ownerScope`：`upstream`。
- 当前可见的结构化输入有 `result.triggerTurn`、completion details 和 batch 状态，但没有本仓可证明的“单条 workflow dispatch complete 且相对 tool result 无新增业务结果”专用字段。
- 仅按标题文本或 child 数量选择会误伤真实 completion/failure/decision，也无法满足字段缺失 fail-closed。

## 决策

暂缓本轮 T9 production 实现。保留消息投递、持久化、TUI observer、事件和原始 content 的现有语义；不改上游 `notify.js`，不在 TUI observer 中承担 sender 职责，不创建第二 sender 或私有 IPC。上游 sender 的位置不等于所有本仓 options 接入点均不可行；现有记录尚未证明完整字段/接入合同，也不能断言上游新增字段是唯一解法。后续若获授权，应先核实稳定 receipt 输入与合法 options 接入点，再修订准确 WritePaths 和验证范围。

## 验证限制

只完成源码边界核对；未运行真实派发、未测试真实 `triggerTurn` 消息回合行为，现有 completion-notices 测试不被视为 selector 覆盖。
