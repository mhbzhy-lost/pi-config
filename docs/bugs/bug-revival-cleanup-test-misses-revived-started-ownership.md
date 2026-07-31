# Revival cleanup 测试遗漏 revived ownership 导致无限挂起

## 1. 现象

`node --test test/root-broker-revival-cleanup.test.mjs`超过5分钟无TAP输出且不退出。测试解除`upstream.resume`后等待`server.revivePromises`和`closeRootSession()`，但两者都不能完成；全量`npm test`因此永久停在该文件。

## 2. 影响

累计门禁无法给出PASS/FAIL summary，其他已完成测试被整体阻塞。使用`--test-force-exit`会掩盖真实startup/ownership barrier，不能作为验收手段。

## 3. 时间线

- 测试为早期revival cleanup RED提交于`78691be`。
- 后续生产合同增加exact revived started ownership：resume结果只创建pending handoff，grant前必须观察匹配`runId + asyncDir + role + lifecycleSessionId`。
- fixture仍只调用`resolveResume(resumed)`，没有发布revived `async-started`。
- `performCallerRevive()`永久等待ownership；`closeRootSession()`startup barrier也等待同一promise。
- 测试`t.after`先等待`revivePromises`，因此连5秒close deadline失败都无法完成清理。

## 4. 根因

测试fixture停留在“resume返回即完成revival”的旧oracle，遗漏当前两阶段handoff的started ownership事实，也没有为revived run提供official terminal proof。生产close barrier按设计fail closed；无限挂起来自测试清理反向等待缺失前提。

## 5. 触发条件

存在in-flight caller revival，`resume`返回合法`revivedRunId/asyncDir`，同时fixture不调用`observeStarted()`或不通过事件总线发布exact started facts，然后调用`closeRootSession()`并等待revival。

## 6. 修复与验证

仅修正测试fixture：为server注入确定性birth identity与短`terminalTimeoutMs`；resume返回后等待pending handoff可见，发布exact plan-runner `async-started`，再为该revived run提交official observed terminal proof。close仍必须在resume/ownership前保持pending，且只有revival barrier与official proof都完成后才dispose upstream。`t.after`使用同一幂等fixture完成函数并带有界等待，任何未来oracle漂移都应快速FAIL而不是挂起。生产`RootBrokerServer`不改。
