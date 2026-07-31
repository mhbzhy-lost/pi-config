# Bug：Supervisor close fence 抢跑 late-start observation

## 症状

Supervisor owner 竞态GREEN加入 post-grant close fence 后，隔离运行完整 `root-subagent-broker.test.mjs` 为 135/138。除临时worktree缺少 `jiti` 的环境失败外，两项 late-start fence 用例都得到 `durable spawn reply is valid: false !== true`。

这两个场景在 Root close 已开始后才释放上游 spawn；`subagent:async-started` 已把 Executor 登记到 `ownedRuns`，但进程出生身份捕获仍被deferred barrier阻塞。新实现看到 `closed` 后立即进入 spawn cleanup，提前调用 `upstream.stop` 并返回失败。

## 影响

Root shutdown 不再等待已登记 started observation 的身份捕获，破坏“先完成startup barrier，再按Executor terminal proof drain”的既有合同。真实进程可能在身份尚未确认时被直接停止，关闭审计也失去统一的owned-run收敛路径。

若为修复该回归而恢复 owner commit 或pending promotion，又会重新违反本次竞态修复的核心约束：close开始后不得写入 `runOwners`、不得投递Supervisor request、不得触发revival。

## 复现

1. 以隔离 `rootSessionId` 应用当前GREEN，并串行运行完整 `test/root-subagent-broker.test.mjs`。
2. `Root late-start fence waits for an observation registered by the startup barrier` 失败，spawn reply为失败。
3. `Root late-start fence keeps one fixed startup deadline across barrier waves` 同样失败。
4. 两项用例都先调用 `closeRootSession()`，随后释放spawn；upstream在返回binding前同步发出 `subagent:async-started`，因此 `ownedRuns` 已有该Executor，`startedObservations`仍在等待birth capture。

## 根因

`spawnLegacy()` 把所有 post-close spawn/grant完成统一视为未受Root管理：在 `await ensureExecutorOwner(runId)` 后只要 `closed` 就抛错，catch立即stop并返回 `spawn_cleanup`。

这个判断遗漏了Root已经从可信lifecycle session接收并登记 `OwnedRun` 的情况。此时进程不是未知副作用；`closeRootSession()` 的startup barrier与ordered drain正是它的权威owner。直接cleanup绕过了该状态机。

## 修复

在任何owner commit之前增加精确分支：若close已开始且 `ownedRuns` 中存在同runId、role为Executor的可信started observation，则不调用或不继续Executor grant、不写 `caller.ownedRunIds`、不写 `runOwners`、不promotion pending、不重放lifecycle push；保持spawn调用成功结算，让close startup barrier等待身份捕获并由既有ordered drain停止该owned run。

若close已开始但没有可信owned Executor，则继续现有fail-closed cleanup：停止上游返回的run并返回受控spawn失败。这样保留新close RED的零owner、零Supervisor delivery与stop证明，同时恢复late-start barrier合同。

## 验证

先运行两项late-start fence与in-flight close定向用例，确认前者恢复成功binding和barrier后drain，后者仍为零owner、零Supervisor request并直接cleanup。随后在隔离rootSessionId下运行完整Root Broker文件；临时worktree需提供项目pinned `jiti`，否则将其明确归类为环境失败而非代码回归。

真实A2 Harness仍不得在本修复阶段运行；只有生产提交、完整focused门禁和新冻结HEAD完成后才允许该新基线唯一执行一次。
