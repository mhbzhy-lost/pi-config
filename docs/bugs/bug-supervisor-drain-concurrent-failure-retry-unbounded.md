# Bug：Supervisor drain 并发失败补偿缺少显式重试上限

## 症状

多个lifecycle调用等待同一个失败drain时，每个waiter都可能在pending仍存在后递归调用`drainSupervisorRequests(ctx)`。代码没有记录该调用是否已经做过一次“等待失败后的补偿重试”。

持续失败且多个hook交叠时，重试次数由调度竞态决定，缺少稳定上限。

## 影响

`agent_settled`或`session_shutdown`可能在持久化/ACK持续失败时执行多轮无间隔重试，延迟typed runtime关闭。即使当前常见调度最终会抛出，也无法从代码契约证明不会形成长链或饥饿。

## 复现

1. live push立即启动drain A，并让recorder持续失败。
2. A pending期间并发触发`agent_settled`与`session_shutdown`，两者都等待A。
3. A失败后，两个waiter都进入递归补偿；其中一个新建B，另一个又等待B。
4. B失败后，后者仍可再次递归，重试次数超过“一次single-flight补偿”。

## 根因

失败补偿通过调用同一个公开drain函数实现，但没有携带retry budget。递归分支无法区分首次等待失败和已经等待过补偿失败。

single-flight限制了同一时刻只有一个pass，却没有限制一个lifecycle调用跨pass重试多少次。

## 修复

为每次drain调用携带布尔retry budget。等待existing pass失败时，只有尚未消费budget的调用可再发起一次补偿pass；该补偿若又遇到并发pass或自身失败，直接把错误交回hook，不再递归。

owner pass持续失败始终只执行一次；多个waiter共享最多一个补偿single-flight，其他waiter观察其失败后退出。pending item继续保留给未来独立hook或official-proof replay。

## 验证

RED让live immediate pass持续失败，同时并发`agent_settled`和`session_shutdown`。所有promise必须有界reject，recorder总尝试次数不得超过2：初始pass一次、共享补偿pass一次。

现有“第一次失败、shutdown第二次成功”仍须GREEN，证明上限没有删除必要补偿。
