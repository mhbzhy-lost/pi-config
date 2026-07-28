# Bug：无活动 Child 时 Footer 仍展示 history 桶

## 1. 现象

所有 child 完成后，main Footer 仍持续显示 `history N`。

## 2. 影响

已完成运行本应保留以供 Alt+O 浏览，但空闲主界面被无当前操作价值的计数占据，压缩了模型和活动任务信息。

## 3. 稳定复现

1. 启动并完成一个或多个 child run。
2. 返回 main mode。
3. Footer 仍显示 `◯ history N`，即使 `activeChildren` 为空。

## 4. 证据

`formatBrowserSelector()` 只要 `recentChildren` 产生 `historyCount > 0`，就在 main mode 无条件追加 history item；它没有检查 `activeChildren`。

## 5. 根因

历史保留与主 Footer 可见性共用了同一条件，导致持久 roster 被误当作当前活动状态。

## 6. 修复与验证策略

仅在 main mode 仍有活动 child 时显示折叠 history count；保持 roster、Alt+O 进入和历史浏览逻辑不变。测试验证空闲隐藏、活动时显示和 retained run 可进入。
