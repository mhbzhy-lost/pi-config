# Bug：Supervisor promotion RED 的大 frame fixture 在占位 owner 阶段即被拒绝

## 症状

新增Supervisor promotion原子性RED使用 `content.length = 65233`，预期unbound阶段以短占位caller通过、owner绑定后以160字符logical caller超出64 KiB。然而focused执行时第二个ingress直接返回 `supervisor_request_invalid`，pending FIFO只有第一项。

因此测试虽然RED，但没有进入 `promoteSupervisorIngress()`，不能证明校验异常是否会造成部分提交。

## 影响

若保留该fixture，后续GREEN可以完全不修改promotion原子性而让测试通过或继续在错误边界失败，形成无效TDD证据。测试也无法观察第一项是否在第二项失败前被提前投递。

该问题只影响tests-only oracle，不改变production根因和修复边界。

## 复现

1. 使用requestId `promotion-large`、executorRunId `promotion-atomic-executor`、rootSessionId `root-broker-test-1`。
2. callerRunId先取短占位 `owner`，content长度取65233。
3. 调用真实 `createSupervisorRequestPush()`；观察短占位frame已经超过上限并抛错。
4. focused测试返回 `supervisor_request_invalid`，queue length为1而非2。

## 根因

最初边界探针使用更短的requestId和executorRunId。Broker frame上限按完整JSON字节数计算，字段名值长度都占预算；把探针结果直接移到更长的测试身份后，额外11字节使unbound frame提前超限。

测试没有先用exact最终字段验证“短caller成功、长caller失败”这一前置条件。

## 修复

用exact测试字段重新计算边界，选择literal `65222`：短占位caller `owner`可通过，合法160字符caller会超限。测试源码只保存该固定literal，不在断言路径调用production helper动态计算期望。

保留route结果和queue length前置断言，确保未来fixture漂移会在promotion前明确失败。

## 验证

静态探针分别验证短caller成功、长caller失败；focused测试应在释放grant后进入promotion，并因 `supervisorPushes/requests/retainedContexts` 的部分提交差异RED，而不是因ingress invalid RED。

与owner contention RED一起运行时Node必须自行退出，production仍保持未修改。
