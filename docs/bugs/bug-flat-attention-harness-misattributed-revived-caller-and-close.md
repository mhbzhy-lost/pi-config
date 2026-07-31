# Flat Attention Harness 误归属 revived caller 并掩盖异常关闭

## 1. 现象

A2 Harness已能验证四个Attention的durable reply/ack/resolved和Executor contact-before-bash，但冻结前独立审查发现两处可产生假GREEN：

1. Harness用`attempt.attention-requested.occurredAt`倒查`grant.issued`，再把结果称为处理reply的`actualCallerRunId`；request owner和reply consumer可能是不同Plan Runner generation。
2. `RootRpc.close()`在8秒超时后发送`SIGKILL`，却不检查最终`code/signal`并正常返回；Root broker drain或transport close回归仍可让Harness通过。

此外，当前Harness没有在自身断言中闭合所有actual run的official terminal、PID death、Root `close.started -> close.completed`和broker socket删除，这些证据只能事后人工补齐。

## 2. 真实证据与反证

Root Broker每次revival都持久化带`logicalCallerRunId/activeRunId/generation/observedAt`的`grant.issued`。Attention request事件记录请求被持久化的时间；durable ack的`deliveredAt`只在对应actual caller成功调用Supervisor reply、写入`attempt.attention-resolved`后生成。

因此request时间只能映射request owner；reply consumer必须按ack时间取同logical caller当时最新grant。若没有更早grant，initial logical run本身就是actual run。

`RootRpc.close()`当前超时分支明确调用`child.kill("SIGKILL")`，随后丢弃`this.exited`结果。Node test只看到Promise fulfilled，不能反证graceful shutdown成功。

## 3. 根因

Harness把stable logical ownership、request delivery generation和reply delivery generation压成一个字段，选择了过早的request时间。关闭helper又同时承担cleanup fallback和成功判定，却没有把fallback signal升级为测试失败。

取证顺序也晚于领域断言但早于Root graceful close，导致actual run集合可能尚未收敛，无法在Harness内完整证明terminal与socket cleanup。

## 4. 正确修复

这是tests-only Harness oracle纠错，不修改production：

1. 分别按requested事件时间和ack `deliveredAt`映射`requestActualCallerRunId`与`actualCallerRunId`；每次映射使用同logical caller最新的`grant.issued`，否则只允许initial logical run。
2. 在该Plan的唯一canonical Runner transcript中精确找到一次`plan_executor_supervisor` reply call及其成功tool result，交叉验证requestId、executorRunId和message。
3. 验证每个Root `attention-reply-<requestId>` followup被登记，并验证对应request/reply actual runs均属于正确Plan worktree。
4. `RootRpc.close()`只接受exact `{code:0, signal:null}`；超时SIGKILL必须等待exit后抛错，不能成为成功路径。
5. 在主断言完成后显式graceful close，再枚举actual dirs；逐run验证official observed proof、runner exit 0/signal null和`process.kill(pid, 0)`返回`ESRCH`。
6. 验证Root diagnostics的`close.started`严格先于唯一`close.completed`，并验证`brokerSocketPath(rootSessionId)`为`ENOENT`。

## 5. TDD 验证

该修复只改变真实Harness oracle，且每个冻结基线只允许一次真实执行，因此不为测试代码消耗A2 run来制造RED。RED依据是当前源码的确定性反例：`requestedAt < revived grant <= ack.deliveredAt`时旧算法必回退initial；close超时分支在`signal=SIGKILL`时仍fulfilled。

修正后先执行：

- `node --check test/plan-flat-runtime-harness.integration.mjs`；
- provider、Launcher、Broker、dependencies focused suites；
- 静态确认无requested时间冒充reply consumer、无SIGKILL成功分支。

只有冻结HEAD/index/porcelain/Harness/provider/installer哈希后，才执行一次真实persisted A2 Harness。

## 6. 影响边界

只修改`test/plan-flat-runtime-harness.integration.mjs`及本缺陷文档。不改变Root Broker、Plan Runner、provider或协议。若不修，revived reply可被误归属initial caller，Root abnormal shutdown也可被报告为GREEN；在唯一基线后暴露代价高。修正若过度锁定generation数量会造成竞态假RED，因此仍只要求initial handles存在、actual caller由durable时间证据导出，总代数不设上限。
