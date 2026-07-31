# Deterministic provider 跨 generation 回退旧 Attention envelope

## 1. 现象

Provider 反向扫描整个会话中的 `PI_PLAN_ATTENTION_REPLY`，遇到较新的 malformed envelope 时继续向前寻找并接受旧 generation 的 valid envelope。

## 2. 影响

当前 generation 的消息损坏时，deterministic Harness 可能尝试回复上一条 Attention request。Capsule 会阻止未授权输入，因此不是权限绕过，但 Harness 会产生错误路由与误导性失败。

## 3. 时间线

- `68b8694` 增加 Pi LLM conversion 真实 RED。
- GREEN parser 支持 conversion 后的普通 user envelope。
- 独立审查发现 parser 未把 envelope 搜索范围绑定到最新 private wake。

## 4. 根因

Parser 以整个 canonical message 列表为搜索域，并把 malformed envelope 当作可跳过噪声。它没有使用 provider 已计算的 `latestPrivateWakeIndex` 作为 generation 边界。

## 5. 触发条件

会话中存在旧 valid envelope；最新 private wake 之后存在 malformed envelope；旧 request 尚无对应 Supervisor tool result 时触发。

## 6. 修复与验证

Attention revival 只解析最新 private wake 之后的当前 generation 消息；该范围内出现 envelope marker 但格式无效时 fail closed，不回退到 wake 之前。无 private wake 的 legacy bootstrap 单测继续支持内部 custom message。RED 必须先证明当前实现会错误回复旧 request。
