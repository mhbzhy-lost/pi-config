# Bug：malformed registry 校验前写入事件日志

## 1. 现象

当已有 version 1 的 goal 的 `registry.json` 被破坏后，追加 checkpoint 会在 registry 的 JSON 解析抛出 `SyntaxError` 前写入 `events.jsonl` 和 `projection.json`。reviewer probe 观察到 `eventLines=2`、`replayVersion=2`、`projectionFileVersion=2`、registry 仍 malformed，使用同一 `expectedVersion=1` 重试得到 `PROJECTION_CONFLICT`。

## 2. 触发条件

已存在 goal 的 registry 文件包含不能解析的 JSON，调用方以当前版本追加事件。

## 3. 根因

`appendEvent` 在 writer lock 中先追加 JSONL、发布 projection，最后才由 `updateRegistry` 读取并解析 registry。解析失败时没有回滚，导致持久状态已经前进。

## 4. 影响范围

调用失败却留下不可用的部分提交；修复 registry 后原调用的版本条件已过期，无法安全重试。

## 5. 修复方案

在持有 writer lock 时，在任何事件或 projection 写入前读取、解析、校验并计算 registry 的下一值；将该纯计算与 tmp+rename 发布分离。既有 registry 的 JSON 或结构不合法时闭合失败，不自动重建。

## 6. 验证方案

测试损坏 registry 后断言事件、projection、registry 的字节和版本均不变且无临时锁文件；修复 registry 后以同一 `expectedVersion` 重试，确认仅新增一条事件并使 projection 与 registry 一致。同时保留 registry 发布时的 writer token 边界断言。
