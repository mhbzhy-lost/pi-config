# Goal Engine 将结果集成到错误 origin 分支

## 现象
任务已 started 后，用户切换 origin 的当前分支，Goal Engine 仍可能把 executor 提交集成到新分支。

## 影响
正确任务成果会改写未授权的目标分支，导致分支历史和发布内容错误。

## 稳定复现
在 `main` 分配并提交 executor 成果；创建并切换到 `other`；调用集成。调用前后比较两个分支 HEAD、状态和 sequencer。

## 根因
lease 和 disposition started 只持久化提交身份，未绑定 origin 的完整 symbolic ref。

## 本次处置
在分配时持久化 `symbolic-ref --quiet HEAD`，在事件和恢复路径中传递它，并在所有 Git 副作用前核验 ref、HEAD 与干净状态。

## 防复发
真实 Git 测试断言切 ref 时零副作用拒绝；切回持久化 ref 后才允许幂等完成。
