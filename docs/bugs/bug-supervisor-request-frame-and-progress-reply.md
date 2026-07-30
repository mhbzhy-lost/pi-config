# Bug：Supervisor request 绕过 frame 校验且允许回复 progress

## 症状

Task 7 初版 production 能通过短文本 pending/reply 测试，但 `routeSupervisorRequest()` 先用不含 `message.content` 的 details 构造并校验 push，随后把 content 手工拼入已校验对象；同时所有 request 都以 `pending` state 登记，`replySupervisor()` 没有拒绝 `expectsReply:false` 的 progress update。

## 影响

接近 native 64 KiB 上限的合法/恶意 Supervisor 文本可让 Broker 写出超过 wire 单帧上限的 push，client 随后以 `BROKER_RESPONSE_TOO_LARGE` 断开。progress update 本应是单向通知，却可能消耗一次 Root native reply，破坏 request 状态语义。

## 复现

检查未提交 Task 7 diff：`createSupervisorRequestPush()` 的两次调用都只接收 `message.details`，`content` 在返回后通过 `{ ...push.data, content: message.content }` 追加，因此 `parseBrokerPush()` 的 `assertPushFrameSize()` 看不到最终内容。`replySupervisor()` 只检查 missing/consumed/owner/replying，没有检查 `entry.expectsReply`。

## 根因

实现把“身份字段验证”和“最终 wire frame 构造”误拆为两步，并认为 native channel 已限制消息大小即可复用其上限；但 Broker envelope 自身也占字节，必须对最终 frame 重新执行协议校验。request state 又只用 `state` 表示生命周期，没有把 `expectsReply` 作为 reply authorization 条件。

## 修复

先补两个独立 RED：超大 content 必须在 Broker ingress 返回 invalid/不登记/不 push，不能让 client subscription 断开；`expectsReply:false` request 可以 owner push，但 pending 为空且 reply 返回 `supervisor_request_unknown`、Root target 零调用。随后让 `routeSupervisorRequest()` 把 content 并入 `upstreamDetails` 后一次性交给 `createSupervisorRequestPush()`，并在 reply authorization 中显式要求 `expectsReply===true`。

## 验证

串行运行新增 RED 并确认失败点分别是超限 request 被登记/导致断连，以及 progress reply 错误调用 target。修复后运行完整 Broker protocol/client/server suite，确认 frame limit、owner push、pending/reply、duplicate/conflict 和 subscription closed 行为全部 GREEN。
