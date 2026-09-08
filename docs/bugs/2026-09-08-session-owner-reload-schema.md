# Session Owner Reload Schema Regression

## 现象

旧版 `pi-session-owner.v1` 的 active record 没有 `forkSource` 字段。升级后执行 `/reload` 时，新 extension generation 的 registry codec 将该合法旧记录判为无效，`lifecycle.start` 抛错，extension 捕获后调用 `ctx.shutdown`，导致 idle Pi 退出。

## 证据

复现时 stale record 的 PID 为 `31874`，其 session header 与 record identity 匹配；stderr 没有 `extension_error`。问题发生在 owner extension 的启动校验路径，而不是 Pi extension host 的错误上报路径。

## 修复策略

在同一 `v1` protocol 内，仅缺失的新增 `forkSource` 字段归一化为 `null`。其他既有必填字段不放宽，且非空但结构错误的 `forkSource` 继续 fail closed。任一后续 own-record 原子更新会写回含 `forkSource: null` 的规范 shape。

新增同 protocol 字段必须保持旧 record 的 decode 兼容；若以后需要不兼容字段，应先引入显式 protocol version 与迁移策略，不能直接把新增字段设为 decode 必填。
