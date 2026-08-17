# 合并后非 Goal 默认测试回归

## 问题

integration 合并后，默认 `npm test`（Goal Engine 测试已迁移为 `.integration`，不属于默认 suite）有两项非 Goal 回归：

1. `test/doctor.test.mjs` 的 Doctor CLI 门禁在 10 秒后超时。`npm run doctor` 实际约需 11.31 秒且成功，因此 10 秒小于已观测的正常运行时间。
2. workspace reload fallback 返回 `inactive` workspace 时，`workspacePublic` 仍把历史 `actionToken` 映射成公开 `action_token`，导致 `details` 与 JSON `content` 泄露失效 capability。

## RED 证据

修复前的定向门禁：

- Doctor CLI 测试以 `doctor CLI timed out after 10000ms` 失败；超时处理会 `SIGKILL` 子进程并 reject，属于 fail-closed 门禁。
- `workspace reload fallback loads canonical origin, repopulates it, and omits inactive action token` 以 `action_token` 仍存在失败；同一 public workspace 对象同时用于 `details` 和 JSON `content`。

## 修复原则

- 将 Doctor CLI 测试预算提高到 30 秒，保留超时、kill 与失败行为，不修改 Doctor 生产逻辑。
- 仅在 workspace 为 `active` 且同时存在有效 `allowedDispositions` 和 `actionToken` 时公开 `action_token`；`allowed_dispositions` 及其他 public 字段保持原语义，`inactive`、`preserved`、`released` 等状态不公开旧 token。
