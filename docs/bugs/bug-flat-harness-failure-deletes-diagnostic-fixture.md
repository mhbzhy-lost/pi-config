# 双 Plan Harness 失败路径删除诊断 fixture

## 1. 现象

双Plan真实Harness失败后，错误中能看到`pi-plan-flat-runtime-<id>`路径，但`finally`无条件递归删除该目录；随后无法读取Executor status、session、official terminal或Root diagnostics。amendment Harness已具备失败保留与补偿清理，双Plan Harness仍使用旧finally。

## 2. 影响

真实门禁失败无法做可重复根因分析，只能依赖被截断的异常字符串。若Root close失败，旧finally也不能枚举并身份安全地清理async runs，存在残留风险。

## 3. 时间线

- Attention barrier超时并抛出带状态的错误。
- `finally`调用`rpc.close()`。
- 未检查主体是否成功，也未执行runtimeTmp补偿清理和残留进程检查。
- `PLAN_HARNESS_PRESERVE`未设置时直接`rm(root,{recursive:true})`。
- 现场立即消失。

## 4. 根因

Task 65的失败清理加固只接入新amendment Harness；作为对照的双Plan flat Harness没有迁移到同一test support lifecycle。

## 5. 触发条件

双Plan Harness任一主体断言失败且未显式设置`PLAN_HARNESS_PRESERVE=1`；或Root graceful close失败。

## 6. 修复与验证

双Plan Harness复用已测试的`terminateDetachedRunsUnder`、`processesReferencing`、`finalizeHarnessCleanup`和`removeFixtureWithEvidence`。`rootSessionId`提升到finally可见；主体全部通过后才置`passed=true`。finally依次关闭Root、身份安全清理runtimeTmp、检查唯一fixture路径无进程、删除broker socket，只有全成功才归档后删除fixture；失败时保留fixture或完整tar并聚合原始/cleanup错误。migration RED锁定接线，helper真实进程测试继续作为行为依据。
