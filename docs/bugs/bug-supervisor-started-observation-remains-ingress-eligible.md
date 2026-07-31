# Bug：Supervisor started observation 在关闭或 grant 失败后仍可继续入队

## 症状

Supervisor pending GREEN允许 `principals.role === executor` 或 `ownedRuns.role === executor` 证明未绑定run。`observeStarted()`在grant前先写入ownedRuns；grant失败后只删除principal和当时已有pending，ownedRuns仍使迟到request被重新接受，但已没有owner promotion路径。

同时，close已开始时startup barrier会等待started observation；`observeStarted()`在 `await ensureExecutorOwner()` 后仍无条件调用 `lifecycle(execution.started)`，而 `deliverOrQueuePush()`没有close fence，因此等待期间仍可能新增lifecycle push或caller queue并触发revival检查。

## 影响

grant失败后的迟到Supervisor request会长期占用context、requestId和global capacity，直到Root close。close期间新增lifecycle queue则违反停止新派发和零push约束，还可能在teardown前制造新的wake debt。

删除ownedRuns不是可接受修复，因为Root仍需用它等待official terminal proof并drain真实started进程；必须分离“生命周期owner”与“允许Supervisor ingress”的资格。

## 复现

1. 发出可信 `subagent:async-started`，让birth capture完成后Executor grant受控失败。
2. grant失败清理完成后发送一个新Supervisor request；当前实现仍因ownedRuns接受并写入pending。
3. 另一场景在started observation等待deferred grant时调用close，随后释放grant。
4. 观察close开始后仍产生 `execution.started` push或caller queue mutation。

## 根因

实现把ownedRuns的生命周期所有权等同于Supervisor路由资格。前者在grant失败后必须保留用于shutdown，后者应在grant失败时撤销并仅在成功重试时恢复。

`observeStarted()`与 `deliverOrQueuePush()`沿用正常运行路径，没有在异步grant返回后重新检查closed；startup barrier只等待promise，不自动阻止其后续副作用。

## 修复

为Executor维护显式Supervisor ingress资格：可信started observation初始可暂存；grant失败或spawn cleanup撤销资格并释放pending/reservation/context；合法grant重试开始或成功时恢复。route known判断必须同时满足owned Executor与未撤销资格，不能只看ownedRuns role。

`observeStarted()`在grant返回后若closed必须跳过 `lifecycle()`；`deliverOrQueuePush()`或其调用点也要有close fence，确保关闭开始后不新增普通push、caller queue或revival debt。`root.closing`仍由shutdown transport专用路径发送，不受普通push fence影响。

## 验证

新增真实event bus RED：grant失败后迟到Supervisor request返回unknown且零pending/reservation；成功重试后可重新接受。新增close RED统计 `execution.started/completed` 与 `supervisor.request` 均为零、callerPushQueues不增长，同时exact一个 `root.closing`仍送达。

随后运行完整Root Broker、revival/subscription和ordered drain门禁；真实Harness仍等待全部GREEN与新冻结HEAD。
