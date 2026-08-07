# Goal Engine discovery 的 new_goal 处置被拒绝

## 1. 预期行为

已完成 Goal 的绑定会话发现无关后续工作时，用户可将该发现明确处置为 `new_goal`；该处置只解除旧 Goal 的写入门禁，不重新开启旧 epoch。

## 2. 实际行为

`goal.discovery_resolved` 只接受 `tasked`、`out_of_scope`、`duplicate`，因此已声明的 `new_goal` 处置被 reducer 拒绝。

## 3. 稳定复现

对 completed-watching projection 记录 discovery 后追加 `goal.discovery_resolved { disposition: "new_goal" }`，reducer 抛出 `invalid discovery disposition`。

## 4. 根因

设计的 disposition 集合已包含 `new_goal`，但 v3 reducer 和扩展层 schema 未同步该枚举。

## 5. 影响范围

无关的新工作不能显式脱离旧 Goal；会话继续被旧 Goal 的 continuity debt 锁住，Agent 容易错误 reopen 或绕过门禁。

## 6. 修复与验证

仅在 v3 discovery resolution 中加入 `new_goal`，禁止其携带旧 Goal task；扩展层 triage 接受该显式值。回归测试断言它不 reopen、会清除 debt，并保持 accepted 历史不变。
