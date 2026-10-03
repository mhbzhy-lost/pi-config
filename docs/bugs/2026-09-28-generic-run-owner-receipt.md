# Generic run owner receipt missing

## 现象

真实 public generic spawn 成功创建 child，但随后 parent 的 steer/control intent 返回 `SUPERVISOR_INTENT_INVALID`。控制面通过 `RootBrokerServer.readOwnerReceipt(runId)` 解析 run 身份；generic run 没有 owner receipt，因此身份字段缺失。

## 数据来源与首个偏离点

数据来源是探针 Host 的真实 public `subagent` generic spawn（`var/upgrade/trace/t11b1-steer/run-fb/events.jsonl`，记录 `subagent:async-started` 的 `runId`、`asyncDir`、`sessionId`、`pid` 与 `agent`），不是手工拼接 projection/event。

首个偏离点为 `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts:385-388`（`registerAuthorizedRun`）：generic authorization 的 capability 集合为空，代码调用 `registerFacadeRun(...)` 后直接 return，跳过了 process-birth 捕获、durable owner receipt 与 `ownedRuns` 注册。随后 `supervisor-control-plane.ts:108-110` 的 `identityForRun` 只能调用 `readOwnerReceipt`，得到 `unknown_run`，extension 翻译层无法生成合法 `supervisor-control-intent.v1`，最终报告 `SUPERVISOR_INTENT_INVALID`。

完整调用链：public `subagent` generic spawn → `extension.ts` 构造 `genericRunAuthorization`（capabilities=[]）→ `extensions/subagent-runtime.ts` 的 `registerAuthorizedRun` → `RootBrokerServer.registerAuthorizedRun` → empty-capability facade early return → `identityForRun` / `readOwnerReceipt` → steer intent parse failure。

## 静态测试为何未拦截

已有 broker 测试覆盖了有 `root.subscribe` capability 的 coding run owner receipt，以及 facade terminal proof 的非授权语义；没有覆盖“generic 空 capability 仍须有身份 receipt、但不得创建 broker principal/grant”的组合。因而 capability 安全测试全绿，同时缺陷仍可回归。

## 预期修复

为 generic run 捕获 process birth 并写入 durable owner receipt，作为 run↔owner 身份绑定；不向 generic run 增加任何 broker capability、principal、grant 或 `root.subscribe`。控制 intent 仍额外校验 owner generation 与 runtime 状态。

## R7 修正诊断（production 证据）

推翻 epoch=0 假设：`var/upgrade/trace/t11b1-steer/run-r7b/launcher.log` 实测 owner/runtime reader 均报 `unknown_run`，`identityForRun` 实际值 `{owner:undefined,runtime:undefined}`（JSON 日志为 `{}`），构造 intent 缺 `rootSessionId`/`ownerGeneration`。没有任何 epoch=0 证据。

R5 writer 修复只覆盖 broker 方法本身。首个遗漏是 `extension.ts:executeGeneric` 的 onBinding 用 `if (workspace)` 包住 `registerAuthorizedRun`，shared generic 没有 workspace，根本不调用 writer。完整链为 public generic shared spawn → authoritative async-started collector → onBinding workspace gate → 未登记 authority → owner.read unknown_run → intent parse INVALID。该路径来自合法 public tool 与真实 child 资源顺序，属于生产缺陷。

触达 writer 的试验记录 `var/upgrade/trace/t11b1-steer/run-r7e/events.jsonl` 又揭示第二偏离：`Run authorization session does not match Root broker`。upstream async-started.sessionId 是实际 parent sessionFile 路径；runtime 初始化 broker.lifecycleSessionId 却使用 `resolveCurrentSessionId`（UUID）。owner rootSessionId 保持 UUID，lifecycle identity 必须与 upstream persistence identity（sessionFile，no-session 则 UUID）一致。

TDD：shared generic registration test 在生产回滚后先以 `registered[0] === undefined` RED，随后 GREEN；lifecycle identity integration test 在修复前观察到 broker lifecycle UUID ≠ `getSessionFile`，修复后 10 tests pass。

## R7 修正诊断（production 证据）

推翻 epoch=0 假设：`var/upgrade/trace/t11b1-steer/run-r7b/launcher.log` 实测 owner/runtime reader 均报 `unknown_run`，`identityForRun` 实际值 `{owner:undefined,runtime:undefined}`（JSON 日志为 `{}`），构造 intent 缺 `rootSessionId`/`ownerGeneration`，没有任何 epoch=0 证据。

R5 writer 修复只覆盖到 broker 方法本身。首个遗漏是 `extension.ts:executeGeneric` 的 onBinding 用 `if (workspace)` 包住 `registerAuthorizedRun`，shared generic 没有 workspace，根本不调用 writer。完整链为 public generic shared spawn → authoritative async-started collector → onBinding workspace gate → 未登记 authority → owner.read unknown_run → intent parse INVALID。该路径来自合法 public tool 与真实 child 资源顺序，属于生产缺陷。

撤回试验代码后按 TDD 重做 shared generic 登记。触达 writer 的试验记录 `run-r7e/events.jsonl:7` 又揭示第二偏离：`Run authorization session does not match Root broker`。upstream async-started.sessionId 是实际 parent sessionFile 路径；broker runtime 初始化却用 `resolveCurrentSessionId`（UUID）作 lifecycleSessionId。owner rootSessionId 应保持 UUID，lifecycle identity 必须与 upstream persistence identity (sessionFile，no-session 则 UUID) 一致，不能篡改 observed binding 来绕过校验。

测试计划：A) shared generic 通过真实 extension collector 登记 empty-capability authority并在登记完成后返回；B) fresh real Pi Host broker lifecycle identity 等于 sessionFile，rootSessionId 仍 UUID。先观察正确 RED 再最小 GREEN；诊断插桩为主管批准的 env-gated 观测，TDD 豁免理由：不改变控制语义，实跑日志验证。
