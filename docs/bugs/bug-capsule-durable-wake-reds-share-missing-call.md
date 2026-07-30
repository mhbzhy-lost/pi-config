# Bug：Capsule durable wake 复合 RED 被缺少调用遮挡

## 症状

`6208dcb` 的三个顶层测试分别覆盖 durable exact call、重复结果去重和请求失败后的重试，独立执行时均为 RED；当前共计 `48 pass/3 fail`。但三个测试都先依赖 `requestCallerFollowUp` 被调用，缺少该调用时会在共同前置处失败。

## 影响

共同前置失败只能证明 Capsule 尚未发起 durable wake，不能证明重复 `plan_open` 结果受到保护，也不能证明一次失败后可以再次请求。去重和重试 RED 因此被 durable exact call 的缺失遮挡，失败信息无法对应各自合同。

## 复现

在 `HEAD=6208dcb` 运行 `node --test test/plan-capsule-extension.test.mjs`，三个顶层测试均失败。即使单独运行“deduplicates repeated plan_open tool results within a session”或“retries a durable Root wake after request failure”，也会先因 `requestCallerFollowUp` 未被调用而不能到达其重复调用或失败后第二次调用的断言。

## 根因

三个行为 RED 在同一条 wake 请求链上一次性加入：exact call 是去重和重试的必要前置。尚未先让 durable exact call 单独 GREEN，后两个测试就不能隔离其状态时序合同：去重要求在 `await` 前记录 sent，重试要求仅在 `await` 成功后记录 sent。

## 修复

严格串行拆分，生产实现等待重新拆分后的 RED：

1. 仅保留 durable exact call RED/GREEN，确认成功 `plan_open` tool result 对 `requestCallerFollowUp` 发出一次精确 wake 请求。
2. 再加入 dedupe RED/GREEN，令 `sent` 在 `await requestCallerFollowUp(...)` 前写入，重复 tool result 只能产生一次请求。
3. 最后加入 retry RED/GREEN，令 `sent` 移到 `await` 成功后写入；第一次请求拒绝时不留下 sent，下一次 tool result 能再次请求。

## 验证

每个阶段只允许该阶段新增的唯一预期 RED，且其失败必须命中目标合同：第一阶段是 exact call，第二阶段是重复保护，第三阶段是失败后重试。前一阶段 GREEN 后再进入下一阶段；每阶段其余 Capsule 测试必须全绿。最终重新运行 `test/plan-capsule-extension.test.mjs`，确认没有由缺少 `requestCallerFollowUp` 调用造成的复合失败。
