# Plan Launcher 半迁移导致测试与运行时契约分裂

## 1. 现象

`node --test test/plan-launcher-extension.test.mjs`稳定出现12项失败。代表性失败包括启动等待超时、测试注入的`createRpcClient.spawn`未调用、旧7字段handle断言不匹配，以及失败回滚时报`Unknown workspace lease owner`。

## 2. 影响

当前Launcher测试不能作为Standalone Plan Runner与薄Host的绿色门禁；旧测试也不能证明当前自建Runtime实现正确。该问题不影响Task 2的Plan v1/v2 parser和IR定向测试，但会阻断Task 11迁移及Task 14全量验收。

## 3. 时间线

1. Task 2的parser/IR定向测试28项通过。
2. 额外运行Launcher回归，24项中12项失败。
3. 对照测试与实现，测试通过`createRpcClient`注入官方RPC spawn并期待`asyncDir/sessionFile`。
4. 当前`launchPlan()`忽略该注入点，直接调用`spawnPiAgent`并产生`runDir/pid`格式handle。
5. 测试伪造的workspace没有真实lease文件，启动失败后的真实rollback继续产生二次错误。

## 4. 根因

Launcher处于旧RPC测试契约和自建Runtime实现并存的半迁移状态：测试、handle schema、生命周期监控和回滚所有权没有指向同一个权威后端。Task 2仅修改`plan-document.mjs`与`ir/compile.mjs`，失败栈不经过这两个模块的v2分支。

## 5. 修复边界

按已批准计划留到Task 11统一迁移：薄Host只监管Standalone Plan Runner，Executor由官方`pi-subagents`公开RPC管理；同时冻结v3 Host handle、恢复和终态语义。Task 13再删除通用自建Executor Runtime。禁止为让旧测试变绿而恢复双后端或给`spawnPiAgent`增加长期fallback。

## 6. 验证与防复发

Task 11必须让`test/plan-host-runtime.test.mjs`、`test/plan-launcher-extension.test.mjs`和`test/parent-lifecycle.test.mjs`统一通过；Task 12运行真实故障矩阵，Task 14运行全量测试和Doctor。Task 11开始前以本记录的`12/24 passed`作为红色基线，并逐项确认失败迁移而非删除断言。
