# stream recovery runtime patch 重复写入 ordered-models marker

## 现象

当 pinned runner 源文件已经包含 `ordered-models.v3` marker，但没有 `stream-read-error-recovery.v1` marker 时，重新应用 runtime patch 会生成两个 `ordered-models.v3` marker。

## 根因

`streamRecovery()` 已能识别“已有 stream marker 且缺通用 marker”的状态，并为该状态补写通用 marker。但缺少 stream marker 的注入分支使用包含 `${MARKER}` 的 helper；当源文件原本已有通用 marker 时，helper 又会追加一个相同 marker。

因此 patch 虽然能安装 recovery 逻辑，且重复执行结果稳定，但没有满足 marker 唯一性这一幂等约束。

## 证据

新增回归断言先失败：已有 ordered-models marker 的 runner fixture 经 patch 后包含 2 个 `ordered-models.v3` marker，而预期为 1 个。

## 修复

将 helper 的通用 marker 注入改为按源文件状态决定：源文件已经有 `MARKER` 时，helper 只注入 stream marker；源文件没有 `MARKER` 时才同时注入两个 marker。保持 recovery 行为不变。
