# T20：Responses tool-call ID 与 v2 intent 的不兼容归因

## 调用链（自模型面到 native sender）

1. `supervisor-operation-tools.ts` 的 factory 为每个工具固定注入内部 `action`，调用方传入的 `action` 一律 fail closed；`replyTo` 是受控路径唯一定位权威，`to` 只在无控制面兜底路径被消费。
2. `extension.ts` 的 `createControlledSupervisorAdapter` 用 `params.replyTo` 取回 request，再构造 `supervisor-control-intent.v2`。
3. 修复前该处直接写 `intentId: toolCallId`（Host 提供的 tool-call ID 原文）。
4. `supervisor-control-plane.ts` 的 strict parser 校验 intent 字段形态，随后才是 owner/gate 判定与 native sender 投递。

## 首个偏离点

第 3 步：Responses 风格 Host 会把 tool-call ID 投影为复合形态 `call_*|fc_*`，strict v2 parser 不接受该形态，于是在 gate 之前返回 `SUPERVISOR_INTENT_INVALID`。本会话 request `e295a31b-bc52-481f-83c2-ed11e2643260` 的合法 reply 被拒即此路径。

## 分类

**production（本仓合同缺陷）**：合法 Host 入口产生的 ID 形态无法被本仓 strict parser 接受，身份/时间/资源事实均有效，不是测试制造数据。处置是最小修复（T24：从 Host opaque ID 派生稳定的内部 intent ID），不是放宽全部 ID 字符集，也不是绕过 gate 直接调用 native sender。

## 未证与边界

- 历史 R06 个案（`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`）是否同因**未证**：缺同次 request/run/ownerGeneration/childIndex 与登记→提交→消费→reconciliation 时序，仍 `blocked-evidence`，见 `historical-provenance.md`。
- `pending` 能列出该 request 只证明登记可见，不证明 sender plane/registration 完整，也不证明 reply 已被消费。
- 未读取完整真实 session、authority/state 或凭据；未重复用相同参数触发失败。
