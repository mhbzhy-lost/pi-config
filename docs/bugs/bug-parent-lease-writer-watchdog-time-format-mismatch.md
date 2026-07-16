# Parent Lease Writer 与 Watchdog 时间格式不一致

## 现象

Parent lease writer 生成的真实 lease 会被 child watchdog 在第一次检查时判定为非法，即使 Parent 刚刷新 heartbeat，最终导致仍存活的 Parent 所属 Plan Runner 被错误终止。

## 影响范围

所有使用 `createParentLease` 与 `startParentLeaseWatchdog` 组合的真实 Plan Runner。现有单元测试分别测试 writer 和 watchdog，并使用了两种不同的手工 fixture，因此未覆盖真实边界。

## 复现步骤

用 `createParentLease().beat()` 写入 lease，再让 `startParentLeaseWatchdog` 读取该文件。writer 写入 ISO 8601 字符串 `updatedAt`，watchdog 的 `validLease` 要求 `Number.isFinite(updatedAt)`，第一次检查即调用 `onExpired`。

## 根因

同一模块内的生产者和消费者没有共享时间字段合同：writer 的默认 `now` 返回字符串，watchdog 的默认 `now` 返回毫秒数字。测试通过手写数字 `updatedAt` fixture 绕开了生产者输出，导致接口不一致未被发现。

## 修复方案

将 lease `updatedAt` 统一为 Unix epoch 毫秒数字，writer 与 watchdog 均使用该合同；新增真实 writer 输出驱动 watchdog 的组合测试，避免再次用不一致 fixture 隔离验证。

## 验证方式

先运行组合测试确认真实 writer 输出触发错误终止，再统一时间格式并确认组合测试、全部 lifecycle 测试及 Plan launcher/control 回归测试通过。
