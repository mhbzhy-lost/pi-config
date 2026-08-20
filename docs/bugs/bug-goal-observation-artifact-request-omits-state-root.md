# Goal Observation artifact 请求遗漏 stateRoot

## 1. 预期行为

Runtime Observation 到达 terminal 后，Extension 应将 Host 已派生的 Goal stateRoot 连同 goalId、runId 和 managed terminal 传给 production Host 的 `artifactRefForRun`。

## 2. 实际行为

`activeObservationStep()` 调用 `artifactRefForRun` 时遗漏 `stateRoot`。production Host 严格拒绝不完整请求，真实 managed PASS Observation 因而无法记录 artifact，Goal 停留在 terminal 并返回 managed attention。

## 3. 稳定复现

使用真实 Pi SDK、production Host 和 `/bin/echo '{"code":"PASS"}'` validation plan 创建 runtime Condition。Cycle0 managed validation 已产生 terminal 后，下一次 `goal_status` 返回 `RUNTIME_CALIBRATION_MANAGED_ATTENTION`，而不是记录并 release Observation。

## 4. 根因

Extension 已在 `activeObservationStep` 的闭包中持有经 state scope 解析的 `root`，但构造 artifact Host 请求时没有传递该 Host-derived 值；production Host 的精确请求边界因此拒绝请求。

## 5. 影响范围

所有使用 production Host 的 runtime Observation（包括 Cycle0 calibration 和 active product cycle）都不能从 managed terminal 进入 recorded/released，无法最终完成。

## 6. 修复与验证

在两处 `artifactRefForRun` 调用中仅加入闭包派生的 `stateRoot: root`，不接受 tool caller 输入。真实 Pi canary 覆盖 PASS、record/release、final review 和 completion；同时回归 obligation runtime、managed validation 与 D 相关测试。
