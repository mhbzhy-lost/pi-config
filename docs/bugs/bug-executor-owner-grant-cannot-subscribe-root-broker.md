# Bug: Executor ownership grant 无法订阅 Root broker

## 症状
Broker成功spawn Executor并写入role=`executor`的grant后，Executor使用该grant的`runId/callerToken/rootSessionId`发送`subscribe`请求，broker返回`caller_unauthorized`。

## 影响
`root-session-owner.ts`无法为Executor建立Root ownership订阅。Root正常关闭或异常退出时，Executor收不到`root.closing`或socket EOF，Task 3的共同ownership guard和最终无orphan合同均无法成立。

## 复现
启动broker并grant一个Plan Runner，执行一次spawn，读取`readBrokerGrant(rootSessionId, "executor-run-1")`得到合法Executor token。用`callerRunId="executor-run-1"`和该token通过真实Unix socket调用`subscribe`，response为`success:false/error.code:"caller_unauthorized"`。

## 根因
Broker只维护Plan Runner `callers` map，并在所有method认证时查询该map。Executor grant只写到磁盘并记录`runOwners`，没有进入任何可认证principal集合；实现把“可以spawn/control的caller权限”和“可以订阅Root生命周期的run身份”错误合并。

## 修复
拆分认证principal与Plan Runner caller权限：Plan Runner principal保留ping/spawn/control/subscribe；spawn成功后为Executor记录role=`executor` principal及独立token，Executor principal只允许subscribe，其他method全部fail closed。grant写失败时不得记录principal，cleanup保持原协议。

## 验证
新增真实socket RED/GREEN测试：Executor使用自身grant可subscribe并在close收到只属于该run的`root.closing`；Executor调用ping/spawn/control被拒绝；伪造token、其他run和grant写失败仍拒绝。运行Task 2聚焦、协议/dispatch回归和`git diff --check`。
