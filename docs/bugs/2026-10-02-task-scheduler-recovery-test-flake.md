# task-scheduler runtime 集成测试 recovery 注入时序不稳定

日期：2026-10-02

## 来源分类

分类暂定为测试 harness/fixture 时序问题，尚未证明 production 可达。失败来自 `test/task-scheduler-runtime.integration.mjs:17-28` 的注入式测试：`recoverySource` 是测试直接注入的 public-shaped outcome，测试固定只等待两个 microtask 后断言消费结果。

## 首个偏离点

测试断言时 `onRecoveryOutcome` 尚未必完成；全量 integration gate 复现 224/225，失败测试为该用例，production 判定与默认路径未显示异常。不得为 production 增加延迟或 fallback。

## 修复边界

先重复运行聚焦测试确认是否稳定失败/通过；若确认仅为测试等待协议，则只修测试 harness，使用有界、可观察的完成等待，不改变 extension 的实际消息或 outcome。
