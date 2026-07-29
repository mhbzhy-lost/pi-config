# Bug: 全局 Executor owner extension 阻断普通直接派发

## 症状
`pi/agents/executor.md`为所有Executor run加载`root-session-owner.ts`。该extension要求5秒内出现Root broker grant，否则session_start失败。当前broker只在Plan broker的`spawn()`路径写Executor grant；Main Agent通过Root本地typed adapter直接调用上游runtime，不经过broker，因此普通Executor没有grant。

## 影响
修正extension路径后，所有非Plan的普通Executor都会在模型运行前因`GRANT_NOT_READY`超时失败，包括用于继续实现本计划的coding subagent。Task 3若直接全局启用guard，会破坏现有Main -> Executor工作流。

## 复现
Root broker的grant写入调用方只有`grantCaller()`和broker `spawn()`。Main typed `subagent`工具在`createTypedSubagentExtension`中直接调用Root本地RPC client，不调用broker。普通Executor仍携带标准run/root env并加载owner extension，但对应`brokerGrantPath(rootSessionId, runId)`不存在，owner只重试`GRANT_NOT_READY`并在5秒后抛错。

## 根因
Task 3把owner extension挂到共享Executor profile，却把grant生产者建模成Plan broker spawn的局部副作用，没有覆盖同一Root runtime创建的直接一级Executor。extension消费面是全局的，grant生产面却是Plan专用的。

## 修复
Root broker监听Root runtime的canonical`subagent:async-started`事件，为同Root创建的Executor/Spark一级run幂等写入subscribe-only owner principal/grant；Plan broker spawn复用同一ensure操作，再补逻辑caller ownership。Root close取消listener并删除grant。通用grant不得赋予spawn/control/supervisor权限。完成前暂时移除Executor profile的owner extension单行，恢复实现子任务自举；完整修复后重新启用并用真实直接Executor probe验证。

## 验证
测试覆盖Root async-started为直接Executor创建0600 grant、owner subscribe成功、非subscribe方法拒绝；Plan spawn与async-started乱序时token/grant幂等且run owner正确；Root close取消listener。真实Main direct Executor可进入session，Plan Executor仍加载guard且Root EOF终止。
