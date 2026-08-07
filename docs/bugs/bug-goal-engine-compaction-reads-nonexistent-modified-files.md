# Bug：Goal Engine 读取不存在的 compaction modifiedFiles

## 现象
真实 Pi `session_before_compact` 传入 `fileOps.read/written/edited` 三个 Set，Extension 却读取不存在的 `modifiedFiles`，导致 checkpoint 丢失实际写入和编辑文件。

## 影响
恢复提示和连续性 checkpoint 无法准确标识已修改文件，可能错误放行后续变更。

## 稳定复现
以官方 `FileOperations={read:Set,written:Set,edited:Set}` 调用 hook；原实现记录空 `modifiedFiles`。

## 根因
Extension 使用了旧 fixture 虚构的 `modifiedFiles` 字段，而非 Pi 当前公开类型。

## 促成因素
测试没有采用官方 FileOperations shape，也没有验证 read-only 文件不会被标为修改。

## 修复与验证策略
从 written 与 edited Set 求并集并排序；read 仅用于上下文。以真实 shape 的 hook/reload 测试验证 checkpoint。
