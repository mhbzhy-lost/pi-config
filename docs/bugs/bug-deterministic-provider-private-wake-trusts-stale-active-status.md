# Deterministic provider 在 private wake 后信任陈旧 active 状态

## 一、现象

`task63bl` 的 exact Harness 只运行一次，结果为 TAP `1/0/1` 超时。generation `e7ac557b` 完成 exact-once 派发：两个 Executor 均已派发，但在完成前留下了 `plan_status active`；随后两个 Executor 的 commit、acceptance 与 official 均为 `exit 0`。queued-push 又产生 generation `74a3079f`，该 generation 进程同样为 `exit 0`，但没有任何 tool call，attempt 仍为 `active`。

## 二、证据与反证

`task63bl` 报告把 `isNested: true` 和 `nested-subagent-events` 误称为最早发生的拓扑失败。但 Harness 第 143 行先等待 plan validated 并在此超时，topology 断言只会在 `assertFutureGreen` 之后执行，因此该拓扑判断不是本次超时的先行证据。

既有文档 `bug-flat-harness-trusts-upstream-isnested-route-flag.md` 以及提交 `5326949`、`1b35f55` 已证明，pinned `isNested` 是 route-capability quirk；真实 `asyncDir` 仍位于顶层，且没有 parent、depth、path。因此，`isNested` 不是本次 completion 未被消费的根因。generation 3 的零 tool call 与旧 `active` 状态，才是有效的业务证据。

## 三、根因

`decideDeterministicTurn` 当前只计算 `latestPrivateWake` 布尔值。它仅在 exact lifecycle marker 的 `latestPushIndex > latestStatusIndex` 时调用 `plan_status`。

queued-push revival 的 durable private message `A durable Root broker wake is pending.` 已经比旧 `active` status 更新；但如果 `before_agent_start` subscribe flush 生成的 local marker 未进入当前 provider context snapshot，代码就会落入旧 `active` 分支并返回 `PLAN_RUNNER_WAITING_LIFECYCLE`。结果是当前 private wake 已被消费，却没有刷新 status。

## 四、正确修复

计算 `latestPrivateWakeIndex`：只对 latest user text 按行做 private message 的 exact 匹配；同时保留 `latestPrivateWake` 布尔值。在 durable reply 逻辑之后、lifecycle marker 逻辑附近增加判断：当 `latestPrivateWakeIndex > latestStatusIndex`、`latestStatusIndex >= 0` 且 `plan_status` 可用时，调用 `plan_status`。

已有 `status = -1` 的 plan-opened private wake 仍应直接执行 `plan_continue`。同一个 private wake 获得新 status 后，status index 会大于 wake，不得重复 poll。exact marker equality 与 private exact line 匹配必须保持不变，不使用 `trim`、`includes` 或正则表达式。

## 五、TDD

先新增 RED：history 包含 bootstrap/open、dispatch-required、两个 successful subagent 结果、authoritative `plan_status`（显示两个 `active` attempts），最后追加 `privateWakePrompt`。预期结果为调用 `plan_status`，当前实际结果为 `PLAN_RUNNER_WAITING_LIFECYCLE`。

再增加 non-loop 断言：同一 history 在 private wake 之后已经存在新的 `active plan_status` 时，仍应 waiting，且不得再次调用 status。当前第一项是真正的 RED，第二项是保护性 GREEN。GREEN 阶段只修改 `test/fixtures/deterministic-provider-state.mjs`。验证范围为 provider total 增量、provider + Capsule、Root fixed socket `131/131`；真实 Harness 在修复前不重跑。

## 六、影响边界

本修复只处理真实 Harness deterministic provider 对 Root durable wake 的进度恢复。不修改 production Broker、Capsule、backend 或 event schema；不扩展 public `caller.followup`；不引入轮询或 sleep；不改变 dispatch identity 或 exact projected lifecycle marker。
