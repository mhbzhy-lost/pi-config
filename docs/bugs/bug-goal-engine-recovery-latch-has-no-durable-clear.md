# Bug：Goal Engine recovery latch 没有持久 cleared tombstone

## 现象
latch 仅保存在模块变量和 active custom entry；成功 checkpoint 后直接置空，reload 无法区分从未阻塞与已恢复。

## 影响
重载后可能错误继续阻塞或错误放行 mutation，恢复决策不可审计。

## 稳定复现
写入 active latch、重建 Extension 并调用 session_start；原实现不能按最后 receipt 恢复明确状态，也不写 cleared receipt。

## 根因
session custom entries 只记录 active，未建立 append-only active/cleared receipt 协议。

## 促成因素
恢复状态以 module Map/变量表达，测试未创建新 Extension instance 验证。

## 修复与验证策略
session_start 按最后 latch receipt 的 `state` 读取 active/cleared；只有成功 goal_status 完整 replay 和权威 action 计算后追加 cleared tombstone；其他读取与失败不得清除，尤其 compaction checkpoint 不得清除。

## TDD 证据
GREEN：lifecycle ambiguity 测试确认 successful compaction 在 active latch 后返回 cancel，且最后 receipt 仍为 `state:"active"`；real-host checkpoint reload 改为销毁旧 manager 后以 `SessionManager.open(sessionFile, sessionDir, projectCwd)` 重建。
