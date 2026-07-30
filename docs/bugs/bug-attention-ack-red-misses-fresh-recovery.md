# Bug: Attention ack RED 未独立执行 fresh recovery 路径

## 症状

ACK recovery 测试把“第一次 ack 写失败”和“全新 dependencies 实例从 resolved event 补 ack”串在同一个顶层测试中。当前 production 忽略故障注入后，第一个 `assert.rejects` 立即失败，fresh recovery 断言从未执行。另一个独立测试只覆盖错误 message hash 不得 ack，是拒绝路径而非正向恢复。

## 影响

后续实现只需让注入故障生效并支持同 authorization 重试，就可能让测试变绿，而完全不实现进程重启后的 durable reconciliation。authorization Map 丢失时，resolved command 仍会永久无 ack。

## 复现

运行 `node --test test/plan-runner-dependencies.test.mjs`，唯一失败位于第一次 ACK rejection；测试输出没有独立 fresh recovery case。单独查看错误 hash case虽通过，但 matching hash 的 command 在旧 production 下仍会被跳过并保留。

## 根因

两个独立恢复行为被放在一个会早停的测试流程中，测试结构没有保证后半段在旧 production 上获得自己的 RED 证据。

## 修复

新增独立顶层测试，直接构造合法 `attempt.attention-resolved` durable event 和尚无 ack 的 matching reply command，再创建全新 dependencies 实例调用 `processAttentionReplies()`。断言零 send、零 append、command 被 ack 隐藏；旧 production 应精确失败为 command 仍存在。

## 验证

单独按 test-name 运行 fresh recovery case，旧 production 下得到明确 deep-equal 失败：实际仍含 command、期望空数组。错误 message hash case继续通过并保留 command；ACK failure/retry case保持独立 RED。
