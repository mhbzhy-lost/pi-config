# Bug: 扁平 Launcher 审查发现的生命周期缺口

## 症状

1. Root 空闲时收到 Attention，Launcher 仅传递消息第一参数，未保留 `triggerTurn: true` 与 `deliverAs: "followUp"`；消息只会追加，不能唤醒交互轮次。
2. `closeRootSession()` 与 `grantCaller()` 并发时，关闭完成后延迟写入的 caller grant 仍可发布并遗留在磁盘。
3. grant 或 bootstrap 失败后，workspace rollback 与 runner stop 并行执行，rollback 可能早于 stop 完成。
4. Capsule 仍使用旧的 Standalone control plane 文案，未明确授权边界。
5. Attention 仅检查 `bodySha256` 格式，不复核正文实际 hash，损坏正文仍可带着原 evidence 转发。
6. terminal runner 的 projection 缺失时，读取 projection 与读取终态被绑定在同一个 `Promise.all`；`ENOENT` 会掩盖终态，poller 不会停止。

## 影响

Attention 无法主动唤醒空闲 Root，用户可能看不到需要处理的计划请求。关闭后的陈旧 grant 会继续提供认证能力，破坏 Root session 关闭边界。runner 尚未停止就删除 workspace，可能令仍在运行的进程访问已回滚目录。旧文案会误导模型绕过当前授权边界。未校验的正文会使 Root 基于错误 evidence 行动；poller 泄漏则会在 session shutdown 前持续占用定时资源。

## 复现

1. 使用 idle Root 的 fake transport 发送 Attention，断言 `sendMessage` 未收到 follow-up 选项，消息被追加但未启动 turn。
2. 延迟 `writeGrant()`，先等待 `closeRootSession()` 返回再释放写入，可观察 grant 调用成功且文件仍存在。
3. 延迟 stop Promise 后触发 grant/bootstrap 失败，可观察顺序为 `stop-start`、`rollback`、`stop-end`。
4. 调用 Capsule 的阻断路径，返回文本仍含 `Standalone Plan Runner control plane`。
5. 令投影 hash 对应 `original`、正文为 `tampered`，事件仍被转发，声明 hash 与实际 SHA-256 不一致。
6. 令上游状态返回 `failed`、projection 读取抛出 `ENOENT`，确认 poller 未进入 terminal 停止分支。

## 根因

transport 迁移时只保留了消息第一参数，丢失旧 Launcher 的 Attention 唤醒选项。caller grant 没有纳入 close 的 pending 资源集合，关闭只等待已登记的 executor grants，无法围住尚在写入的授权发布。失败 cleanup 误用并行 `allSettled`，把必须有先后关系的 stop 与 rollback 同时启动。evidence 只校验 hash 格式而未计算正文 hash。poller 又把 projection 可读性和 runner 终态这两个独立状态绑定到 `Promise.all`，因此 projection 缺失会遮蔽终态。

## 修复

修复严格限定在 Task 4：Attention 使用 follow-up trigger 投递；为 caller grant 建立 pending close fence，关闭期间拒绝或等待发布；仅在 stop 成功完成后执行 rollback；读取 Attention 正文后校验 SHA-256；将 terminal 状态观察与 projection 读取拆开；将 Capsule 文案改为授权边界；并为 `cwd`、`originRoot`、`stateRoot` 分别补充逐字段 roots 测试。不得提前实现 Task 5 至 Task 10 的 poller 删除、完整 run drain、Supervisor 路由或旧 runtime 迁移。

## 验证

先为上述合同编写 RED 聚焦测试，再使 Launcher、Capsule 与 Root broker 测试 GREEN。覆盖 close/grant 延迟竞态和关闭后无陈旧 grant、cleanup 中 stop 完成早于 rollback、正文 hash mismatch 被拒绝、projection 缺失但 runner terminal 时 poller 停止、Capsule exact reason，以及 `cwd`、`originRoot`、`stateRoot` 的逐字段非法 roots。最后执行全部既有门禁；全量门禁结果必须如实记录，不能以聚焦测试替代。
