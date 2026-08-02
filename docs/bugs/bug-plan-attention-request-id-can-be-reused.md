# Bug: Supervisor Attention requestId 可跨 Attempt 重用

## 症状
projection 只在各 Attempt 当前 `attention/lastProgress` 中保存 requestId；resolved Attention 被后续请求替换后，同一 requestId 可在另一 Attempt 再次创建。

## 影响
同名 Attention body/control/ack artifact 可能覆盖，reply 查找可能路由到错误 Attempt；amendment 的“恰好一个 request”授权也无法依赖全局唯一身份。

## 复现
创建 request-1、resolve，再在同一或另一 active Attempt 创建 request-1；当前 reducer 不维护历史集合，事件可被接受。

## 根因
Attention identity 被建模为 Attempt 当前快照，没有像 amendmentRequestIds/eventIds 一样持久化 append-only 防重集合。

## 修复
projection 增加 `attentionRequestIds` Set，copy/replay defensive；每个 blocking/nonblocking Attention request 在 mutation 前验证全局未使用并原子加入。resolved/superseded/settled 不删除历史 ID。

## 验证
新增同 Attempt/跨 Attempt/已 resolved/已 superseded/nonblocking progress 的 duplicate RED/GREEN；原 projection 在拒绝时不变，legacy replay 稳定。
