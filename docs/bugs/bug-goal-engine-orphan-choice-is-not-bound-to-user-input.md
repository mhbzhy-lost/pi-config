# Goal Engine 的孤儿处置未绑定真实用户输入

## 1. 预期行为

`discard`/`preserve` 等不可逆或保留资源的分支只能来自 challenge 之后、同 session 的真实交互/RPC 用户输入；Objective/Scope/Non-Goals/DoD 修改也必须绑定用户明确批准的 proposal hash。

## 2. 实际行为

当前 recovery 只把可选动作写进 status 文本，mutation 参数不携带真实 input identity。Agent 可以把“看一下 status”解释为 discard，也能自行决定 Goal 元数据变更。

## 3. 稳定复现

TokenRec 会话中用户没有选择 discard/preserve，Agent 仍自行执行 orphan discard；Reducer/Extension 只验证 action 字符串，不验证任何用户 entry。

## 4. 根因

状态模型缺少 pending human challenge 和 recorded decision，Extension 也没有区分 interactive/RPC 用户输入与自身注入消息。

## 5. 影响范围

可能丢弃仍需检查的 workspace、保留无主资源，或未经授权改写 Goal 的 Objective/Scope/Non-Goals/DoD，审计日志无法证明选择来源。

## 6. 修复与验证

新增真实选择纯逻辑：只接受 challenge 之后、同 session、source 为 interactive/RPC 且文本精确匹配单一 choice 的 user entry；元数据审批额外绑定已展示 proposal 的 SHA-256。先写 source/session/time/歧义 RED，G6 再接入事件与工具。
