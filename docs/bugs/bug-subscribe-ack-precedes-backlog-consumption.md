# Subscribe ACK 早于 queued backlog 消费完成

## 一、现象

task63bp exact Harness 在 HEAD `7922b1f` 加两批准 migration 上严格一次，约 32.9 秒，TAP 1/0/1。provider private wake 修复已生效：generation 3 `b8e3e730` 在 queued-push revival 后确实恰好调用一次 `plan_status`，但两个 attempt 仍 active。两个 Executor calls/handles/actual dirs 均为 2 且各 exact-once、official exit 0，flat topology 通过；无 completion lifecycle message、无 `attempt.settled`，gen3 terminal 后 Broker 诊断 wake-missing。

## 二、证据/反证

gen2 session 有两条 `execution.started` local lifecycle messages 与两个 `plan_status`，证明 subscription/onPush 路径对 live push 可工作。gen3 只有 private wake 与 `plan_status`，无 `execution.completed` local message，证明 provider marker 不是本次根因。Broker queued-push revival 和最终 wake-missing 共同证明 queue 先非空后被移除；owned root 已 ENOENT、5 PID ESRCH、S2=S0。不能从无 journal 虚构客户端已执行 `onPush`，但源码时序提供竞争。

## 三、根因

`RootBrokerServer.respond` 先 `socket.write` subscribe success ACK，在其 write callback 才 `activateSubscription -> flushCallerPushQueue`；`createRootBrokerClient.subscribe` 读到 ACK 立即 set acknowledged 并 resolve(handle)。Promise continuation 可让 Capsule `before_agent_start` 返回并启动 provider，而 backlog push 可能仍在后续 data frame。generation 3 迅速 `plan_status=active` 并退出，`session_shutdown` dispose client；server 已在 `socket.write` 时 shift queue 并 `onDelivered`，导致 wake-missing 和 completion 丢失。ACK 仅证明 subscription 请求成功，不证明 ACK 后 FIFO 已进入 `onPush`。

## 四、正确修复

增加 typed private `subscription.ready` broker push，data 必须 exact 空对象。Server 严格顺序 ACK write callback -> activate/register -> FIFO flush -> write ready barrier。Client 收到 ACK 只进入 acknowledged，不 resolve；按序解析并调用全部普通 `onPush`；只有收到 identity 匹配的 `subscription.ready` 才 resolve subscribe。ready 不传给业务 `onPush`。无 backlog 也发 ready。保持 ACK-first、FIFO、logical/actual alias fence。禁止 sleep/`setImmediate` 猜时序、poll、扩展 `caller.followup` 或修改 Capsule 去重。若 ACK 后断开且 ready 未到，subscribe Promise 必须 reject 而不是返回可用 handle。

## 五、TDD

tests-only RED 包含：

1. `root-broker-subscribe-flush.test.mjs` 既有 ACK/FIFO 期望尾部增加 ready；
2. real `RootBrokerServer + createRootBrokerClient`，拦截 activate：ACK 已发送但未 release activation 时 subscribe Promise 必须 pending；release 后普通 queued push 先进入 `onPush`、ready 不暴露、Promise 再 resolve；当前会在 ACK 时过早 resolve；
3. protocol 接受 exact ready 并拒绝非空 data；
4. revival FIFO expected frame 补 ready。

GREEN 最小改 `root-broker-protocol.ts`、`client.ts`、`server.ts`。focused tests 后单独串行 fixed socket 131（增量后按实际 total）、revival/backend/Capsule 回归；真实 Harness 修复前不重跑。

## 六、影响边界

只改变 Root 私有 subscription 握手完成定义，不改变 execution lifecycle payload、public Plan 事件、dispatch identity、terminal proof、revival generation 或 provider 语义；不恢复 Standalone/fanout/re-root。兼容性要求 server/client 同版本内部升级；旧未知 ready 必须 fail closed。
