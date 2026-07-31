# Bug：Supervisor Attention replay 只检查可覆盖 projection 槽位

## 症状

exact replay当前只检查`attempt.attention`和`attempt.lastProgress`。后续blocking Attention会覆盖前一条resolved attention，后续progress update也会覆盖`lastProgress`，但`attentionRequestIds`仍永久保留旧requestId。

旧请求在Plan持久化成功、Broker ACK失败后跨generation重放时，找不到当前槽位并被误判为冲突。

## 影响

完全相同的runId、requestId、kind和message会永久无法ACK。Broker在每次Plan Runner official proof后继续重排并revive，Executor和Plan无法收敛，形成无界恢复循环。

## 复现

1. 持久化request A但让其Broker ACK失败。
2. 同一Attempt继续处理后续Attention或progress B，覆盖projection当前槽位。
3. generation退出，Broker基于未ACK A执行proof-driven replay。
4. dependency只查当前槽位，随后看到`attentionRequestIds.has(A)`并抛conflict。

## 根因

projection的attention/lastProgress是面向当前状态的可覆盖视图，不是request identity ledger。代码把“当前视图不再展示A”误当成“A的payload不可验证”。

immutable Plan event stream仍保留A的完整`attempt.attention-requested`数据，但幂等分支没有使用该权威历史。

## 修复

exact replay先查当前槽位；找不到时，从当前session branch的immutable `attempt.attention-requested`事件按requestId恢复原runId、kind、message hash、attemptId、projectionVersion和evidence。只有全部一致才幂等；任何字段冲突继续fail closed。

若事件表明请求事务已被后续事件推进或当前槽位已覆盖，只重算derived status并ACK，不回写旧事件。不得把`attentionRequestIds`单独当成足够身份。

## 验证

RED先持久化A，再追加能覆盖当前槽位的B，然后用fresh dependency重放A；必须零新增request事件并成功返回A身份。改变A的content或kind仍拒绝。测试同时覆盖blocking槽位和progress槽位至少一种真实覆盖路径。
