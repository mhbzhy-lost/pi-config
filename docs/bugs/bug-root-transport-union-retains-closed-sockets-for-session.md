# Bug：Root transport union 过早持有已关闭 socket

## 1. 现象

`b286f97` 让 Root broker 的 `handleSocket()` 在 accept 时把每个 socket 加入
`transportSockets`，`subscribe` 时也再次加入。短连接在响应后关闭时会从 live `sockets`
移除，订阅连接关闭时会从 `subscriptions` 移除，但它们仍留在 `transportSockets`，直到
Root session 的 final release 才被清空。

## 2. 影响

- 一个 Root session 期间出现过的所有短连接都会被 `transportSockets` 强引用，即使 socket
  已关闭。
- 长时间运行且请求频繁的 Root session 会持续积累无用 socket 对象，造成不必要的内存占用。
- transport teardown 的处理对象从当前 live transport 扩大为整场 session 的历史连接，使
  teardown 的资源边界与实际需要不一致。

## 3. 触发条件

- Root broker 接受普通请求连接，响应后该 socket close，但 Root 尚未 teardown。
- 或订阅连接 close，`subscriptions` 的 close 回调已将其移除，但 Root 尚未 final release。
- 在上述期间检查集合时，`sockets` 或相应 `subscriptions` 已不含该 socket，而
  `transportSockets` 仍含有它。

## 4. 根因

`b286f97` 将 `transportSockets` 当作从 accept 起累计的全量集合：`handleSocket()` 与
`subscribe` 都执行 `transportSockets.add(socket)`，但 close 回调只从 `sockets` 或
`subscriptions` 删除。`transportSockets.clear()` 仅位于 final release，因此已关闭且已从
live 集合删除的 socket 仍被整场 Root session 强引用。

正确语义应是：首次进入 transport phase 时，才从当前 live 的 `sockets` 与
`subscriptions` 构造稳定、去重的 snapshot。若 transport 失败并 retry，继续使用同一份
snapshot；普通运行期不得向该 snapshot 累计历史 closed socket。

## 5. 修复方案

移除 accept 与 subscribe 阶段对 `transportSockets` 的累计。首次执行 transport teardown
时，合并当前 `sockets` 和 `subscriptions` 中仍 live 的 socket，构造去重 snapshot 并保存到
`transportSockets`。后续 transport retry 复用该 snapshot，以维持同一 teardown 轮次的
union 与 per-socket `write`/`end` at-most-once 语义；在正常运行期，close socket 不应进入或
遗留在该集合。

## 6. 验证方案

1. 建立真实连接后关闭，且 Root 尚未 teardown 时，断言 `sockets.size === 0` 且
   `transportSockets.size === 0`。
2. 建立 live 普通 socket 与订阅 socket 后进入 teardown，断言 snapshot 是两者稳定去重的
   union。
3. 让 transport teardown 首次失败并 retry，断言 retry 仍使用首次建立的 union，且每个
   socket 的 closing `write` 与 `end` 最多各执行一次。
