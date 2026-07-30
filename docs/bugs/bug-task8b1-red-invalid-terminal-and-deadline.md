# 8B1 ordered drain RED 合同偏差

## 症状

`Root session ordered drain` 的 RED 测试夹具生成了无效 terminal schema：`observedAt` 为 ISO 字符串且缺少 `instances`；unknown 使用了不在枚举内的 `not proof` reason。夹具还把不应由 terminal event 伪造的 `sessionId` 与 `asyncDir` 放入事件。pending 用例等待 75ms，已经超过配置的 50ms terminal deadline；cleanup debt 用例错误地期待尚未尝试 stop。

## 影响

测试可能因协议校验失败、deadline 到期或未处理的 rejection 而非 ordered drain 行为失败，不能作为 production 尚未实现 drain 的可信 RED 证据。cleanup debt 断言还会掩盖“先尝试停止 Executors、保留 Plan Runner debt”这一要求。

## 复现

执行：

```sh
node --test --test-name-pattern='Root session ordered drain' test/root-subagent-broker.test.mjs
```

原测试会发送字符串 `observedAt`、无 `instances` 的 observed event，以及 reason 为 `not proof` 的 unknown event；pending 观察时间为 75ms，超过 50ms terminal timeout。

## 根因

测试在 31a146f 中先按旧的宽松事件形状构造 terminal，再新增 pinned terminal proof 合同。其后没有同步更新 fixture、deadline 观察窗口和 cleanup debt 预期，因此“stop request 不是 terminal proof”与“unknown 只允许受控 reason”没有被准确表达。

## 修复

提供只生成 pinned exact proof 的 terminal helper：observed 使用有限 number `observedAt` 和匹配的 runner `instances` 项；unknown 仅使用 `observer-unavailable`，且不带 `observedAt` 或 `instances`；事件只传输 run identity 与 terminal proof，不伪造 session 或 async directory。将 pending 观察限制到明显小于 timeout 的有界窗口，并将 debt 断言改为先 stop 两个 Executors、未 stop Plan Runner。

## 验证

严格串行执行 ordered drain 测试。五个用例应均以 production 尚未实现 ordered drain 的断言 RED 失败，而不出现 TypeError、unhandledRejection、测试超时或取消；检查输出应包含预期断言、pending、stopOrder 或 dispose 证据。
